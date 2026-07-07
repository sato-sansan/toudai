# 🗼 灯台（TOUDAI）— 運用費0円デイリーキュレーションPWA

指定キーワードのニュース・記事を毎朝自動収集し、**テキスト一覧＋5分以内の音声ダイジェスト**で届けるサーバーレスPWA。
DB無し・静的ファイル（JSON＋mp3）のみで完結。運用費は原則 **月額0円**。

- **収集**: Google News RSS ＋ PR TIMES全体RSS ＋（健康系）PubMed / The Lancet 公式RSS
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
  "healthFeeds": [                          // （任意）健康系の公式RSS
    "https://www.thelancet.com/rssfeed/lancet_current.xml"
  ],
  "healthFeedFilter": ["nutrition", "vitamin"],  // healthFeedsを英語で絞る
  "pubmedQueries": ["orthomolecular nutrition"]  // （任意）PubMed検索式（英語）
}
```

- **キーワードを増やす場合は5個まで**を目安に。音声5分枠が崩れるので、増やすなら何かを外す。
- 健康系は `pubmedQueries` / `healthFeeds` を付けると査読付き文献が出典バッジ付きで並ぶ。

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

## 🔒 スコープ（触らないこと）

以下はこのアプリ版では**作りません**（スコープ膨張防止）:
ユーザー登録/ログイン、管理画面、有料TTSへの乗り換え、SNS自動投稿、キーワード5個超、1日複数回更新。

---

## 💰 コスト0円の担保

| 用途 | サービス | 無料枠 | 停止時フォールバック |
|------|---------|--------|---------------------|
| 収集 | Google News RSS | キー不要 | 各メディア公式RSSを追加 |
| 健康系文献 | PubMed E-utilities / The Lancet RSS | キー不要・3req/秒 | 相互に切替（どちらも無料） |
| プレスリリース | PR TIMES index.rdf | キー不要 | Google News経由で代替 |
| 要約 | Gemini API 無料枠 | 個人利用で十分 | 抽出型要約（LLM不使用） |
| 音声 | edge-tts | 完全無料 | Web Speech API（ブラウザ内読み上げ） |
| 実行基盤 | GitHub Actions | 公開リポジトリは実質無制限 | — |
| 配信 | GitHub Pages | 無料 | Cloudflare Pages |

**有料サービス・クレジットカード登録が必要なものは一切使っていません。**
