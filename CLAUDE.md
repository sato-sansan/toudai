# CLAUDE.md

このファイルは AI アシスタント（Claude Code 等）がこのリポジトリで作業するためのガイドです。
人間向けの利用・デプロイ手順は `README.md` にあります（重複は書かず、ここでは**実装上の約束事**に集中します）。

---

## 0. このリポジトリには2つのプロジェクトがある

| ディレクトリ | プロジェクト | 技術構成 | このファイルでの扱い |
|-------------|-------------|---------|---------------------|
| ルート（`scripts/` `docs/` `config.json`） | **灯台（TOUDAI）** — デイリーキュレーション PWA | Python 標準ライブラリ + 素の HTML/CSS/JS + GitHub Actions + GitHub Pages | §1〜§9（このファイルの本体） |
| `mail-assistant/` + `.claude/`（skills / hooks / settings.json） | **AIメール返信下書きアシスタント** | Claude Code + Gmail コネクタ + PreToolUse フック + Python 標準ライブラリ + Routine | §10 |

**この2つは独立している。** 一方を変更するときに他方のファイルを触る必要はまず無い。
触る前に本当に必要か確認する。

**ただし `.claude/settings.json` のフックと deny ルールはリポジトリ全体に効く。**
灯台の作業中でも、このリポジトリのセッションでは Gmail の送信・削除は拒否され、
下書き・ラベルの作成は mail-assistant の規則で検査される（意図した挙動。§10-1）。

両者に共通する制約（どちらでも守る）:

- **外部依存を増やさない。** どちらも Python 標準ライブラリのみで完結させる。
- **フロント（`docs/`）にビルドステップを入れない。**
- **コメント・docstring・コミットメッセージ・UI 文言は日本語**（§9）。

---

## 1. 灯台（TOUDAI）とは何か

**灯台（TOUDAI）** = 運用費0円のデイリーキュレーション PWA。

指定キーワードのニュースを毎朝自動収集し、**テキスト一覧＋5分以内の音声ダイジェスト**として配信する。

**設計上の最重要制約（すべての判断の前提）**

| 制約 | 意味すること |
|------|-------------|
| **サーバー・DB を持たない** | 生成物は静的ファイル（JSON + mp3）のみ。API サーバー・データベース・認証基盤を追加しない |
| **月額0円を厳守** | 有料 API・クレジットカード登録が必要なサービスを導入しない。無料枠の外に出る変更は却下 |
| **ビルドステップなし（フロント）** | `docs/` は素の HTML/CSS/JS。npm・bundler・TypeScript・フレームワークを導入しない |
| **外部依存は最小** | Python 側は収集・要約・台本まで**標準ライブラリのみ**。追加依存は音声（edge-tts / mutagen）だけ |
| **全段がフォールバックを持つ** | どのソース・API が落ちても JSON は必ず出力される。例外で全体を止めない |

---

## 2. アーキテクチャ

```
GitHub Actions (毎朝 6:00 JST = 21:00 UTC cron)
        │
        ▼
  scripts/build.py  ← オーケストレーター（各段を順に呼ぶ）
        │
        ├─ 1. collect.py     … RSS/HTTP から記事収集（Source プラグイン）
        ├─ 2. summarize.py   … Gemini 要約 → 失敗時は抽出型要約 + jumpUrl 生成
        ├─ 3. script_gen.py  … 音声台本（1,800字以内）
        ├─ 4. tts.py         … edge-tts で mp3（5分超は破棄）
        ├─ 5. 出力           … docs/data/YYYY-MM-DD.json (+ docs/audio/YYYY-MM-DD.mp3)
        └─ 6. 保持期間整理    … 8日より前を削除 → data/index.json を再生成
        │
        ▼
  git commit & push（docs/data と docs/audio のみ）
        │
        ▼
  GitHub Pages (main / docs) → docs/app.js が index.json → 日次JSON を fetch して描画
```

**データの流れは一方向**：`config.json`（入力）→ パイプライン → `docs/data/*.json`（出力）→ フロント（表示のみ）。
フロントは生成物を読むだけで、記事の加工・再取得はしない。唯一の例外が**設定パネルからの
`config.json` 書き換え**（GitHub Contents API 経由。§6-C）。

---

## 3. ファイルマップ

```
toudai/
├── config.json                   # 【唯一の入力】キーワード・フィード定義
├── CLAUDE.md                     # このファイル
├── README.md                     # 人間向け：使い方・デプロイ・トラブルシュート
├── .claude/launch.json           # ローカルプレビュー（python -m http.server 4173 --directory docs）
├── .github/workflows/daily.yml   # 毎朝の cron ビルド + commit/push
├── scripts/
│   ├── build.py         # オーケストレーター。RETENTION_DAYS=8、index.json 生成
│   ├── collect.py       # Source プラグイン群 + 重複排除/フィルタ。Article dataclass の定義元
│   ├── summarize.py     # Gemini(2.5-flash) / 抽出型フォールバック / Text Fragment jumpUrl
│   ├── script_gen.py    # 台本生成。MAX_CHARS=1800
│   ├── tts.py           # edge-tts。VOICE/MAX_SECONDS=300/リトライ
│   └── requirements.txt # edge-tts, mutagen のみ
└── docs/                         # ← GitHub Pages の公開ルート
    ├── index.html                # 静的シェル（要素 id を app.js が直接引く）
    ├── app.js                    # 全フロントロジック（約800行・IIFE・素の JS）
    ├── style.css                 # :root の CSS 変数でテーマ管理（ダーク固定）
    ├── manifest.json / sw.js     # PWA。sw.js の VERSION がキャッシュ世代
    ├── icon.svg / icon-192.png / icon-512.png
    ├── data/YYYY-MM-DD.json      # 【自動生成】手で編集しない
    ├── data/index.json           # 【自動生成】{ latest, dates[] }
    └── audio/YYYY-MM-DD.mp3      # 【自動生成】無い日もある（正常）
```

`docs/data/` と `docs/audio/` は **Actions が生成してコミットする領域**。手で編集したりレビュー対象にしたりしない。

---

## 4. 開発コマンド

```bash
# 依存インストール（音声生成が必要なときだけ）
pip install -r scripts/requirements.txt

# フルビルド（リポジトリルートから実行する）
python scripts/build.py

# 段ごとの単体実行（各モジュールに __main__ がある）
python scripts/collect.py       # 収集結果を一覧表示
python scripts/summarize.py     # 収集＋要約（要約文と jumpUrl を確認）
python scripts/script_gen.py    # 台本を標準出力＋字数表示
python scripts/tts.py           # scripts/test.mp3 に音声テスト（.gitignore 済み）

# フロントのプレビュー
python -m http.server --directory docs 4173   # → http://localhost:4173/
```

**注意点**

- **リポジトリルートから実行する。** `scripts/*.py` は `import collect as C` のようなフラットな
  相対 import を使い、パスは `ROOT = Path(__file__).resolve().parents[1]` で解決している。
  パッケージ化（`from .collect import`）や `scripts/` への `__init__.py` 追加はしない。
- **`GEMINI_API_KEY` を設定してローカル実行すると数分かかる。** `INTER_CALL_SLEEP = 7.0` 秒 ×
  記事数（現状40件）で意図的に遅い（無料枠 約10 req/分 を下回るため）。
  収集やフロントの検証だけならキーを**設定しない**（抽出型要約で即座に完走する）。
- **テストもリンタも無い。** 検証は上記の手動実行と、生成された JSON / 台本 / mp3 の目視確認で行う。
  テストを新規追加する場合は標準ライブラリの `unittest` を使い、依存を増やさない。
- Python は CI と同じ **3.12** 想定（`from __future__ import annotations` + `X | None` 記法を使用）。

---

## 5. データ契約（変更時は両側を必ず揃える）

`docs/data/YYYY-MM-DD.json` は Python（`build.py` / `Article.to_dict()`）が書き、
JS（`docs/app.js`）が読む。**スキーマ変更は必ず両方セットで**行う。

```jsonc
{
  "date": "2026-07-30",
  "generatedAt": "2026-07-30T06:01:12+09:00",
  "audioUrl": "audio/2026-07-30.mp3",   // null のときフロントは Web Speech API で読み上げ
  "audioScript": "…",                   // 常に入れる（mp3 があっても読み上げフォールバック用）
  "keywords": [
    {
      "keyword": "気仙沼",               // config.json の label と一致（フロントの並び順設定のキー）
      "articles": [
        {
          "title":  "…",
          "source": "気仙沼市公式",
          "publishedAt": "2026-07-29T19:00:00+09:00",  // JST の ISO8601
          "summary": "…",                // 空文字あり（材料不足時）→ カードで非表示になる
          "url":     "https://…",
          "jumpUrl": "https://…#:~:text=…",  // Text Fragment 付き。無理なら url と同値
          "badge":   "市公式",            // 出典バッジ。空文字あり
          "primary": true                 // 一次情報なら true（カードに「一次」チップ）
        }
      ]
    }
  ]
}
```

`docs/data/index.json` = `{ "latest": "YYYY-MM-DD", "dates": ["新しい順", …] }`。
フロントは `index.json` を先に読み、失敗したら「今日の日付」で直接 JSON を取りにいく（`loadIndex()`）。

**キー命名**：Python 内部は snake_case（`published_at`, `jump_url`）、**JSON 出力は camelCase**。
変換は `Article.to_dict()` の1箇所だけ。ここを迂回して辞書を組み立てない。

---

## 6. 領域ごとの規約

### A. 収集（`scripts/collect.py`）

- **新しいソースの追加は、まず `config.json` の `keywords[].feeds` で試す。** RSS/RDF/Atom なら
  `ConfigFeedSource` が汎用に処理するのでコード変更は不要。これが第一選択。
- コードが必要な場合のみ `Source` を継承したクラスを1つ書き、`collect_for_keyword()` の
  `sources` リストに足す。`healthFeeds` のような**キーワード種別ごとの特別扱いは復活させない**
  （宣言的な `feeds` に統一済み）。
- **ソース障害は握りつぶす。** `Source._safe_items()` が `print("[warn] …")` して空リストを返す。
  1ソースの失敗で他ソースやビルド全体を落とさないこと。
- 一次情報 / 二次情報の区別が中核仕様：`Article.primary` が `True` のものは
  `_dedupe_and_filter()` で常に二次情報より上位に並ぶ。タイトル正規化による重複排除は
  この並び替えの**後**に行う（同じ話題なら一次情報が勝つ設計なので、順序を入れ替えない）。
- `ConfigFeedSource.FRESHNESS_DAYS = 7`：過去記事を大量に含むフィード（OpenAI 等）対策。
- 重複排除キーは `guid`（無ければ `url`）＋タイトル先頭40字の正規化。
- `maxArticlesPerKeyword`（config、既定10）でキーワードあたりの件数を打ち切る。

### B. 要約（`scripts/summarize.py`）

- **ラウンドロビン順で処理する**（`_round_robin_order`：全タブの1位→全タブの2位→…）。
  無料枠が途中で尽きても、各タブの上位カード（＝音声にも使われる記事）に Gemini 要約が
  行き渡るため。単純な逐次ループに戻さない。
- 既定モデルは `gemini-2.5-flash`（`GEMINI_MODEL` env で上書き可）。
  `thinkingConfig.thinkingBudget = 0` は**必須**：2.5 系は既定で思考にトークンを使い JSON が途中で切れる。
- 失敗耐性は3層：429 は指数バックオフ再試行 → 単発失敗は抽出型で補完 →
  `MAX_CONSECUTIVE_FAIL = 3` 連続で以降は抽出型に固定（日次クォータ枯渇対策）。
- `_extract_json()` は途中切れレスポンスから `summary` / `quote` だけを正規表現で拾う。
  エスケープ解除に **`unicode_escape` を使わない**（日本語が壊れる）。JSON 再パースで処理している。
- 健康系（`badge` が `PubMed` / `The Lancet`）は断定を避け出典を明示するプロンプトに分岐する。
  この配慮は `script_gen.py` 側にもあるので、片方だけ変えない。
- `jumpUrl` は要約根拠の引用文から `#:~:text=` を組む。6字未満・既存フラグメントありなら素の URL を返す。

### C. フロントエンド（`docs/`）

- **素の ES5 相当の Vanilla JS**。全体が1つの IIFE、`var` + `function`、`fetch` と Promise（`async/await` は未使用）。
  この文体に合わせる。ビルドツール・npm・フレームワーク・外部 CDN は入れない。
- `index.html` の要素 `id` と `app.js` 冒頭の `el = {…}` は1対1対応。
  片方だけ変えると `byId()` が `null` を返して初期化ごと壊れる。
- `GH_OWNER` / `GH_REPO` / `GH_BRANCH` が `app.js` にハードコードされている（設定パネルの
  GitHub API 呼び出し先）。フォークや rename の際はここも直す。
- **`sw.js` の `VERSION` を上げないとシェル更新が届かない。** `index.html` / `app.js` /
  `style.css` / `manifest.json` を変えたら `VERSION = "toudai-vN"` をインクリメントする。
  `data/` と `audio/` はネット優先なのでバージョン変更不要。
- 色・角丸・最大幅は `style.css` の `:root` CSS 変数で管理。生の hex を新規に散らさない。
- ユーザー入力・取得テキストは必ず `escapeHtml()` を通してから `innerHTML` に入れる（既存カードもそう）。
- **設定パネルは2層構造**（README §アプリ内の設定パネル）:
  - **A. 並び替え・表示切替** … `localStorage` の `toudai.kwPrefs` のみ。トークン不要・即時反映・端末内限定。
    `config.json` に新キーワードが増えても末尾に自動追加されて壊れない（`visibleKeywords()` / `normalizedKwOrder()`）。
  - **B. キーワード編集** … Fine-grained PAT（`localStorage` の `toudai.ghToken`）で GitHub Contents API を
    直接叩き `config.json` をコミットする。**`label` / `queries` / `exclude` / 並び順しか書き換えない**。
    `feeds` / `pubmedQueries` / `filter` は読み込んだ JSON をそのまま保持して往復させる（この不変条件を壊さない）。
    409 は1回だけ sha を取り直して再送。401/403/404/409 は `ghErrorMessage()` の日本語メッセージ。
  - 日本語を含む base64 は `TextEncoder`/`TextDecoder` 経由（`btoa`/`atob` 単体では壊れる）。

### D. 音声（`script_gen.py` / `tts.py`）

- 台本は **1,800字以内厳守**（日本語 TTS 実測で約4.5〜5分）。
  超過時は「1キーワードあたり 3本→2本→1本」と段階的に削り、それでも溢れたら要約を60字にクリップする。
- `tts.py` は生成後に `mutagen` で長さを検証し、**300秒超なら mp3 を破棄**して `False` を返す。
  破棄されると `audioUrl` が `null` になり、フロントが Web Speech API で読み上げる（異常ではない）。
- edge-tts は断続的に失敗するため 最大3回（5秒→15秒バックオフ）リトライ。それでも失敗すれば `False`。
- 音声が長くなる根本対策は**キーワードを増やしすぎないこと**。5個までが目安。

### E. ワークフロー（`.github/workflows/daily.yml`）

- cron `0 21 * * *`（UTC）= 6:00 JST。`workflow_dispatch` で手動実行も可。
- `permissions: contents: write` と `concurrency: toudai-daily`（`cancel-in-progress: false`）。
- コミット対象は `docs/data` と `docs/audio` **のみ**。差分が無ければコミットしない。
- 既知の小さな癖（バグではない）:
  - コミットメッセージの日付は `date -u` なので、生成された JSON の JST 日付より**1日古い**
    （例: `chore: 灯台 daily digest 2026-07-29` が `docs/data/2026-07-30.json` を含む）。
  - README は `GEMINI_MODEL` を secret/env で上書き可と書いているが、ワークフローの `env` は
    `GEMINI_API_KEY` だけを渡している。CI で切り替えたい場合は `env:` に `GEMINI_MODEL` を追加する必要がある。

---

## 7. 変更時のチェックリスト

| 変更内容 | 一緒に直すもの |
|----------|---------------|
| 日次 JSON のフィールド追加/改名 | `Article.to_dict()`（または `build.py` の payload）+ `docs/app.js` の描画 + §5 のスキーマ表 |
| `docs/` のシェル資産（html/css/js/manifest） | `sw.js` の `VERSION` をインクリメント |
| `index.html` の要素 id | `app.js` の `el = {…}` |
| 新しい収集ソース | まず `config.json` の `feeds` で試す。コード追加時は `collect_for_keyword()` の `sources` + README の一次情報表 |
| キーワードの増減 | 音声5分枠（`script_gen.MAX_CHARS`）への影響を確認。5個超は避ける |
| Python 依存の追加 | 原則しない。音声以外は標準ライブラリで完結させる（追加するなら `requirements.txt` にコメント付きで） |
| `config.json` の整形 | 設定パネルの保存は `JSON.stringify(json, null, 2)`。2スペースインデント前提で差分を最小に保つ |
| リポジトリ名 / owner の変更 | `app.js` の `GH_OWNER` / `GH_REPO` / `GH_BRANCH`、`index.html` の権限説明文、README |

---

## 8. スコープ外（意図的に作らないもの）

README §スコープにある通り、以下は**提案も実装もしない**（スコープ膨張防止のため明示的に排除されている）:

- ユーザー登録 / ログイン / 認証基盤
- 独立した管理画面（設定は §6-C の2層パネルで完結させる）
- 有料 TTS への乗り換え、その他の有料サービス
- SNS 自動投稿
- キーワード5個超
- 1日複数回の更新
- X（旧 Twitter）の自動収集（API 有料化のため。検索リンクを開くだけに留める）

これらに関わる依頼を受けたときは、まず「0円・静的・スコープ制約」と衝突する点を指摘してから進める。

---

## 9. 日本語について

- **コード内コメント・docstring・コミットメッセージ・UI 文言はすべて日本語**。既存の文体に合わせる。
  これは `mail-assistant/` にも適用される。
- docstring は「何をするか」＋「なぜその実装なのか（無料枠・フォールバック・仕様上の制約）」を書く。
  既存モジュール冒頭の docstring が良い手本。
- コミットメッセージ: 自動生成は `chore: 灯台 daily digest YYYY-MM-DD`。
  手作業の変更は Conventional Commits に縛られず日本語の要約（例:
  `一次情報優先＋アプリ内設定: feeds汎用化・設定パネル・安定性修正`）。
- 識別子（変数・関数・クラス名）は英語のまま。

---

## 10. mail-assistant/（AIメール返信下書きアシスタント）

`sato@sanrikutech.jp` の受信メールから返信要否を判定し、**Gmail の下書きまで**作る仕組み。
**読み取り・判定・起草は Claude Code 自身が Gmail コネクタ経由で行う。**
仕様・設定・運用・脅威モデルは [`mail-assistant/README.md`](mail-assistant/README.md) にある。
ここでは実装時の約束事だけを書く。

### 10-0. 責務の分割（ここを間違えないこと）

| どこ | 何を持つか |
|------|-----------|
| `.claude/skills/mail-assistant/SKILL.md` | **手順と判断基準。** 返信要否の材料、起草ルール |
| `mail-assistant/policy.py` + `guard.py` + `.claude/hooks/gmail_guard.py` | **安全の強制。** Gmail 操作を実行直前に検査する PreToolUse フック |
| `mail-assistant/triage.py` `gate.py` `manifest.py` `ledger.py` | **決定的な処理。** 稼働条件・機械判定・重複排除・実行マニフェスト・履歴 |
| `mail-assistant/config.json` | 唯一の入力。閾値・稼働時間・ラベル名・ドライラン |
| `.claude/settings.json` | `permissions.deny` とフックの登録 |

**判断基準を変えるなら `SKILL.md`、閾値や稼働条件なら `config.json`、安全の規則なら `policy.py`。**
Python 側に「返信が必要か」の判断を書き始めたら設計を間違えている。

### 10-1. 安全性はハーネスで強制する（設計の核）

Gmail コネクタには `send_message` / `reply` / `forward` / `trash_*` が**存在する**。
送信しないことは**モデルの指示遵守ではなく、フックと deny ルールで強制している**。
SKILL.md の安全規則は説明であって、守りの本体ではない。

したがって:

- **安全に関わる確認を SKILL.md の文章だけで済ませない。** 必ずフック（`guard.py`）か CLI で強制する。
  「モデルが守れば安全」という形の変更は入れない
- **送信系の拒否は状態を持たせない。** `guard.decide()` の deny 分岐は設定もマニフェストも読まない。
  設定を改ざんされても送信が開かないことを `test_send_denial_does_not_depend_on_config` が固定している
- **fail closed。** 設定・マニフェスト・ガード本体のどれかが読めなければ Gmail の書き込みを拒否する
- **入口のシム（`.claude/hooks/gmail_guard.py`）の `HARD_DENY` を消さない。** 本体が壊れても送信を止める最後の線
- **安全のテストを弱めて通さない。** `test_guard.py` が落ちたら設計を見直す

### 10-1-2. 通常運用は安いモデル（Haiku）で回す

成立するのは、安全に関わる確認（宛先・重複・インジェクション・dryRun）をコードとフックが担い、
モデルに残るのが「返信が必要か」と「文面」だけだから。**この分担を崩す変更を入れない。**
起草だけは `models.escalateDrafting: true` で強いモデルへ任せられる（SKILL.md 7-B）が、
下書きの作成・ラベル・履歴は呼び出し側が行い、フックの検査はそのまま効く。

### 10-2. 絶対に破ってはならない不変条件

| 不変条件 | 担保 |
|---------|------|
| **メールを送信しない** | `permissions.deny` + フックの deny 分岐 + シムの `HARD_DENY` |
| **削除・アーカイブ・既読化しない** | 削除系は deny。ラベルは付与のみ・ユーザーラベルのみ（`policy.check_label_change`） |
| **`dryRun` 中は Gmail に書き込まない** | フックが gated の書き込みを拒否。`dryRun` は明示的に `false` のときだけ解除 |
| **下書きは triage で承認・inspect 済みのメッセージの送信者1名宛てだけ** | 実行マニフェスト（`manifest.py`）とフックの照合 |
| **downgrade は通常の下書きにならない** | マニフェストの `verdict` をフックが見る |
| **ラベルは `label_message`（メッセージ単位）で付ける** | `label_thread` は deny。続報にもラベルが付き取りこぼすため |
| **ログ・履歴・マニフェストに本文・氏名・アドレスを平文で残さない** | ログは理由コードのみ、履歴はドメインのみ、マニフェストはソルト付きハッシュ |

### 10-3. Gmail コネクタの制約（実データで確認済み・設計の前提）

- **`search_threads` はスレッドの5通しか返さない。** 説明は「古い方」、実際は「新しい方」が返った。
  どちらも前提にせず、4通以上のスレッドは `get_thread` で全体を取るまで判定しない（`needsFullThread`）
- **検索結果にもスレッド取得にも下書きが出ない。** 既存下書きは `list_drafts` で集めて
  `draftThreadIds` として `triage` に渡す（CLI で必須）。失敗時は `draftsUnavailable` で全件降格
- **生ヘッダもカテゴリラベルも返さない。** メルマガ判定の主力は不可視パディング（`BULK_PADDING_RE`）と文言
- **`Reply-To` を返さない。** 下書きの宛先は送信者本人（`triage` の `draftTo`）に固定
- **宛先の大文字小文字が揃っていない**（`SATO@…` が実在）。比較は必ず小文字化
- `search_threads` は `sender` / `toRecipients` / `ccRecipients` を返す。`triage._first()` が
  `from` / `to` / `cc` と両方の名前を受け付ける。ここを壊すと「Cc のみ」判定が効かなくなる
- **処理済みラベルはクエリで除外してよい**（メッセージ単位で付けているため、続報があれば
  スレッドは再び返る）。`label_thread` を使うとこの前提が崩れる
- MCP サーバー名は変わる（`5c3da92a-…` → `Gmail`）。ツールはサーバー名でなくツール名で判定する
- Routine の最小間隔は1時間。要件の10〜15分間隔は満たせない

### 10-4. 開発コマンド（リポジトリルートから実行）

```bash
python -m unittest discover -s mail-assistant -p 'test_*.py'   # すべてのテスト（依存なし）
python mail-assistant/assistant.py gate [--now 2026-10-01T10:00:00+09:00]
python mail-assistant/assistant.py query --done-label-id Label_123
python mail-assistant/assistant.py config
python mail-assistant/assistant.py summary
echo '{"tool_name":"mcp__Gmail__send_message"}' | python3 .claude/hooks/gmail_guard.py   # 拒否されること
```

- **標準ライブラリのみ。** 依存を追加しない（実行環境は使い捨て）。
- フラットな相対 import（`import gate as G`）。リポジトリルートから実行する前提。
- テストは `MAIL_ASSISTANT_STATE_DIR` / `MAIL_ASSISTANT_CONFIG` で一時ディレクトリに向ける。
  **本物の `state/` や `config.json` に書き込むテストを書かない。**
- CI: `.github/workflows/mail-assistant.yml`（`mail-assistant/**` と `.claude/**` の変更時）。

### 10-5. 変更時のチェックリスト

| 変更内容 | 一緒に直すもの |
|----------|---------------|
| 判断基準・起草ルール | `SKILL.md` + README §4/§5 |
| 安全の規則 | `policy.py` + `test_guard.py` + README §3/§13。**弱める方向なら理由を明記** |
| Gmail ツールの追加・改名 | `policy.py` の分類 + `settings.json` の deny + シムの `HARD_DENY`（送信・削除系なら）+ `TestSettings` |
| 設定項目の追加 | `config.json` + `gate.py` の検証と `gate_report()` + README §7 |
| 機械判定の追加 | `triage.py` + README §4-1 + テスト |
| マニフェストの項目 | `manifest.py` の `build()` と `VERSION` + `guard.py` + テスト |
| 履歴のカラム | `ledger.py` の `FIELDS` / `normalize()` + `SKILL.md` 手順10 + テスト |
| CLI の入出力 | `assistant.py` + `SKILL.md` の該当手順 + テスト |
| 稼働スケジュール | Routine の cron（UTC）+ README §8-2。祝日はコード側で判定 |

### 10-6. やらないこと

- **メールの送信**（依頼されても実装しない。まず不変条件との衝突を指摘する）
- 削除・アーカイブ・既読化、既存下書きの書き換え、ラベルを外す操作
- 集計結果のメール送信（ログと Routine の完了通知のみ）
- 別の AI API の呼び出し、Python 依存の追加
- 本文中の URL へのアクセス、添付ファイルの取得・解析・実行
- 安全の確認を SKILL.md の文章だけに頼ること
