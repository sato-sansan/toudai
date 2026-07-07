"""音声生成モジュール（edge-tts / 無料）。

台本テキストから mp3 を生成する。失敗（ネットワーク・仕様変更・edge-tts不在）時は
None を返してスキップし、フロントの Web Speech API 読み上げに委ねる。
生成後に音声長を検証し、5分（300秒）を超えていたら失敗扱いにする。
"""
from __future__ import annotations

import asyncio
import pathlib

VOICE = "ja-JP-NanamiNeural"
RATE = "+0%"
MAX_SECONDS = 300  # 5分厳守


def synthesize(script: str, out_path: str | pathlib.Path) -> bool:
    """mp3 を生成できたら True。失敗時は False（フロントの読み上げに委ねる）。"""
    out_path = pathlib.Path(out_path)
    try:
        import edge_tts  # type: ignore
    except ImportError:
        print("[tts] edge-tts 未インストール → 音声生成スキップ（ブラウザ読み上げに委ねる）")
        return False

    try:
        asyncio.run(_run(edge_tts, script, out_path))
    except Exception as exc:
        print(f"[tts] 生成失敗 → スキップ: {exc}")
        _cleanup(out_path)
        return False

    if not out_path.exists() or out_path.stat().st_size < 1024:
        print("[tts] 生成物が不正 → スキップ")
        _cleanup(out_path)
        return False

    seconds = _estimate_duration(out_path)
    if seconds is not None and seconds > MAX_SECONDS:
        print(f"[tts] {seconds:.0f}秒で5分超過 → 破棄（台本短縮側で対処）")
        _cleanup(out_path)
        return False

    print(f"[tts] 生成成功: {out_path.name}"
          + (f"（約{seconds:.0f}秒）" if seconds is not None else ""))
    return True


async def _run(edge_tts, script: str, out_path: pathlib.Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    communicate = edge_tts.Communicate(script, VOICE, rate=RATE)
    await communicate.save(str(out_path))


def _estimate_duration(path: pathlib.Path) -> float | None:
    """mutagen があれば正確な長さを、なければ None（検証スキップ）。"""
    try:
        from mutagen.mp3 import MP3  # type: ignore
        return float(MP3(str(path)).info.length)
    except Exception:
        return None


def _cleanup(path: pathlib.Path) -> None:
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


if __name__ == "__main__":
    ok = synthesize("これは灯台の音声テストです。今日も良い一日を。", "test.mp3")
    print("結果:", ok)
