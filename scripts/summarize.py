"""要約モジュール。

各記事に 2〜3行の日本語要約と、Text Fragment 用の引用文（jumpUrl）を付与する。
- 第一候補: Gemini API 無料枠（環境変数 GEMINI_API_KEY）
- フォールバック: 抽出型要約（先頭段落＋見出し）。キー未設定・障害・枠超過で自動切替

健康系（badge が PubMed / The Lancet）は断定を避け、出典を明示する要約にする。
"""
from __future__ import annotations

import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request

from collect import Article

# gemini-2.0-flash は無料枠を使い切りやすいため、現行の 2.5-flash を既定に。
# 環境変数 GEMINI_MODEL で上書き可能。
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
HTTP_TIMEOUT = 40
INTER_CALL_SLEEP = 7.0   # 無料枠は約10 req/分。それを下回るよう間隔をあける（毎朝の自動実行なので遅くても問題なし）
MAX_CONSECUTIVE_FAIL = 3  # 連続失敗がこの回数に達したら以降は抽出型で通す（日次クォータ枯渇対策）


def summarize_all(groups: list[dict]) -> list[dict]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    use_gemini = bool(api_key)
    if not use_gemini:
        print("[summarize] GEMINI_API_KEY 未設定 → 抽出型要約にフォールバック")
    else:
        print(f"[summarize] Gemini({GEMINI_MODEL})で要約 → 失敗時は抽出型に自動切替")

    # ラウンドロビン順（各タブの先頭記事→2番目→…）で処理する。
    # 無料枠が途中で尽きても、全タブの上位カード（＝音声にも使う重要記事）に
    # Gemini要約が行き渡るようにするため。
    order = _round_robin_order(groups)

    consecutive_fail = 0
    gemini_ok = 0
    for article in order:
        summary, quote = None, ""
        if use_gemini:
            try:
                summary, quote = _gemini_summary(article, api_key)
                consecutive_fail = 0
                gemini_ok += 1
                time.sleep(INTER_CALL_SLEEP)
            except Exception as exc:
                consecutive_fail += 1
                # 単発の失敗（一時的なレート制限等）では止めず、連続で続いたら諦める
                if consecutive_fail >= MAX_CONSECUTIVE_FAIL:
                    print(f"  [warn] Gemini連続失敗{consecutive_fail}回 → 以降は抽出型: {str(exc)[:80]}")
                    use_gemini = False
                else:
                    print(f"  [warn] Gemini失敗({consecutive_fail}回目、抽出型で補完): {str(exc)[:80]}")
        if not summary:
            summary, quote = _extractive_summary(article)
        article.summary = summary
        article.jump_url = _build_jump_url(article.url, quote)
    if api_key:
        print(f"[summarize] Gemini要約成功 {gemini_ok} 件")
    return groups


def _round_robin_order(groups: list[dict]) -> list[Article]:
    """[kw1[0], kw2[0], …, kw1[1], kw2[1], …] の順に記事を並べる。"""
    lists = [g["articles"] for g in groups]
    order: list[Article] = []
    if not lists:
        return order
    for i in range(max((len(a) for a in lists), default=0)):
        for articles in lists:
            if i < len(articles):
                order.append(articles[i])
    return order


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------
def _gemini_summary(article: Article, api_key: str) -> tuple[str, str]:
    is_health = article.badge in ("PubMed", "The Lancet")
    guidance = (
        "これは査読付き学術文献です。断定的な健康効果を断言せず、"
        "「〜と報告されている」など出典に基づく表現にしてください。"
        if is_health else
        "事実ベースで、煽らず簡潔に要約してください。"
    )
    prompt = (
        "次のニュース記事を日本語で要約してください。\n"
        f"{guidance}\n"
        "出力は必ず次のJSON形式のみ（前後に文章・コードブロックを付けない）:\n"
        '{"summary": "2〜3行の要約", "quote": "本文中から要約の根拠になる連続した一文（20〜60字、原文ママ）"}\n\n'
        f"タイトル: {article.title}\n"
        f"出典: {article.source}\n"
        f"本文抜粋: {article.raw_text[:1500]}\n"
    )
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 1024,
            # gemini-2.5系は既定で「思考」に出力トークンを消費しJSONが途中で切れるため無効化
            "thinkingConfig": {"thinkingBudget": 0},
            "responseMimeType": "application/json",
        },
    }).encode("utf-8")

    data = _post_with_retry(f"{GEMINI_ENDPOINT}?key={urllib.parse.quote(api_key)}", body)
    text = _first_text(data)
    parsed = _extract_json(text)
    summary = _sanitize(parsed.get("summary") or "")
    quote = _sanitize(parsed.get("quote") or "")
    if not summary:
        raise ValueError("空の要約")
    return summary, quote


def _post_with_retry(url: str, body: bytes, retries: int = 2):
    """429（レート制限）は指数バックオフで再試行。その他HTTPエラーは即座に送出。"""
    delay = 8
    for attempt in range(retries + 1):
        req = urllib.request.Request(
            url, data=body, headers={"Content-Type": "application/json"}, method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(delay)
                delay *= 2
                continue
            raise


def _first_text(data: dict) -> str:
    cand = (data.get("candidates") or [{}])[0]
    parts = cand.get("content", {}).get("parts", [])
    return "".join(p.get("text", "") for p in parts)


def _extract_json(text: str) -> dict:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    # 完全なJSONを試す
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    # 途中で切れた場合でも summary / quote フィールドだけ拾う
    sm = re.search(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    qm = re.search(r'"quote"\s*:\s*"((?:[^"\\]|\\.)*)"', text)
    if sm:
        def unesc(s):
            # unicode_escape はマルチバイト（日本語）文字列を化けさせるため使わない。
            # JSON文字列として再パースし、失敗時は無加工のまま返す。
            if "\\" not in s:
                return s
            try:
                return json.loads(f'"{s}"')
            except json.JSONDecodeError:
                return s
        return {"summary": unesc(sm.group(1)), "quote": unesc(qm.group(1)) if qm else ""}
    # JSON片も拾えないときは空（呼び出し側が抽出型にフォールバック）
    return {"summary": "", "quote": ""}


def _sanitize(s: str) -> str:
    """要約に混入しがちなJSON断片・改行を除去して読める1〜2文にする。"""
    s = (s or "").strip()
    # 生JSONが紛れ込んだ場合の保険
    if s.startswith("{") and '"summary"' in s:
        m = re.search(r'"summary"\s*:\s*"((?:[^"\\]|\\.)*)"', s)
        s = m.group(1) if m else ""
    return re.sub(r"\s*\n\s*", " ", s).strip()


# ---------------------------------------------------------------------------
# 抽出型フォールバック
# ---------------------------------------------------------------------------
def _extractive_summary(article: Article) -> tuple[str, str]:
    # Google News の description は本文冒頭にタイトル＋出典を含むだけのことが多い。
    # その場合はタイトル/出典を取り除き、実質本文が残るときだけ要約とする。
    body = _strip_title_and_source(article)
    sentences = _split_sentences(body)
    summary = "".join(sentences[:2]).strip()[:120]
    quote = sentences[0][:60] if sentences else ""
    # 実質本文が乏しい（＝要約材料なし）ときは空にしてカードで非表示にする
    if len(re.sub(r"\s+", "", summary)) < 8:
        summary = ""
    return summary, quote


def _strip_title_and_source(article: Article) -> str:
    text = (article.raw_text or "").strip()
    if not text:
        return ""
    norm = lambda s: re.sub(r"\s+", "", s)
    text_n = norm(text)
    title_n = norm(article.title)
    # タイトルを含むならその後ろだけを本文候補にする
    if title_n and title_n in text_n:
        # 元テキスト側でタイトル相当を境に後半を取る（正規化位置を近似）
        idx = text.find(article.title[:12]) if len(article.title) >= 12 else text.find(article.title)
        if idx != -1:
            text = text[idx + len(article.title):]
    # 末尾/先頭に残りがちな出典名を除去
    if article.source:
        text = text.replace(article.source, " ")
    return re.sub(r"\s+", " ", text).strip(" 　-–—:：|｜")


def _split_sentences(text: str) -> list[str]:
    parts = re.split(r"(?<=[。！？!?])", text)
    return [p.strip() for p in parts if p.strip()]


# ---------------------------------------------------------------------------
# Text Fragments 用 jumpUrl
# ---------------------------------------------------------------------------
def _build_jump_url(url: str, quote: str) -> str:
    """要約根拠の引用文で #:~:text= 付きURLを作る。作れなければ url をそのまま返す。"""
    if not url:
        return url
    quote = re.sub(r"\s+", " ", quote or "").strip()
    # 記号・引用符など Text Fragment が不安定になりやすい文字を落とす
    quote = quote.strip("　「」『』\"'（）()[]【】…・")
    if len(quote) < 6:
        return url
    if "#" in url:  # 既にフラグメントがあるURLには足さない
        return url
    encoded = urllib.parse.quote(quote[:60], safe="")
    return f"{url}#:~:text={encoded}"


if __name__ == "__main__":
    import pathlib
    import collect as C

    cfg = json.loads((pathlib.Path(__file__).resolve().parents[1] / "config.json").read_text("utf-8"))
    groups = C.collect_all(cfg)
    groups = summarize_all(groups)
    for g in groups:
        print(f"\n=== {g['keyword']} ===")
        for a in g["articles"][:3]:
            print(f"- {a.title}\n    要約: {a.summary}\n    jump: {a.jump_url}")
