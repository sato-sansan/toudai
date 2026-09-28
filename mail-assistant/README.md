# 📧 AIメール返信下書きアシスタント

`sato@sanrikutech.jp` に届くメールのうち返信が必要なものを判定し、過去のやり取りを参考に
返信文を作って **Gmail の下書きとして保存する** 仕組み。

読み取り・判定・起草は **Claude Code 自身**が Gmail コネクタ経由で行う。
このディレクトリの Python は、稼働条件・機械判定・重複排除・履歴といった
「決定的に決まること」と、**Gmail 操作を実行直前に検査するガード**を担う。

> ## ⚠️ 送信はハーネスが遮断しています
>
> Gmail コネクタには `send_message`（下書き ID を渡すと即送信）・`reply`・`forward`・
> `trash_*` などの**送信・削除ツールが存在します**。コネクタ自体には「下書きは作れるが
> 送信はできない」という制限がありません。
>
> そこで、送信しないことを**モデルの指示遵守に頼らず、Claude Code のハーネスで強制**しています。
>
> | 層 | 仕組み | 実機での確認 |
> |---|---|---|
> | 1 | `.claude/settings.json` の `permissions.deny` | 送信系が「権限ルールにより拒否」と表示された |
> | 2 | PreToolUse フック（`.claude/hooks/gmail_guard.py`）が**すべての MCP 呼び出し**を検査 | 本物の Gmail 呼び出しがフックを通り監査ログに記録された |
> | 3 | 手順書（`.claude/skills/mail-assistant/SKILL.md`） | — |
>
> 送信系の拒否は設定ファイルもマニフェストも読まない（状態を持たない）ため、
> それらを書き換えられても送信は開きません。詳細は [§13 脅威モデル](#13-脅威モデル)。

---

## 目次

1. [構成](#1-構成)
2. [処理の流れ](#2-処理の流れ)
3. [ガード（フック）](#3-ガードフック)
4. [判断ロジック](#4-判断ロジック)
5. [返信文の作成ルール](#5-返信文の作成ルール)
6. [ファイル構成](#6-ファイル構成)
7. [設定項目](#7-設定項目)
8. [セットアップと定期実行](#8-セットアップと定期実行)
9. [開発・テスト](#9-開発テスト)
10. [ロールバック](#10-ロールバック)
11. [運用開始前チェックリスト](#11-運用開始前チェックリスト)
12. [段階的な立ち上げ（Phase 1〜3）](#12-段階的な立ち上げphase-13)
13. [脅威モデル](#13-脅威モデル)
14. [Gmail コネクタの制約（実データで確認済み）](#14-gmail-コネクタの制約実データで確認済み)
15. [想定費用](#15-想定費用)
16. [トラブルシューティング](#16-トラブルシューティング)

---

## 1. 構成

| 要素 | 採用 |
|------|------|
| メールの読み取り | Claude Code の **Gmail コネクタ**（`search_threads` / `get_thread` / `list_drafts`） |
| 返信要否の判定・起草 | **Claude 自身**。別の AI API は呼ばない（API キー不要） |
| 通常運用のモデル | **Haiku**（安いモデル）。起草だけ Sonnet へ任せることもできる（§8-3） |
| 下書きの作成 | `create_draft`（`replyToMessageId` で既存スレッドに紐づく） |
| 仕分け | `label_message`（メッセージ単位。`label_thread` は使わない） |
| 安全性の強制 | **PreToolUse フック** + `permissions.deny`（§3） |
| 定期実行 | **Routine**（cron）。最小間隔は1時間 |
| 決定的な処理 | `mail-assistant/*.py`（Python 標準ライブラリのみ・インストール不要） |
| 処理履歴 | `mail-assistant/state/ledger.jsonl`（リポジトリにコミット） |
| CI | `.github/workflows/mail-assistant.yml`（テストとフックの動作確認） |

### なぜこの構成か

- **送信を能力ごと封じる。** 送信ツールはハーネスが拒否するので、モデルが指示を読み違えても、
  メール本文の指示に誘導されても、送信は起こらない。
- **安いモデルで安全に回る。** 安全性に関わる確認（宛先・重複・インジェクション・dryRun）は
  コードとフックが行う。モデルの賢さに依存するのは「返信が必要か」と「文面」だけ。
- **鍵とデプロイが無い。** AI の API キーは不要で、リポジトリの内容がそのまま実行対象になる。
- **インストールが無い。** 実行環境は使い捨てなので、標準ライブラリだけで書いてある。

### 満たせない要件（正直な記載）

**「10〜15分間隔」は満たせません。** Routine の最小間隔が1時間のため、平日 8:00〜18:00 で
**1日10回**が上限です。急ぎのときは「メールを確認して」と頼めばいつでも即実行できます。

---

## 2. 処理の流れ

```
Routine（平日 8:00〜18:00 JST の毎時）… または人が「メールを確認して」と依頼
  │
  ├─ gate      稼働条件（営業日・稼働時間・祝日）。外なら即終了
  ├─ list_labels → ラベル ID を解決（dryRun 中は作らない）
  ├─ query     処理済みラベルを除いた検索クエリ（ID を検証して注入を防ぐ）
  ├─ search_threads  本文なしで一覧を取得（最大5ページ）
  ├─ list_drafts     既存の下書きがあるスレッドを取得（検索結果に下書きは出ないため）
  ├─ triage    機械判定・重複排除 → 実行マニフェストを書く ─────────────┐
  │              needsFullThread があれば get_thread で取り直して再実行       │
  │                                                                          │
  └─ process[] の各メッセージ                                                │
       ├─ get_thread(PLAIN_TEXT)  本文を読む                                 │
       ├─ inspect   本文全体を検査（奥のインジェクションで降格）→ 検査済みを記録 ┤
       ├─ 判定      3区分 + 確信度（Claude）                                  │
       ├─ 起草      REPLY_REQUIRED のみ。過去のやり取りと文体を参考に（Claude） │
       ├─ vet       下書きの事前点検（フックと同じ規則）                        │
       ├─ create_draft ──── [フック] マニフェスト・宛先・本文・dryRun を照合 ◀┘
       └─ label_message ─── [フック] ユーザーラベルの付与のみ許可
  │
  ├─ record --include-skips  履歴を追記（機械判定の分は自動）
  └─ git commit & push  ledger.jsonl のみ
```

---

## 3. ガード（フック）

`.claude/settings.json` に登録した PreToolUse フックが、**すべての MCP ツール呼び出し**の
直前に `mail-assistant/guard.py` の判定を走らせる。Gmail 以外のツールには干渉しない。

| 分類 | 対象 | 扱い |
|------|------|------|
| **deny** | `send_message` `reply` `forward` `trash_*` `delete_*` `mark_*_spam` `apply_sensitive_*` `update_draft` `update_label` `delete_label` `unlabel_*` `label_thread` | **無条件に拒否** |
| **gated** | `create_draft` `label_message` `update_message_labels` `create_label` | 下記を満たすときだけ許可 |
| **read** | `search_threads` `get_thread` `get_message` `list_labels` `list_drafts` `get_draft` | 許可 |
| **unknown-gmail** | 上記以外の Gmail ツール（添付取得など） | 拒否（fail closed） |

MCP のサーバー名は接続のたびに変わりうる（実際に `5c3da92a-…` から `Gmail` に変わった）ため、
**ツール名で判定**する。`send_message` などの名前は Gmail 以外のサーバーでも拒否する
（このリポジトリで何かを送る正当な用途は無く、誤送信の害の方が大きいため）。

### `create_draft` が許可される条件（すべて満たすこと）

1. `config.json` の `dryRun` が `false`
2. 添付・`htmlBody`・Bcc を使っていない
3. `replyToMessageId` があり、今回の `triage` で承認されたメッセージ（実行マニフェストにある）
4. そのメッセージが `skip` でない。`downgrade` なら確認用下書き（`reviewCreatesDraft: true`）のみ
5. そのメッセージの本文全体を `inspect` 済み
6. To が**そのメッセージの送信者1名だけ**。Cc は `ccMode` に従う
7. 本文に AI への言及・URL・Markdown が無く、空でも長すぎもしない
8. 同じメッセージへの2通目ではない

### ラベルが許可される条件

`dryRun` が `false`、今回の `triage` の対象メッセージ、**ユーザーラベルの付与のみ**
（外す操作＝アーカイブ・既読化と、`TRASH` `SPAM` などシステムラベルの付与は拒否）。

### 壊れても開かない設計

- 入口のシム（`.claude/hooks/gmail_guard.py`）は、本体を import する**前に**送信系を拒否する。
  本体に不具合があっても送信だけは止まる
- 本体が読み込めない・設定が読めない・マニフェストが無い／壊れている／3時間を過ぎている
  場合は、Gmail の書き込みを拒否する
- フックの入力が解釈できなければ終了コード 2 でツール実行をブロックする

### 監査ログ

判定は `mail-assistant/state/run/guard.log` に残る（gitignore 済み）。
記録するのはツール名・判定・理由コードだけで、宛先や本文は残さない。

```json
{"at": "2026-09-28T09:55:32+00:00", "tool": "list_labels", "kind": "read", "decision": "allow", "codes": []}
```

---

## 4. 判断ロジック

### 4-1. 機械判定（`triage.py`）

ここで除外したメールは Claude が本文を読まない。

| 判定 | 条件 |
|------|------|
| `skip` | 自分が送信 / `DRAFT` `SPAM` `TRASH` / 送信者が no-reply 等 / 送信者不明 |
| `skip` | 「返信不要」「配信停止」「メルマガ解除」「送信専用」「unsubscribe」等の文言 |
| `skip` | **配信システムの不可視パディング**（`U+034F` 等の連続。メルマガ判定の主力） |
| `skip` | 対象メール以降に佐藤または社内ドメインからの送信がある（返信済み） |
| `skip` | **既存の下書きがあるスレッド**（`list_drafts` の結果で判定） |
| `downgrade` | 佐藤が Cc のみ / 佐藤が To にも Cc にもいない（エイリアス転送・別担当宛） |
| `downgrade` | プロンプトインジェクションの疑い（スニペット、および `inspect` で本文全体） |
| `downgrade` | `list_drafts` が失敗して下書きの有無が分からない |
| 保留 | **4通以上のスレッドで全体を取得していない**（`needsFullThread`。§14） |
| `proceed` | 上記以外 |

`downgrade` は実行マニフェストに記録され、**フックが通常の返信下書きを拒否する**。
モデルが判定を上書きしても下書きは作られない。

**重複排除**は3重: Gmail 側の `AI処理済み` ラベル（検索クエリで除外）、`ledger.jsonl`、
フックによる「同じメッセージへの2通目」の拒否。
処理済みラベルは Gmail に残るので、履歴の push に失敗しても二重の下書きにはならない。

**処理の順番**は受信時刻の古い順。1回の上限（`maxMessagesPerRun`）で打ち切った分は
マニフェストにも載らず、次回に回る。

**重要メール**（`importantKeywords`: 請求・契約・見積・支払・セキュリティ等）は、
返信不要でも履歴に `important: true` を残す。

### 4-2. Claude の判定と確信度

3区分（`REPLY_REQUIRED` / `NO_REPLY_REQUIRED` / `REVIEW_REQUIRED`）と確信度・理由を必ず持つ。
判断材料の一覧は [`SKILL.md`](../.claude/skills/mail-assistant/SKILL.md) 手順6にある。

| 確信度 | 動作 |
|--------|------|
| `>= 0.85` | 判定どおり（返信が必要なら下書きを作る） |
| `0.60 〜 0.84` | `REVIEW_REQUIRED` へ降格。`AI要確認` ラベル（`reviewCreatesDraft: true` なら確認用下書きも） |
| `< 0.60` | ラベルも付けずログのみ |

### 4-3. 宛先

- **To は返信対象メールの送信者1名だけ。** コネクタは `Reply-To` を返さないので、
  送信者本人に固定する（フックがこれ以外を拒否する）
- **Cc は既定で付けない**（`ccMode: "none"`）。`"mirror-previous"` のときだけ、
  同じスレッドで**佐藤自身が過去に Cc していた相手**に限り引き継ぐ
- Bcc は使わない

---

## 5. 返信文の作成ルール

- 日本語が基本。相手が英語なら過去の返信傾向を見て英語で書く
- 佐藤本人が書いたような自然な文体（過去の送信メールから推定）
- **先に結論**、相手の質問に**漏れなく**答える
- 事実・金額・納期・日程・在庫・契約条件を**創作しない／確定しない**
- 不明な情報は `【要確認：対応可能な日程】` のようにプレースホルダーにする
- AI であることを書かない。Markdown と URL を使わない（フックが拒否する）
- 添付ファイルの中身は読めていない前提で書く
- 元の件名とスレッドを維持する（`Re:` を二重に付けない）

参考にする過去のやり取りは、同一スレッド → 同じ送信者 → 同じドメイン → 佐藤の類似件名の
送信メール の順で、合計 `historyMaxMessages` 通まで。

---

## 6. ファイル構成

```
.claude/
├── settings.json              # permissions.deny とフックの登録
├── hooks/gmail_guard.py       # フックの入口（送信系はここで先に止める）
└── skills/mail-assistant/
    └── SKILL.md               # ★手順と判断基準。Claude はこれに従って動く

.github/workflows/
└── mail-assistant.yml         # テストとフックの動作確認（灯台の日次ビルドとは独立）

mail-assistant/
├── README.md                  # このファイル
├── config.json                # 設定（唯一の入力）
├── assistant.py               # CLI（gate / query / triage / inspect / vet / record / summary / config）
├── gate.py                    # 設定読み込み・稼働条件・検索クエリ
├── jp_holidays.py             # 日本の祝日計算（ネットワーク不要）
├── triage.py                  # 機械判定・インジェクション検知・重複排除
├── policy.py                  # 安全ポリシー（ツール分類・本文・宛先・ラベル）
├── guard.py                   # フック本体（policy とマニフェストで判定）
├── manifest.py                # 実行マニフェスト（アドレスはソルト付きハッシュ）
├── ledger.py                  # 処理履歴（本文・氏名・アドレスは残さない）
├── summary.py                 # 日次集計
├── test_mail_assistant.py     # 稼働条件・機械判定・履歴・CLI のテスト
├── test_guard.py              # ガード・ポリシー・フックの実プロセス・通しのテスト
└── state/
    ├── ledger.jsonl           # 【自動生成】処理履歴。コミットして残す
    └── run/                   # 【自動生成・gitignore】実行マニフェストと監査ログ
```

判断基準を変えるなら `SKILL.md`、閾値や稼働条件を変えるなら `config.json`、
安全の規則を変えるなら `policy.py`（テストと CI が守りを固定している）。

---

## 7. 設定項目

すべて `mail-assistant/config.json`。確認は `python mail-assistant/assistant.py config`。

| キー | 既定値 | 説明 |
|------|--------|------|
| `targetEmail` / `targetName` | `sato@sanrikutech.jp` / `佐藤光彦` | 対象 |
| `timezone` | `Asia/Tokyo` | DST の無いゾーンのみ対応 |
| `workStartHour` / `workEndHour` | `8` / `18` | 稼働時間。区間は `[開始, 終了)` |
| `weekdaysOnly` / `skipJapaneseHolidays` | `true` / `true` | 平日のみ・祝日除外 |
| `extraHolidays` | `[]` | 追加休業日（`"2026-12-29"` 形式） |
| `includeOffHoursReceived` | `false` | 稼働時間外の受信も対象にするか |
| `maxCatchupHours` | `96` | 検索窓。連休明けの補完幅 |
| `maxMessagesPerRun` | `20` | 1回に判定する最大件数（古い順） |
| `historyLookbackMonths` / `historyMaxMessages` | `12` / `30` | 過去のやり取りの参照範囲 |
| `confidenceReplyThreshold` / `confidenceReviewThreshold` | `0.85` / `0.6` | 確信度の閾値 |
| `reviewCreatesDraft` | `false` | 要確認のとき確認用下書きを作るか |
| `ccMode` | `"none"` | `none` / `mirror-previous` |
| `signatureText` | `""` | 空なら過去の送信メールから推定 |
| `models.routine` | `claude-haiku-4-5-20251001` | 定期実行のモデル（§8-2） |
| `models.escalateDrafting` / `draftingModel` | `false` / `sonnet` | 起草だけ強いモデルに任せるか |
| **`dryRun`** | **`true`** | **ドライラン。フックが Gmail への書き込みをすべて拒否する** |
| `testMode` / `testLabel` / `testSenders` | `false` / `AIテスト対象` / `[]` | 対象の限定 |
| `labels.*` | `AI返信下書き` 等 | ラベル名。`important` は空でラベル無効 |
| `importantKeywords` / `notifySenderPatterns` | 請求… / no-reply… | 重要メール・通知系送信者 |
| `retryMax` | `2` | エラーになったメールの再試行回数 |

`dryRun` は「明示的に `false` と書いたときだけ」解除される。不正な値は例外にして実行を止める。

---

## 8. セットアップと定期実行

### 8-1. 初回

1. Claude の設定 → コネクタ → **Gmail** を `sato@sanrikutech.jp` で接続する
2. 「Gmail のラベル一覧を見せて」と頼み、読めることを確かめる
3. `python mail-assistant/assistant.py config` で `dryRun: true` を確認する
4. 「メールを確認して返信が必要なものを判定して」と頼む（ドライラン。Gmail には書き込まない）

### 8-2. 定期実行（Routine）を安いモデルで設置する

**設置は人間が明示的に行う。** Claude に次のように頼む。

> 平日 8:00〜18:00 の毎時にメール確認を実行する Routine を、毎回新しいセッションで作って。
> 18:05 に日次集計を出す Routine も作って。どちらもモデルは Haiku にして。

| 目的 | cron（UTC） | JST |
|------|-------------|-----|
| 朝の1回目 | `7 23 * * 0-4` | 平日 08:07 |
| 日中9回 | `7 0-8 * * 1-5` | 平日 09:07〜17:07 |
| 日次集計 | `5 9 * * 1-5` | 平日 18:05 |

祝日は cron で表せないので `gate` が判定して即終了する。
モデル指定（`update_trigger` の `model`）は**毎回新しいセッションで動く Routine にだけ効く**。

Routine のプロンプト例:

```
スキル mail-assistant に従って、Gmail の新着メールを確認し、
返信が必要なものに下書きを作成してください。
```

```
python mail-assistant/assistant.py summary を実行し、その日の処理結果を報告してください。
```

### 8-3. 起草だけ強いモデルに任せる（任意）

Haiku の返信案で品質が足りなければ `"models": {"escalateDrafting": true}` にする。
起草が必要なのは1日数通なので費用の増え方は小さい。判定・下書きの作成・ラベル・履歴は
呼び出し側（Haiku）が行い、フックの検査もそのまま効く。

---

## 9. 開発・テスト

```bash
# すべてのテスト（依存なし）
python -m unittest discover -s mail-assistant -p 'test_*.py'

# CLI
python mail-assistant/assistant.py gate [--now 2026-10-01T10:00:00+09:00]
python mail-assistant/assistant.py query --done-label-id Label_123
python mail-assistant/assistant.py config
python mail-assistant/assistant.py summary [--date 2026-09-28] [--json]
python mail-assistant/jp_holidays.py 2026

# フックをハーネスと同じ形で起動する（送信は拒否される）
echo '{"tool_name":"mcp__Gmail__send_message","tool_input":{}}' | python3 .claude/hooks/gmail_guard.py
```

テストの内訳:

| ファイル | 内容 |
|---|---|
| `test_mail_assistant.py` | 祝日・稼働条件・検索クエリ・機械判定・インジェクション検知・履歴・集計・CLI |
| `test_guard.py` | ツール分類・本文/宛先/ラベルの規則・マニフェスト・フック本体の全分岐・**フックの実プロセス起動**（本体が壊れていても送信が止まること等）・**triage → inspect → vet → フックの通し**・実受信箱で観測した形の回帰テスト |

テストは `MAIL_ASSISTANT_STATE_DIR` / `MAIL_ASSISTANT_CONFIG` で一時ディレクトリを使い、
本物の `state/` と `config.json` には触れない。

**安全の規則を弱める変更はテストで落ちるようにしてある。** 落ちたテストを消したり
条件を緩めたりして通すのではなく、設計を見直すこと。

---

## 10. ロールバック

上から順に。

1. **即時停止** — `config.json` の `dryRun` を `true` にする。
   **フックが Gmail への書き込みを拒否する**ので、モデルの挙動に関わらず確実に止まる
2. **定期実行を止める** — 「メール確認の Routine を止めて」
3. **スキルを無効にする** — `git mv .claude/skills/mail-assistant .claude/skills/mail-assistant.disabled`
4. **作られた下書きを片付ける** — Gmail で `label:AI返信下書き in:draft` を検索して手で削除
   （このスキルは下書きを削除しない。削除系のツールはフックが拒否する）

判定をやり直させたいメールは、`AI処理済み` ラベルを外し、`state/ledger.jsonl` から該当行を消す。

旧実装（Google Apps Script + Gemini）はコミット `b064e6a` にある。

---

## 11. 運用開始前チェックリスト

### セットアップ

- [ ] Gmail コネクタを `sato@sanrikutech.jp` で接続した
- [ ] すべてのテストが通る。GitHub の Actions で `mail-assistant tests` が緑
- [ ] `dryRun` が `true`
- [ ] 送信系のフックを確認した: 「テストとして send_message を呼んでみて」と頼み、
      `[mail-assistant guard]` で拒否されること（**このリポジトリのセッション内で**）

### Phase 1（ドライラン）

- [ ] 判定・確信度・理由がレポートされた
- [ ] メルマガ・通知が機械判定で除外されている
- [ ] 返信が必要なメールが `REPLY_REQUIRED` になっている
- [ ] **誤って `REPLY_REQUIRED` になるメールが無い**
- [ ] 返信案の文体・内容が妥当。不明な点が `【要確認：…】` になっている

### Phase 2（限定運用）

- [ ] 数通に `AIテスト対象` ラベルを手で付け、`testMode: true`、`maxMessagesPerRun: 3`、`dryRun: false`
- [ ] 下書きの宛先が送信者本人だけ、Cc が空、件名が維持され、正しいスレッドに紐づいている
- [ ] 署名が重複していない。AI への言及が無い
- [ ] **送信済みフォルダに何も増えていない**
- [ ] `state/run/guard.log` に意図しない `deny` が無い（あれば理由を確認）

### Phase 3（本番）

- [ ] `testMode: false`、`maxMessagesPerRun` を運用値へ
- [ ] Routine を3つ設置し、モデルを Haiku にした
- [ ] 翌営業日に `state/ledger.jsonl` と日次集計を確認した
- [ ] `AI要確認` ラベルを毎日見る運用を決めた

---

## 12. 段階的な立ち上げ（Phase 1〜3）

| Phase | 設定 | やること |
|---|---|---|
| 1 判定の検証 | `dryRun: true` | 何度か「メールを確認して」と頼み、誤判定を探す。自動配信を拾うなら `notifySenderPatterns`、判定が甘いなら閾値を上げる、基準そのものは `SKILL.md` |
| 2 限定運用 | `dryRun: false` `testMode: true` `maxMessagesPerRun: 3` | テスト対象ラベルを付けたメールだけで下書きを作り、Gmail で開いて確認 |
| 3 本番 | `testMode: false` `maxMessagesPerRun: 20` | Routine を設置。`AI要確認` を毎日確認 |

---

## 13. 脅威モデル

### 守れるもの

| 脅威 | 対策 | 強さ |
|---|---|---|
| モデルの手順ミス（特に安いモデル）で送信してしまう | 送信系は deny ルールとフックで無条件に拒否 | **ハーネスで強制** |
| メール本文の指示（プロンプトインジェクション）で送信・転送させられる | 同上。加えて本文を「データ」として扱う指示と検知→降格 | **ハーネスで強制** |
| インジェクションで「全員に返信」「別の宛先に下書き」させられる | 下書きはマニフェストにあるメッセージの送信者1名宛てのみ | **ハーネスで強制** |
| 本文の奥に埋め込まれたインジェクション | `inspect` が本文全体を検査して降格。未検査なら下書き不可 | **ハーネスで強制** |
| ドライラン中の書き込み | `dryRun: true` ならフックが Gmail の書き込みを拒否 | **ハーネスで強制** |
| 削除・アーカイブ・既読化 | 削除系ツールは拒否、ラベルは付与のみ、システムラベルは不可 | **ハーネスで強制** |
| 返信済みの会話・書きかけの返信がある会話への二重下書き | スレッドの全体取得を強制、`list_drafts` の結果を必須入力に | コードで強制 |
| 同じメールへの二重下書き | 処理済みラベル + 履歴 + フックの2通目拒否 | ハーネス + コード |
| 個人情報がログ・履歴に残る | ログはツール名と理由コードのみ。履歴はドメインのみ。マニフェストはハッシュ | コード |
| フック本体の不具合 | 入口のシムが送信系を先に止め、本体が読めなければ書き込みを拒否 | ハーネスで強制 |

### 守れないもの（正直な記載）

- **文面の誤り。** 事実誤認や不適切な表現は、人間が送信前に読んで防ぐ（それが下書き止まりの理由）
- **設定ファイルやマニフェストの改ざん。** セッション内のモデルが `config.json` の `dryRun` や
  マニフェストを書き換えれば、**下書き**は作れてしまう。ただし**送信系の拒否はそれらを一切
  読まない**ので、改ざんされても送信は開かない。最悪でも「人間が読む前の下書き」止まり
- **ハーネスの外。** 人が Gmail で下書きを送信する操作や、このリポジトリ以外のセッションは対象外
- **メール本文が Anthropic に送られること。** コネクタで読む以上避けられない。
  機械判定で除外したメールの本文は読まない。特定の相手を除外したければ
  `notifySenderPatterns` にドメインを追加する
- **Gmail 以外の MCP サーバーの書き込み。** 送信系の名前（`send_message` 等）以外には干渉しない

---

## 14. Gmail コネクタの制約（実データで確認済み）

**設計の前提なので、変更の前に必ず読むこと。**

| 制約 | 実データでの確認 | 対策 |
|---|---|---|
| 送信・削除のツールがある | `send_message` / `reply` / `forward` / `trash_*` など | §3 のガード |
| **`search_threads` はスレッドのうち5通しか返さない** | 13通のスレッドが5通、11通のスレッドも5通だった | 4通以上のスレッドは `get_thread` で全体を取り直すまで判定しない |
| **その5通がどれかは説明と実挙動が食い違う** | 説明は「古い方の約5通」、実際は新しい方の5通が返った | どちらの順も前提にしない |
| **検索とスレッド取得に下書きが出ない** | 直近14日の下書き11件がいずれも検索結果に無かった | `list_drafts` の結果（`draftThreadIds`）を `triage` の必須入力にした |
| 生ヘッダ（`List-Id` `Reply-To` 等）を返さない | — | 宛先は送信者本人に固定。メルマガは下記で判定 |
| カテゴリラベル（`CATEGORY_PROMOTIONS` 等）を返さない | `labelIds` は `INBOX` `UNREAD` `IMPORTANT` とユーザーラベルのみ | 不可視パディング・文言・送信者で判定 |
| 宛先の大文字小文字が揃っていない | `SATO@sanrikutech.jp` 宛のメールがあった | 比較はすべて小文字化 |
| `label_thread` は以後の続報にも付く | — | `label_message` のみ使う（フックが `label_thread` を拒否） |
| エイリアス宛のメールが多い | `billing@` `sup@` `info@` `kgg@` `shop@…` 宛が多数 | 本人が宛先にいなければ降格 |
| `list_labels` の ID キーは `labelId` | — | `SKILL.md` に明記 |
| Routine の最小間隔は1時間 | — | 1日10回で運用 |

---

## 15. 想定費用

**追加の金銭的コストはありません。** AI の API キーは不要で、Gmail・実行基盤・保存先は
既存の契約と Claude Code の利用枠の中で動きます。

消費を抑える設計:

| 対策 | 効果 |
|---|---|
| 定期実行を Haiku で回す | 通常運用のモデル費用を最小にする |
| 機械判定で先に絞る | 除外したメールは本文を取得しない（実測: 14通中6通だけ読んだ） |
| 一覧は本文なしで取る | 検索の段階で本文を読まない |
| 過去のやり取りは返信が必要なものだけ掘る | 返信不要のメールでは検索しない |
| `maxMessagesPerRun` / `historyMaxMessages` | 1回の上限を直接絞れる |

平日10回 × 20営業日 ＝ 月200セッション程度。

---

## 16. トラブルシューティング

| 症状 | 確認するところ | 対処 |
|---|---|---|
| 何も起きない | `assistant.py gate` の `reason` | 営業日・稼働時間外なら仕様どおり |
| `[mail-assistant guard] dry-run` | `config.json` | `dryRun: true` の間は書き込まない（仕様） |
| `[mail-assistant guard] not-inspected` | 手順 | `inspect` を先に実行する |
| `[mail-assistant guard] recipient-mismatch` | 宛先 | `triage` の `draftTo` をそのまま使う |
| `[mail-assistant guard] manifest-expired` | 実行時間 | 3時間以上前の `triage` は無効。やり直す |
| `[mail-assistant guard] markdown` / `url-in-body` | 返信案 | プレーンテキストにし、URL を除く |
| `triage` が `draftThreadIds` を要求する | 手順4 | `list_drafts` の結果を渡す（無ければ `[]`） |
| `needsFullThread` が返る | 手順5 | `get_thread(MINIMAL)` で取り直し `"complete": true` を付けて再実行 |
| 同じメールが再処理される | `AI処理済み` ラベル | ラベルが付いているか確認（`dryRun` 中は付かない） |
| フックが動いていない気がする | `state/run/guard.log` | Gmail を読んだのに記録が無ければ、`.claude/settings.json` が読まれていない |
| 祝日に動く | `jp_holidays.py` の対応範囲 | 五輪特例などは `extraHolidays` に追加 |
