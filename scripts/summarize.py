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
import urllib.parse
import urllib.request

from collect import Article

GEMINI_MODEL = "gemini-2.0-flash"
GEMINI_ENDPOINT = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"{GEMINI_MODEL}:generateContent"
)
HTTP_TIMEOUT = 30


def summarize_all(groups: list[dict]) -> list[dict]:
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    use_gemini = bool(api_key)
    if not use_gemini:
        print("[summarize] GEMINI_API_KEY 未設定 → 抽出型要約にフォールバック")

    for group in groups:
        for article in group["articles"]:
            summary, quote = None, ""
            if use_gemini:
                try:
                    summary, quote = _gemini_summary(article, api_key)
                except Exception as exc:
                    print(f"  [warn] Gemini失敗 → 抽出型に切替: {exc}")
                    use_gemini = False  # 一度失敗したら以降は抽出型で通す（枠超過対策）
            if not summary:
                summary, quote = _extractive_summary(article)
            article.summary = summary
            article.jump_url = _build_jump_url(article.url, quote)
    return groups


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
        "出力は必ず次のJSON形式のみ（前後に文章を付けない）:\n"
        '{"summary": "2〜3行の要約", "quote": "本文中から要約の根拠になる連続した一文（20〜60字、原文ママ）"}\n\n'
        f"タイトル: {article.title}\n"
        f"出典: {article.source}\n"
        f"本文抜粋: {article.raw_text[:1500]}\n"
    )
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 512},
    }).encode("utf-8")

    url = f"{GEMINI_ENDPOINT}?key={urllib.parse.quote(api_key)}"
    req = urllib.request.Request(
        url, data=body, headers={"Content-Type": "application/json"}, method="POST"
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        data = json.loads(resp.read())

    text = data["candidates"][0]["content"]["parts"][0]["text"]
    parsed = _extract_json(text)
    summary = (parsed.get("summary") or "").strip()
    quote = (parsed.get("quote") or "").strip()
    if not summary:
        raise ValueError("空の要約")
    return summary, quote


def _extract_json(text: str) -> dict:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    m = re.search(r"\{.*\}", text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group())
        except json.JSONDecodeError:
            pass
    return {"summary": text[:120], "quote": ""}


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
