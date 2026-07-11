# 🗼 灯台（TOUDAI）— 運用費0円デイリーキュレーションPWA

指定キーワードのニュース・記事を毎朝自動収集し、**テキスト一覧＋5分以内の音声ダイジェスト**で届けるサーバーレスPWA。
DB無し・静的ファイル（JSON＋mp3）のみで完結。運用費は原則 **月額0円**。

- **収集**: Google News RSS（二次情報）＋ PR TIMES全体RSS ＋ config.json の `feeds` に登録した
  一次情報RSS（公式・政府・査読誌・ベンダー直）＋（健康系）PubMed。**一次情報を二次情報より優先表示**
- **要約**: Gemini API 無料枠。未設定・障害時は抽出型要約へ自動フォールバック
- **音声**: edge-tts（無料）でmp3生成。失敗時はブラウザのWeb Speech APIで読み上げ
- **配信**: GitHub Pages（無料）。毎朝6:00 JSTに GitHub Actions が自動更新

---

## 📁 ディレクトリ構成

```
toudai/
├── config.json                  # キーワード定義（ここだけ編集すればOK）
├── docs/                        # GitHub Pages 公開ディレクトリ
│   ├── index.html / app.js / style.css
│   ├── manifest.json / sw.js / icon.svg / icon-192.png / icon-512.png
│   ├── data/YYYY-MM-DD.json     # 日次データ（自動生成）
│   └── audio/YYYY-MM-DD.mp3     # 日次音声（自動生成）
├── scripts/                     # パイプライン（Python）
│   ├── collect.py               # 収集（プラグイン構造：ソース追加が容易）
│   ├── summarize.py             # 要約＋Text Fragment引用抽出
│   ├── script_gen.py            # 音声台本生成（1,800字以内厳守）
│   ├── tts.py                   # edge-ttsでmp3生成（5分超過は破棄）
│   ├── build.py                 # 上記を順に実行するオーケストレーター
│   └── requirements.txt
└── .github/workflows/daily.yml  # 毎朝6:00 JST cron
```

---

## ✏️ キーワードの変え方

`config.json` の `keywords` を編集して push するだけ。**翌朝の自動更新から反映**されます（管理画面はありません）。

```jsonc
{
  "label": "気仙沼",                       // タブ表示名
  "queries": ["気仙沼"],                    // 検索語（類義語を並べると幅が広がる）
  "exclude": ["占い", "広告PR"],            // タイトル/本文に含むと除外
  "feeds": [                                // （任意）一次情報の公式RSS/RDF/Atomフィード
    {
      "name": "気仙沼市公式",               // 表示名（source欄に使う）
      "url": "https://www.kesennuma.miyagi.jp/news.rss",
      "badge": "市公式",                    // カードに出すバッジ文言
      "primary": true,                      // true=一次情報。カードに「一次」チップが付く
      "filter": ["栄養", "食品"],           // （任意）title/descの小文字部分一致OR。省略可
      "maxItems": 3                         // このフィードから採用する件数（省略時3）
    }
  ],
  "pubmedQueries": ["orthomolecular nutrition"]  // （任意）PubMed検索式（英語）
}
```

- **キーワードを増やす場合は5個まで**を目安に。音声5分枠が崩れるので、増やすなら何かを外す。
- `feeds` は何個でも追加可。**7日より古い記事は自動的に除外**される（フィードによっては
  過去記事を大量に含むため）。一次情報（`primary: true`）は二次情報（Google News）より
  常に上位に並ぶ。
- 健康系は `pubmedQueries` を付けると査読付き文献が出典バッジ付きで並ぶ（PubMedは常に一次情報扱い）。

---

## 🚀 デプロイ手順（初回のみ）

1. **リポジトリ作成**: このフォルダをGitHubに push
   ```bash
   cd toudai
   git init && git add . && git commit -m "init 灯台"
   git branch -M main
   git remote add origin https://github.com/<あなた>/toudai.git
   git push -u origin main
   ```
2. **GitHub Pages を有効化**: リポジトリ Settings → Pages →
   Source を「Deploy from a branch」、Branch を `main` / `/docs` に設定
3. **（任意）Gemini APIキー**: 日本語要約の質を上げたい場合のみ。
   Settings → Secrets and variables → Actions → New repository secret →
   Name: `GEMINI_API_KEY` / Value: 取得したキー（[無料枠](https://aistudio.google.com/apikey)）
   ※未設定でも動きます（抽出型要約にフォールバック）。
   ※既定モデルは `gemini-2.5-flash`。無料枠のレート制限（約10 req/分）に合わせて
   記事ごとに間隔を空けるため、要約段は数分かかります（毎朝の自動実行なので支障なし）。
   別モデルにしたい場合は secret / env `GEMINI_MODEL` で上書き可。
4. **初回ビルド**: Actions タブ → 「灯台 daily build」→ Run workflow で手動実行
5. **スマホで開く**: `https://<あなた>.github.io/toudai/` を開き、
   Safari共有メニュー →「ホーム画面に追加」でアプリ化

> **非公開にしたい場合**: 公開リポジトリ＝アプリURLも実質公開になります。
> 気になる場合は Cloudflare Pages（無料・privateリポジトリ可）に差し替え可能（構成は同一。docs/ を出力ディレクトリに指定するだけ）。

### ローカルで試す
```bash
pip install -r scripts/requirements.txt
python scripts/build.py          # data/ と audio/ を生成
python -m http.server --directory docs 4173
# → http://localhost:4173/ を開く
```

---

## 🛠 壊れたときの見方

| 症状 | 見るところ | 対処 |
|------|-----------|------|
| 朝に更新されない | GitHub → Actions → 最新の実行が赤 | ログを開き失敗ステップを確認。多くはRSS一時障害なので再実行(Run workflow)で回復 |
| 記事が0件の日がある | そのキーワードにその日ニュースが無いだけ | 正常。カードは「本日、該当なし」表示になる |
| 要約が英語/タイトルのまま | `GEMINI_API_KEY` 未設定 or 無料枠超過 | 抽出型フォールバック中。キー設定で日本語要約に。PubMedのabstractは元が英語 |
| 音声が出ない/mp3が無い日 | 再生ボタン横に「読み上げ」と出る | edge-tts障害時の自動フォールバック（ブラウザ読み上げ）。異常ではない |
| 音声が5分を超える | tts.pyが破棄してmp3を作らない | 台本短縮ロジックが働く。キーワードを減らすと安定 |
| 「Xで最新を見る」だけ更新されない | 仕様 | X(旧Twitter)はAPI有料化のため自動収集せず、検索リンクを開くだけ（0円維持） |

### 障害時の通知
GitHub Actions が失敗すると、リポジトリ通知設定に応じて**失敗通知メール**が届きます。
気づいたときに Actions を再実行すればOK（メンテ工数：月0時間目標）。

---

## ⚙️ アプリ内の設定パネル（キーワードの変更・並び替え）

ヘッダー右上の ⚙️ から開く。管理画面を新設せず、静的PWAのまま2層で実現している。

### A. 並び替え・表示/非表示（この端末だけ・即時反映）
- 各キーワードの行で「↑」「↓」ボタンによる並び替え、チェックボックスで表示/非表示を切り替え
- 設定は端末の `localStorage`（キー: `toudai.kwPrefs`）に保存されるだけなので、
  **トークン不要・オフラインでも動く**。他の端末やブラウザには反映されない
- config.json 側にタブ設定に無い新規キーワードが増えても、末尾に自動追加されて表示される（壊れない）

### B. キーワードの追加・編集・削除（config.json をGitHub経由で書き換え）
反映は翌朝6時の自動更新（`git push` は発生させず、GitHub Contents API 経由でリポジトリに直接コミットする）。

1. **GitHub Fine-grained PAT を作る**:
   GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens →
   Generate new token
   - Repository access: `sato-sansan/toudai` のみを選択
   - Permissions: **Contents: Read and write**、**Actions: Read and write**
2. 設定パネルの「収集キーワードの編集」欄にトークンを貼って保存
   （**端末内の localStorage にのみ保存**。サーバーには送信されない）
3. キーワードの追加（タブ名・検索語カンマ区切り・除外語カンマ区切り）、既存の編集、削除ができる。
   「config.jsonに保存」で GitHub に直接コミットされる
   （commit message: `config: キーワード変更（アプリから）`）
4. 保存後に「今すぐ更新を実行」を押すと GitHub Actions の daily workflow を手動起動でき、
   数分後には最新記事に更新される（押さなければ翌朝6時に自動反映）

**安全策**:
- `feeds` / `pubmedQueries` / `filter` など、パネルが編集しないフィールドは常にそのまま保持される
  （label / queries / exclude / 並び順だけを書き換える）
- 保存時に他の変更と衝突（HTTP 409）した場合は、最新版を1回だけ自動的に取り直して再送する
- 401 / 403 / 404 / 409 はそれぞれ日本語のエラーメッセージで表示される

---

## 🔒 スコープ（触らないこと）

以下はこのアプリ版では**作りません**（スコープ膨張防止）:
ユーザー登録/ログイン、管理画面、有料TTSへの乗り換え、SNS自動投稿、キーワード5個超、1日複数回更新。

---

## 💰 コスト0円の担保

| 用途 | サービス | 無料枠 | 停止時フォールバック |
|------|---------|--------|---------------------|
| 収集（二次情報） | Google News RSS | キー不要 | 各メディア公式RSSを追加 |
| 収集（一次情報） | config.json の `feeds`（気仙沼市公式 / 厚労省 / The Lancet / Nature / OpenAI / Google AI / DeepMind / Hugging Face / Reddit 等） | キー不要 | ソース障害は個別に握りつぶし、他ソースは生きる |
| 健康系文献 | PubMed E-utilities | キー不要・3req/秒 | The Lancet / Nature RSSと相互補完（どちらも無料） |
| プレスリリース | PR TIMES index.rdf | キー不要 | Google News経由で代替 |
| 要約 | Gemini API 無料枠 | 個人利用で十分 | 抽出型要約（LLM不使用） |
| 音声 | edge-tts（失敗時は5秒→15秒の間隔で最大3回リトライ） | 完全無料 | Web Speech API（ブラウザ内読み上げ） |
| 実行基盤 | GitHub Actions | 公開リポジトリは実質無制限 | — |
| 配信 | GitHub Pages | 無料 | Cloudflare Pages |

### 🥇 一次情報ソース一覧（`primary: true`）

| キーワード | ソース | badge |
|-----------|--------|-------|
| 気仙沼 | 気仙沼市公式RSS | 市公式 |
| 分子栄養 | 厚生労働省 news.rdf | 厚労省 |
| 分子栄養 | The Lancet | The Lancet |
| 分子栄養 | Nature | Nature |
| 分子栄養 | PubMed | PubMed |
| AI | OpenAI news | OpenAI |
| AI | Google AI Blog | Google AI |
| AI | DeepMind Blog | DeepMind |
| AI | Hugging Face Blog | Hugging Face |

ハンドパンの Reddit r/handpan は二次的なコミュニティソースのため `primary: false`。
カード上は一次情報に「一次」チップが付き、Google News等の二次情報と区別できる。

**有料サービス・クレジットカード登録が必要なものは一切使っていません。**
