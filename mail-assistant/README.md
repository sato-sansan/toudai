# 📧 AIメール返信下書きアシスタント

`sato@sanrikutech.jp` に届くメールのうち返信が必要なものを判定し、過去のメール履歴を参考に
返信文を作成して **Gmailの下書きとして保存する** 仕組み。

読み取り・判定・起草は **Claude Code 自身**が Gmail コネクタ経由で行う。
このディレクトリの Python スクリプトは「決定的に決まること」（稼働条件・重複排除・履歴・集計）だけを担う。

> ## ⚠️ メールは送信しません
>
> **Gmail コネクタにはメール送信ツールが存在しません。**
> 使えるのは `search_threads` / `get_thread` / `create_draft` / `label_*` などで、
> 送信に相当するツールが1つも無いため、**送信する能力そのものがありません**。
>
> 加えて運用ルールとして、削除・アーカイブ・既読化も行いません
> （`apply_sensitive_*_label` / `unlabel_*` / `update_draft` を使わない）。
> 作るのは下書きまでで、最終確認と送信は必ず人間が行います。

---

## 目次

1. [構成](#1-構成)
2. [処理の流れ](#2-処理の流れ)
3. [判断ロジック](#3-判断ロジック)
4. [返信文の作成ルール](#4-返信文の作成ルール)
5. [ファイル構成](#5-ファイル構成)
6. [設定項目](#6-設定項目)
7. [セットアップ](#7-セットアップ)
8. [定期実行の設定](#8-定期実行の設定)
9. [ローカルでの確認・テスト](#9-ローカルでの確認テスト)
10. [ロールバック](#10-ロールバック)
11. [運用開始前チェックリスト](#11-運用開始前チェックリスト)
12. [段階的な立ち上げ（Phase 1〜3）](#12-段階的な立ち上げphase-13)
13. [セキュリティ上の注意](#13-セキュリティ上の注意)
14. [Gmailコネクタの制約と回避策](#14-gmailコネクタの制約と回避策)
15. [想定費用](#15-想定費用)
16. [トラブルシューティング](#16-トラブルシューティング)

---

## 1. 構成

| 要素 | 採用 |
|------|------|
| メールの読み取り | Claude Code の **Gmail コネクタ**（`search_threads` / `get_thread`） |
| 返信要否の判定 | **Claude 自身**。別の AI API を呼ばない（`GEMINI_API_KEY` 等は不要） |
| 返信文の起草 | **Claude 自身**。過去メールをコネクタで検索して参考にする |
| 通常運用のモデル | **Haiku**（安いモデル）。必要なら起草だけ Sonnet へ委譲できる（§8-2 / §8-3） |
| 下書きの作成 | Gmail コネクタの `create_draft`（`replyToMessageId` でスレッドに紐づく） |
| 仕分け | `label_message`（`AI返信下書き` / `AI要確認` / `AI返信不要` / `AI処理済み` / `AI処理エラー`） |
| 定期実行 | **Routine**（cron）。**最小間隔は1時間** |
| 手順の定義 | スキル [`.claude/skills/mail-assistant/SKILL.md`](../.claude/skills/mail-assistant/SKILL.md) |
| 決定的な処理 | `mail-assistant/*.py`（Python 標準ライブラリのみ・インストール不要） |
| 処理履歴 | `mail-assistant/state/ledger.jsonl`（リポジトリにコミット） |

### なぜこの構成か

- **鍵を持たない。** AI の API キーが不要になり、管理すべき秘密が減った。
- **デプロイが無い。** リポジトリの内容がそのまま実行対象。`clasp push` のような手順が消えた。
- **送信できない。** コネクタに送信ツールが無いため、誤送信が構造的に起こり得ない。
- **インストールが無い。** 実行環境（Claude Code のセッション）は使い捨てなので、
  `npm install` のような準備が要らない Python 標準ライブラリのみで書いてある。

### 満たせない要件（正直な記載）

**要件の「10〜15分間隔」は満たせません。** Routine の最小間隔が1時間のため、
平日 8:00〜18:00 で **1時間ごと＝1日10回** が上限です。
急ぎの返信が必要な運用では、この遅延を前提にしてください
（手動で「メールを確認して」と依頼すればいつでも即座に実行できます）。

---

## 2. 処理の流れ

```
Routine（平日 8:00〜18:00 JST の毎時） … または人が「メールを確認して」と依頼
        │
        ▼
  スキル mail-assistant を読み込む
        │
        ├─ ① python mail-assistant/assistant.py gate
        │      → 営業日か / 稼働時間か / 祝日でないか。条件外なら即終了
        │      → 検索クエリと設定値を JSON で受け取る
        │
        ├─ ② list_labels → ラベルID解決（無ければ create_label）
        │
        ├─ ③ search_threads(query, view=THREAD_VIEW_MINIMAL)
        │      → この段階では本文を取らない（無駄に読まない）
        │
        ├─ ④ python mail-assistant/assistant.py triage
        │      → 自動配信・返信済み・既存下書きあり・処理済みを機械的に除外
        │      → Claude が読むべきメールだけに絞る
        │
        ├─ ⑤ get_thread(FULL_CONTENT) で本文を読む
        │      → Claude が3区分＋確信度で判定
        │
        ├─ ⑥ REPLY_REQUIRED のみ：過去メールを検索して文体と回答パターンを参考に起草
        │
        ├─ ⑦ create_draft(replyToMessageId=...)（ドライランでは行わない）
        │
        ├─ ⑧ label_message でラベル付与（ドライランでは行わない）
        │
        ├─ ⑨ python mail-assistant/assistant.py record → 履歴へ追記
        │
        └─ ⑩ git commit & push（履歴を残さないと次回の重複排除が効かない）
```

---

## 3. 判断ロジック

### 3-1. 機械判定（`triage.py`）— Claude に読ませる前

ここで弾いたメールは **Claude が本文を読みません**。

| 判定 | 条件 | 結果 |
|------|------|------|
| `skip` | 自分が送信（送信者一致 / `SENT` ラベル） | Claude を呼ばず `NO_REPLY_REQUIRED` |
| `skip` | `DRAFT` / `SPAM` / `TRASH` ラベル | 同上 |
| `skip` | 送信者が `no-reply` 等（`notifySenderPatterns` に部分一致） | 同上 |
| `skip` | Gmail のカテゴリラベル（`CATEGORY_PROMOTIONS` / `SOCIAL` / `FORUMS`）※ | 同上 |
| `skip` | 本文・件名に「返信不要」「配信停止」「メルマガ解除」「送信専用」「unsubscribe」等 | 同上 |
| `skip` | **配信システムの不可視パディング**（`U+034F` 等が3個以上連続） | 同上 |
| `skip` | 同一スレッドで対象メール以降に佐藤または社内ドメインからの送信がある | 同上 |
| `skip` | 同一スレッドに既に下書きが存在する | 同上 |
| `downgrade` | 佐藤が To に居らず Cc のみ | Claude は読むが **`REPLY_REQUIRED` にしない**（＝下書きを作らない） |
| `downgrade` | 佐藤が **To にも Cc にも居ない**（エイリアス・グループ経由の転送、別担当者宛） | 同上 |
| `downgrade` | プロンプトインジェクションの疑い | 同上 |
| `proceed` | 上記以外 | 通常処理 |

`not-direct-recipient` は実データで追加した規則です。実際の受信箱には
`billing@` `sup@` `kgg@` 宛のメールが多数転送されてきており、本人が明示的な宛先でないメールに
自動で返信下書きを作るのは危険なため、必ず人の確認を通します。

※ カテゴリラベルは実際のコネクタでは返ってこないため、保険としてのみ残しています（§14）。
**実運用でメルマガを拾えているのは「不可視パディング」と「文言」の判定**です。

**重複排除**は `state/ledger.jsonl` の `messageId` で行います。
正常終了したメールは再処理せず、エラー終了は `retryMax`（既定2回）まで再試行します。

**重要メールの記録**: `importantKeywords`（請求・契約・見積・支払・セキュリティ等）に
一致した場合、返信不要と判定しても履歴に `important: true` を残します。見落とし防止のためです。

### 3-2. Claude の判定と確信度

3区分（`REPLY_REQUIRED` / `NO_REPLY_REQUIRED` / `REVIEW_REQUIRED`）と確信度・理由を必ず持ちます。

| 確信度 | 動作 |
|--------|------|
| `>= 0.85` | 判定どおり（返信必要なら下書き作成） |
| `0.60 〜 0.84` | `REVIEW_REQUIRED` へ降格。`AI要確認` ラベルのみ（`reviewCreatesDraft: true` なら確認用下書きも作る） |
| `< 0.60` | **ラベルも付けずログのみ** |

判断材料の一覧（返信が必要／不要とみなす条件）は
[`SKILL.md`](../.claude/skills/mail-assistant/SKILL.md) §5 にあります。

### 3-3. 安全側への降格

以下に該当すると、返信が必要と判断していても**下書きを作りません**。

- 確信度が閾値未満
- Cc のみで届いている
- プロンプトインジェクションの疑い
- 返信案が AI・自動生成に言及している
- 返信案が参照元に無い URL を含んでいる
- 不明情報があるのに `【要確認：…】` が入っていない
- 返信案が空、または相手の質問に答えていない
- 返信先が決まらない（no-reply / 自分自身 / MLアドレスのみ）
- Gmail 側に既に下書きがある

### 3-4. 宛先の決定

- **To** = `Reply-To` があればそれ、なければ送信者の**1件のみ**
- **Cc** = `ccMode: "none"`（既定）なら**空**。勝手に「全員に返信」しない
  - `"mirror-previous"` の場合のみ、同一スレッドで**佐藤自身が過去に Cc していた相手**に限り引き継ぐ
- 自分自身・no-reply 系・メーリングリストのアドレスは常に除外

---

## 4. 返信文の作成ルール

- 日本語を基本とし、相手が英語なら過去の返信傾向を見て英語で書く
- 佐藤本人が書いたような自然な文体（過去の送信メールから文体を推定）
- **先に結論**、相手の質問に**漏れなく**答える
- 事実・金額・納期・日程・在庫・契約条件を**創作しない／確定しない**
- 不明情報は `【要確認：対応可能な日程】` のようなプレースホルダーにする
- **AI であることを本文に書かない**
- 添付ファイルは名前しか分からないので、読んだふりをしない
- 元の件名とスレッドを維持する（`Re:` を二重に付けない）

参考にする過去メールの順序（合計 `historyMaxMessages` 通で打ち切り）:
① 同一スレッド → ② 同じ送信者 → ③ 同じ会社・ドメイン → ④ 佐藤の類似件名の送信メール。

---

## 5. ファイル構成

```
mail-assistant/
├── README.md                  # このファイル
├── config.json                # 設定（唯一の入力）
├── assistant.py               # CLI（gate / triage / record / summary / config）
├── gate.py                    # 設定読み込み・稼働条件・検索窓・検索クエリ
├── jp_holidays.py             # 日本の祝日計算（ネットワーク不要）
├── triage.py                  # 機械判定・インジェクション検知・重複排除
├── ledger.py                  # 処理履歴（JSONL・PII を残さない）
├── summary.py                 # 日次集計
├── test_mail_assistant.py     # テスト 88件（unittest・標準ライブラリのみ）
└── state/
    └── ledger.jsonl           # 【自動生成】処理履歴。コミットして永続化する

.claude/skills/mail-assistant/
└── SKILL.md                   # ★実際の手順定義。Claude がこれに従って動く
```

**判定と起草のロジックは `SKILL.md` にあります。** Python 側は決定的な処理だけです。
判断基準を変えたいときは `SKILL.md` を、稼働条件や閾値を変えたいときは `config.json` を編集します。

---

## 6. 設定項目

すべて `mail-assistant/config.json` にあります。

| キー | 既定値 | 説明 |
|------|--------|------|
| `targetEmail` | `sato@sanrikutech.jp` | 対象メールアドレス |
| `targetName` | `佐藤光彦` | 署名・文体推定に使う名前 |
| `timezone` | `Asia/Tokyo` | タイムゾーン（DST の無いゾーンのみ対応） |
| `workStartHour` / `workEndHour` | `8` / `18` | 稼働時間。区間は `[開始, 終了)` |
| `weekdaysOnly` | `true` | 平日のみ処理 |
| `skipJapaneseHolidays` | `true` | 日本の祝日を除外 |
| `extraHolidays` | `[]` | 追加休業日（`"2026-12-29"` 形式） |
| `includeOffHoursReceived` | `false` | 稼働時間外に受信したメールも対象にするか |
| `maxCatchupHours` | `96` | 未処理メールを遡る上限。連休明けの補完幅 |
| `maxMessagesPerRun` | `20` | 1回の実行で処理する最大件数 |
| `historyLookbackMonths` | `12` | 過去メールの検索期間 |
| `historyMaxMessages` | `30` | 過去メールの最大取得件数 |
| `confidenceReplyThreshold` | `0.85` | 下書き自動作成の閾値 |
| `confidenceReviewThreshold` | `0.6` | 要確認の下限。これ未満はログのみ |
| `reviewCreatesDraft` | `false` | 要確認時に確認用下書きを作るか |
| `ccMode` | `"none"` | `none` / `mirror-previous` |
| `signatureText` | `""` | 空なら過去の送信メールから署名を推定 |
| `models.routine` | `claude-haiku-4-5-20251001` | **定期実行に使うモデル。** Routine 設置後に設定する（§8-2） |
| `models.escalateDrafting` | `false` | `true` にすると起草だけ強いモデルへ委譲する |
| `models.draftingModel` | `sonnet` | 委譲先（`sonnet` / `opus` / `haiku` / `fable`） |
| **`dryRun`** | **`true`** | **ドライラン。初期状態は有効** |
| `testMode` | `false` | テスト対象を絞る |
| `testLabel` | `AIテスト対象` | このラベルが付いたメールだけ処理（`testMode` 時） |
| `testSenders` | `[]` | この送信者だけ処理（`testMode` 時） |
| `labels.*` | `AI返信下書き` 等 | 各種ラベル名。`important` は空でラベル無効 |
| `importantKeywords` | 請求・契約… | 重要メール判定（返信不要でも履歴に残す） |
| `notifySenderPatterns` | `no-reply` 等 | 返信不可・通知系とみなす送信者の部分文字列 |
| `retryMax` | `2` | エラーになったメールの再試行回数 |

不正な値は**例外にして実行を止めます**（安全側に倒す）。
確認は `python mail-assistant/assistant.py config`。

---

## 7. セットアップ

### 7-1. Gmail コネクタを接続する

Claude の設定 → コネクタ → **Gmail** を `sato@sanrikutech.jp` で接続します。
接続時に要求される権限は Gmail コネクタの仕様どおりで、**送信権限は含まれません**。

接続できたか確認するには、Claude に次のように頼みます。

> Gmail のラベル一覧を見せて

### 7-2. ラベルを作る（任意）

初回実行時に自動作成されますが、先に作っておきたい場合は Claude に頼みます。

> `AI返信下書き` `AI要確認` `AI返信不要` `AI処理済み` `AI処理エラー` `AIテスト対象` の
> ラベルを Gmail に作って

### 7-3. 設定を確認する

```bash
python mail-assistant/assistant.py config
python mail-assistant/assistant.py gate
```

`dryRun` が `true`、`gate` の `ok` が期待どおりかを見ます。

### 7-4. 動かしてみる（ドライラン）

Claude に次のように頼みます。

> メールを確認して返信が必要なものを判定して

スキル `mail-assistant` が読み込まれ、判定結果と返信案がレポートされます。
**`dryRun: true` の間は Gmail に一切書き込みません。**

---

## 8. 定期実行の設定

**Routine の設置は人間が明示的に行ってください。** 自動では設置されません。

Claude に次のように頼みます（`create_trigger` が使われます）。

> 平日 8:00〜18:00 の毎時にメール確認を実行する Routine を作って。
> 18:05 に日次集計を出す Routine も作って。

作られる cron は次のとおりです（**cron は UTC**、JST は UTC+9）。

| 目的 | cron (UTC) | JST |
|------|-----------|-----|
| 朝の1回目 | `7 23 * * 0-4` | 平日 08:07 |
| 日中9回 | `7 0-8 * * 1-5` | 平日 09:07〜17:07 |
| 日次集計 | `5 9 * * 1-5` | 平日 18:05 |

祝日は cron で表現できないため、`gate` がコード側で判定して即終了します。
Routine の完了通知（プッシュ／メール）を有効にすると、日次集計が手元に届きます。

Routine に渡すプロンプトの例:

```
スキル mail-assistant に従って、Gmail の新着メールを確認し、
返信が必要なものに下書きを作成してください。
```

```
python mail-assistant/assistant.py summary を実行し、
その日の処理結果を報告してください。
```

設置済みの Routine は「Routine の一覧を見せて」で確認、
「メール確認の Routine を止めて」で停止できます。

### 8-2. 定期実行を安いモデルで回す（重要）

**通常の定期実行は Haiku で回す設計です。** 量が多いのは「読んで返信要否を判定する」部分
（1日15〜25通）で、ここは安いモデルで十分です。判定が曖昧なら確信度の閾値が自動的に
`REVIEW_REQUIRED` へ落とすため、**モデルが弱いことが誤送信につながりません**。

Routine を作ったあと、モデルを指定します。Claude に次のように頼んでください。

> メール確認の Routine のモデルを Haiku（`claude-haiku-4-5-20251001`）に変更して

内部では `update_trigger` の `model` を使います。**新しいセッションを作る Routine
（fresh-session）にだけ効く**ので、Routine は「毎回新しいセッションで実行」で作ってください。

日次集計の Routine も Haiku で十分です（`summary` コマンドの出力を報告するだけ）。

### 8-3. 起草だけ強いモデルに任せる（任意）

Haiku の返信案の品質が足りない場合、**起草だけ**を強いモデルへ委譲できます。

```json
"models": { "escalateDrafting": true, "draftingModel": "sonnet" }
```

起草が必要なのは1日3〜6通だけなので、費用の増え方は小さいまま品質が上がります。
判定・下書き作成・ラベル付与・履歴記録は安いモデル側が行い、委譲するのは文面の作成だけです。

**まずは `false`（全部 Haiku）で Phase 1 を回し、返信案を見てから判断してください。**

---

## 9. ローカルでの確認・テスト

```bash
# テスト（88件・依存なし）
python mail-assistant/test_mail_assistant.py

# 稼働条件と検索クエリの確認
python mail-assistant/assistant.py gate
python mail-assistant/assistant.py gate --now 2026-08-01T10:00:00+09:00   # 土曜で試す

# 設定の確認
python mail-assistant/assistant.py config

# 機械判定を手元で試す
echo '{"threads":[{"id":"t1","messages":[{"id":"m1","sender":"a@b.com",
  "toRecipients":["sato@sanrikutech.jp"],"subject":"ご質問","date":"2026-07-30T10:00:00+09:00",
  "labelIds":["INBOX"],"snippet":"ご確認をお願いします"}]}]}' \
  | python mail-assistant/assistant.py triage

# 祝日表の確認
python mail-assistant/jp_holidays.py 2026

# 日次集計
python mail-assistant/assistant.py summary
```

すべてリポジトリルートから実行します（`gate.py` 等はフラットな相対 import を使っています）。

---

## 10. ロールバック

深刻度に応じて4段階。**上から順に試してください。**

### レベル1: 即時停止（最速）

`mail-assistant/config.json` の **`dryRun` を `true` に戻す**。
以降の実行は判定のみ行い、下書き作成・ラベル付与を一切行いません。

### レベル2: Routine を止める

Claude に「メール確認の Routine を止めて」と頼む（`update_trigger` で無効化、
または `delete_trigger` で削除）。

### レベル3: スキルを無効にする

```bash
git mv .claude/skills/mail-assistant .claude/skills/mail-assistant.disabled
```

スキルが読み込まれなくなり、依頼しても手順が展開されません。

### レベル4: 作られた下書きを片付ける

このスキルは下書きを**削除しません**。手動で消してください。

1. Gmail で `label:AI返信下書き in:draft` を検索
2. 不要な下書きを選択して削除

判定を再実行させたい場合は、`state/ledger.jsonl` から該当 `messageId` の行を削除し、
メッセージから `AI処理済み` ラベルを外してください。

### GAS 版に戻したい場合

この機能は当初 Google Apps Script + Gemini API で実装していました。
その実装はコミット `b064e6a` に残っています。

```bash
git checkout b064e6a -- mail-assistant/
```

---

## 11. 運用開始前チェックリスト

### セットアップ

- [ ] Gmail コネクタを `sato@sanrikutech.jp` で接続した
- [ ] `python mail-assistant/test_mail_assistant.py` が通る（88件）
- [ ] `python mail-assistant/assistant.py config` の内容が意図どおり
- [ ] `dryRun` が `true` である
- [ ] ラベルを作った（または自動作成に任せると決めた）

### ドライラン検証（Phase 1）

- [ ] 「メールを確認して」で実行し、判定・確信度・理由がレポートされた
- [ ] 明らかな自動配信・メルマガが機械判定で `skip` されている
- [ ] 実際に返信が必要なメールが `REPLY_REQUIRED` になっている
- [ ] **誤って `REPLY_REQUIRED` になるメールが無い**ことを目視確認した
- [ ] 生成された返信案の文体・内容が妥当
- [ ] 不明情報が `【要確認：…】` になっている

### 限定運用（Phase 2）

- [ ] 数通のメールに `AIテスト対象` ラベルを手で付けた
- [ ] `testMode` を `true`、`maxMessagesPerRun` を `3` にした
- [ ] `dryRun` を `false` にした
- [ ] 作られた下書きの**宛先（To/Cc）が正しい**
- [ ] 件名が元のスレッドを維持している（`Re:` が二重でない）
- [ ] 下書きが**正しいスレッドに紐づいている**
- [ ] 署名が意図どおり（重複していない）
- [ ] 本文に AI への言及が無い
- [ ] **送信されていない**ことを「送信済み」フォルダで確認した
- [ ] `state/ledger.jsonl` がコミット・push されている

### 本番運用（Phase 3）

- [ ] `testMode` を `false`、`maxMessagesPerRun` を運用値に戻した
- [ ] Routine を設置した（毎時＋18:05 の集計）
- [ ] **Routine のモデルを Haiku に変更した**（§8-2）。「Routine の一覧を見せて」で確認
- [ ] 「Routine の一覧を見せて」で3件見える
- [ ] Haiku の返信案の品質を確認した（不足なら `escalateDrafting: true`。§8-3）
- [ ] 翌営業日に `state/ledger.jsonl` と日次集計を確認した
- [ ] `AI要確認` ラベルを毎日確認する運用を決めた
- [ ] ロールバック手順（レベル1: `dryRun: true`）を把握している

---

## 12. 段階的な立ち上げ（Phase 1〜3）

### Phase 1: 判定の検証（ドライラン）

設定: `dryRun: true`, `testMode: false`

1. 「メールを確認して返信が必要なものを判定して」と何度か依頼する
2. レポートを目視確認。特に**誤って `REPLY_REQUIRED` になるメール**を探す
3. 誤判定があれば調整
   - 自動配信を拾ってしまう → `notifySenderPatterns` に送信者パターンを追加
   - 判定が甘い → `confidenceReplyThreshold` を上げる（例 `0.90`）
   - 判断基準そのものを変える → `SKILL.md` §5 を編集
4. 数営業日ぶん確認できたら Phase 2 へ

### Phase 2: 限定的に下書きを作る

設定: `dryRun: false`, `testMode: true`, `maxMessagesPerRun: 3`

1. 検証したいメールに `AIテスト対象` ラベルを手で付ける
2. 「メールを確認して」と依頼する
3. 作られた下書きを **Gmail で開いて**宛先・件名・スレッド・署名・本文を確認
4. 問題があれば `dryRun: true` に戻して調整

### Phase 3: 本番運用

設定: `dryRun: false`, `testMode: false`, `maxMessagesPerRun: 20`

1. Routine を設置する（§8）
2. 初日は昼と夕方に結果を確認
3. `AI要確認` ラベルは毎日確認する運用にする

---

## 13. セキュリティ上の注意

### 実装済みの対策

| 対策 | 実装 |
|------|------|
| メールを送信しない | **コネクタに送信ツールが存在しない**（能力そのものが無い） |
| 削除・アーカイブ・既読化しない | `apply_sensitive_*_label` / `unlabel_*` / `delete_label` を使わない運用ルール（`SKILL.md` 冒頭） |
| 既存の下書きを壊さない | `update_draft` を使わない。新規作成のみ。作成前に同一スレッドの下書きを確認 |
| 秘密情報を持たない | AI の API キーが不要。`config.json` に秘密は無い |
| ログ・履歴に個人情報を残さない | 履歴は ID・ドメイン・判定結果のみ。`ledger.py` がメールアドレスと電話番号を伏せ字化 |
| 判定を機械検証する | `ledger.py` が区分・確信度の値域を検証し、不正なら例外 |
| プロンプトインジェクション対策 | 本文を「信頼できないデータ」として扱う指示（`SKILL.md` §5）＋ `triage.py` の検知＋検知時は降格 |
| 本文中の URL へアクセスしない | `SKILL.md` で明示的に禁止 |
| 添付ファイルを解析・実行しない | ファイル名のみ扱う。中身は読まず「未読」として扱う |
| 読む範囲を絞る | 機械判定で除外したメールは本文を取得しない。過去メールは返信が必要なものだけ掘る |
| 誤送信の防止 | To は1件のみ、Cc は既定で空。宛先が決まらなければ下書きを作らない |
| 二重処理の防止 | `state/ledger.jsonl` の `messageId` ＋ 既存下書きの確認 |

### 運用上の注意（人間が担保すること）

- **送信前に必ず本文を読んでください。** 特に金額・納期・日程・契約条件は
  `【要確認：…】` になっているか確認してください。
- **`AI要確認` ラベルは毎日確認してください。** 放置すると返信漏れになります。
- **メール本文は Claude（Anthropic）に送信されます。** これは Gmail コネクタを
  使う以上避けられません。機械判定で除外したメールの本文は読まれません。
  特定の相手を除外したい場合は `notifySenderPatterns` にドメインを追加してください。
- **処理履歴はリポジトリにコミットされます。** 個人情報は入りませんが、
  「どのドメインといつやり取りしたか」は git 履歴に残ります。
  リポジトリが公開設定の場合は注意してください。
- **`dryRun: false` にするのは人間の明示的な操作です。**

---

## 14. Gmailコネクタの制約と回避策

実データで確認した制約です。**設計の前提なので変更時は必ず確認してください。**

| 制約 | 影響 | 回避策 |
|------|------|--------|
| **生ヘッダを返さない**（`List-Id` / `Precedence` / `Auto-Submitted`） | 定番のメルマガ判定が使えない | 送信者パターン＋不可視パディング＋文言で判定 |
| **カテゴリラベルを返さない**（`CATEGORY_PROMOTIONS` 等） | Gmail の分類器を利用できない。実際の `labelIds` は `INBOX` / `UNREAD` / `IMPORTANT` / ユーザーラベルのみ | 同上。カテゴリ判定はコードに残してあるが実質未使用 |
| `search_threads` はスレッド単位 | 1通でも条件に合うとスレッド全体が返る。`-label:` による除外が続報メールの取りこぼしを招く | ラベルによる除外をクエリに入れず、重複排除を `ledger.jsonl` に一元化 |
| `label_thread` は以後の新着メールにもラベルが付く | 続報メールが処理済み扱いになり取りこぼす | **`label_message` を使う**（`SKILL.md` §8） |
| `after:` は日付粒度 | 時刻単位の絞り込みができない | 検索は広めに取り、時刻の絞り込みは `triage` の受信時刻ゲートで行う |
| `create_draft` の `to`/`cc` は素のアドレスのみ | 表示名を付けられない | 素のアドレスを渡す（Gmail 側が表示名を補う） |
| 添付ファイル付きの下書きを作れない | — | 添付は扱わない（要件どおり） |
| Routine の最小間隔が1時間 | 10〜15分間隔にできない | 1日10回で運用。急ぎは手動依頼 |

### 不可視パディングによるメルマガ判定

配信システムはプレビュー文（プリヘッダ）を埋めるために `U+034F` などの不可視文字を
大量に挿入します。実際の受信箱では、これが**最も精度の高いメルマガ判定材料**でした。

実データ14通での機械判定の結果:

```
候補 14通 → Claude が読む 6通
  no-reply-sender          2通（GitHub の通知）
  bulk-preheader-padding   5通（Studio / nomad / ケミカン / Bryan Johnson / 配送通知）
  sender-says-no-reply     1通（「本メールは送信専用」）
  稼働時間外の受信          4通
```

---

## 15. 想定費用

| 項目 | 費用 |
|------|------|
| AI の API | **不要**（Claude 自身が判定・起草するため別途の API キーが要らない） |
| Gmail | Google Workspace の既存契約内。追加費用なし |
| 実行基盤 | Claude Code の利用枠内。Routine の実行1回＝1セッション |
| 保存 | GitHub リポジトリ（履歴の JSONL は1日あたり数KB） |

**追加の金銭的コストはありません。** 消費するのは Claude Code の利用枠です。

### 消費を抑える設計

| 対策 | 効果 |
|------|------|
| **定期実行を Haiku で回す**（§8-2） | 通常運用のモデル費用を最小にする。これが一番効く |
| 機械判定で先に絞る（`triage`） | 除外したメールは**本文を取得しない**。実測 14通 → 6通 |
| 過去メールは返信が必要なものだけ掘る | `NO_REPLY_REQUIRED` のメールで過去履歴を検索しない |
| `search_threads` は本文なしのビューを使う | 一覧取得の段階で本文を読まない |
| `maxMessagesPerRun` / `historyMaxMessages` を下げる | 1回あたりの上限を直接絞る |

1回の実行で消費する目安:
- `search_threads` 1回、`triage` 1回
- 機械判定を通過したメールぶんの `get_thread`（実測 14通中6通）
- 返信が必要なメールぶんの過去メール検索（2〜4回）と `create_draft`

平日10回 × 20営業日 = **月200セッション程度**。1セッションあたりの規模は小さめで、
かつ Haiku で回すため、日常運用の費用は低く収まります。

起草だけ Sonnet へ委譲する場合（§8-3）でも、起草が必要なのは1日3〜6通なので
増分は限定的です。**まず全部 Haiku で試し、品質を見てから判断してください。**

---

## 16. トラブルシューティング

| 症状 | 確認するところ | 対処 |
|------|----------------|------|
| 何も起きない | `assistant.py gate` の `reason` | `not-business-day` / `outside-work-hours` は仕様どおり |
| Gmail にアクセスできない | コネクタの接続状態 | Claude の設定 → コネクタ → Gmail を再接続 |
| 下書きが作られない | `config.json` の `dryRun` | `true` の間は作られません（§12 Phase 2 へ） |
| 下書きが作られない（`dryRun: false`） | `state/ledger.jsonl` の `action` と `reasonCode` | `draft-already-exists` / `no-recipient` / `cc-only` 等の理由が入っています |
| メルマガが Claude に読まれている | `triage` の結果 | `notifySenderPatterns` に送信者を追加。パディングも文言も無い配信メールは Claude 判定に委ねる（安全性の問題ではない） |
| 同じメールが再処理される | `state/ledger.jsonl` が push されているか | 履歴をコミットしないと重複排除が効きません（§2 ⑩） |
| 判定を再実行させたい | `state/ledger.jsonl` と `AI処理済み` ラベル | 両方から対象を外す（§10 レベル4） |
| 実行間隔が遅い | Routine の制約 | 最小1時間です。急ぎは「メールを確認して」と手動依頼 |
| 稼働時間外に受信したメールが処理されない | `includeOffHoursReceived` | `true` にすると時刻を問わず対象になります |
| 祝日に動いてしまう | `jp_holidays.py` の対応範囲 | 2020/2021 の五輪特例は非対応。`extraHolidays` に手で追加 |
