"""音声台本生成モジュール。

全キーワード横断のニュースキャスター調ダイジェスト台本を作る。
仕様書§7: オープニング → キーワードごとのハイライト(重要2〜3本) → クロージング。
長さは 1,800字以内を厳守（日本語TTSの実測で約4.5〜5分）。超過時は自動で短縮する。

健康系（PubMed / The Lancet）は「○○が〜と報告」のように出典を必ず添え、断定しない。
"""
from __future__ import annotations

from datetime import datetime, timezone, timedelta

JST = timezone(timedelta(hours=9))
MAX_CHARS = 1800
WEEKDAYS_JP = ["月", "火", "水", "木", "金", "土", "日"]


def build_script(groups: list[dict], date: datetime | None = None) -> str:
    date = date or datetime.now(JST)
    wd = WEEKDAYS_JP[date.weekday()]
    active = [g for g in groups if g["articles"]]
    themes = "、".join(g["keyword"] for g in active) if active else "各テーマ"

    opening = (
        f"{date.month}月{date.day}日、{wd}曜日。灯台です。"
        f"今日の{len(active)}テーマ、{themes}のハイライトをお届けします。"
    )
    closing = "詳しくはアプリの記事カードからどうぞ。今日も良い一日を。"

    # ハイライト本数は、全体が MAX_CHARS に収まるよう段階的に削る
    for per_kw in (3, 2, 1):
        blocks = [_keyword_block(g, per_kw) for g in active]
        body = "".join(blocks)
        script = f"{opening}\n\n{body}\n{closing}"
        if len(script) <= MAX_CHARS:
            return _finalize(script)

    # 1本ずつでも超える場合は要約文を切り詰める
    blocks = [_keyword_block(g, 1, clip=60) for g in active]
    script = f"{opening}\n\n{''.join(blocks)}\n{closing}"
    return _finalize(script[:MAX_CHARS])


def _keyword_block(group: dict, per_kw: int, clip: int | None = None) -> str:
    articles = group["articles"][:per_kw]
    if not articles:
        return ""
    lines = [f"■ {group['keyword']}。"]
    for a in articles:
        # 音声では無音を避けるため、要約が空ならタイトルを読む
        summary = (a.summary or a.title).strip()
        if clip:
            summary = summary[:clip]
        badge = getattr(a, "badge", "")
        if badge in ("PubMed", "The Lancet"):
            # 出典を必ず添える／断定しない言い回し
            lines.append(f"{a.source}によると、{summary}と報告されています。")
        else:
            lines.append(f"{a.source}。{summary}")
    return "".join(lines) + "\n\n"


def _finalize(script: str) -> str:
    # 読み上げで不自然になりやすい記号を整える
    script = script.replace("・", "、").replace("／", "、")
    return script.strip()


def no_news_script(date: datetime | None = None) -> str:
    date = date or datetime.now(JST)
    wd = WEEKDAYS_JP[date.weekday()]
    return (
        f"{date.month}月{date.day}日、{wd}曜日。灯台です。"
        "本日は各テーマとも新しい記事が見つかりませんでした。"
        "また明日、光を当ててお届けします。"
    )


if __name__ == "__main__":
    import json
    import pathlib
    import collect as C
    import summarize as S

    cfg = json.loads((pathlib.Path(__file__).resolve().parents[1] / "config.json").read_text("utf-8"))
    groups = S.summarize_all(C.collect_all(cfg))
    script = build_script(groups)
    print(script)
    print(f"\n--- {len(script)} 字 ---")
