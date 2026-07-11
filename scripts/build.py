"""日次ビルドのオーケストレーター。

  収集 → 要約 → 台本 → 音声 → 出力(JSON/mp3) → 古いファイル削除

GitHub Actions から毎朝6:00 JSTに実行される。各段は失敗しても後段に進み、
最終的に data/YYYY-MM-DD.json（＋あれば audio/YYYY-MM-DD.mp3）を必ず書き出す。
"""
from __future__ import annotations

import json
import pathlib
import sys
from datetime import datetime, timezone, timedelta

import collect as C
import summarize as S
import script_gen as G
import tts as T

JST = timezone(timedelta(hours=9))
ROOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
DATA_DIR = DOCS / "data"
AUDIO_DIR = DOCS / "audio"
RETENTION_DAYS = 8  # 8日以上前を削除（過去7日アーカイブを維持）


def main() -> int:
    date = datetime.now(JST)
    date_str = date.strftime("%Y-%m-%d")
    print(f"=== 灯台ビルド {date_str} ===")

    config = json.loads((ROOT / "config.json").read_text("utf-8"))

    # 1. 収集
    groups = C.collect_all(config)

    # 2. 要約（Gemini or 抽出型フォールバック）
    groups = S.summarize_all(groups)

    total = sum(len(g["articles"]) for g in groups)
    print(f"[build] 総記事数: {total}")

    # 3. 台本
    if total > 0:
        script = G.build_script(groups, date)
    else:
        script = G.no_news_script(date)
    print(f"[build] 台本 {len(script)} 字")

    # 4. 音声（失敗時は None のままフロントの読み上げに委ねる）
    audio_rel = None
    audio_path = AUDIO_DIR / f"{date_str}.mp3"
    if T.synthesize(script, audio_path):
        audio_rel = f"audio/{date_str}.mp3"

    # 5. 出力
    payload = {
        "date": date_str,
        "generatedAt": date.isoformat(),
        "audioUrl": audio_rel,          # null のときフロントは Web Speech API を使う
        "audioScript": script,          # 常に含める（読み上げフォールバック用）
        "keywords": [
            {"keyword": g["keyword"], "articles": [a.to_dict() for a in g["articles"]]}
            for g in groups
        ],
    }
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_json = DATA_DIR / f"{date_str}.json"
    out_json.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
    print(f"[build] 出力: {out_json.relative_to(ROOT)}")

    # 6. 古いファイル削除（index.json に削除済み日付が残らないよう、index生成の前に行う）
    _cleanup_old(date)

    _write_index(date_str)

    print("=== 完了 ===")
    return 0


def _write_index(latest_date: str) -> None:
    """フロントが最新日と利用可能な日付一覧を知るための index.json。"""
    dates = sorted(
        (p.stem for p in DATA_DIR.glob("*.json") if p.stem != "index"),
        reverse=True,
    )
    if latest_date not in dates:
        dates.insert(0, latest_date)
    (DATA_DIR / "index.json").write_text(
        json.dumps({"latest": latest_date, "dates": dates}, ensure_ascii=False, indent=2),
        "utf-8",
    )


def _cleanup_old(today: datetime) -> None:
    cutoff = (today - timedelta(days=RETENTION_DAYS)).date()
    removed = 0
    for directory, suffix in ((DATA_DIR, ".json"), (AUDIO_DIR, ".mp3")):
        for path in directory.glob(f"*{suffix}"):
            if path.stem == "index":
                continue
            try:
                d = datetime.strptime(path.stem, "%Y-%m-%d").date()
            except ValueError:
                continue
            if d < cutoff:
                path.unlink()
                removed += 1
    if removed:
        print(f"[build] 古いファイル {removed} 件削除（{RETENTION_DAYS}日より前）")


if __name__ == "__main__":
    sys.exit(main())
