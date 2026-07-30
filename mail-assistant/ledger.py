"""処理履歴（JSONL）。

保存先をリポジトリ内のファイルにしている理由:
  実行環境（Claude Code のセッション）は使い捨てで、コンテナは回収される。
  履歴を残すにはリポジトリへコミットするのが最も確実で、git 履歴が監査ログにもなる。

保存しないもの: 本文、件名、氏名、メールアドレスの局所部。
残すのは ID・ドメイン・判定結果だけ。
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
LEDGER_PATH = ROOT / "mail-assistant" / "state" / "ledger.jsonl"

FIELDS = (
    "processedAt",
    "messageId",
    "threadId",
    "receivedAt",
    "classification",
    "confidence",
    "action",
    "draftId",
    "error",
    "model",
    "important",
    "injectionSuspected",
    "senderDomain",
    "reasonCode",
    "attempts",
)

CLASSIFICATIONS = ("REPLY_REQUIRED", "NO_REPLY_REQUIRED", "REVIEW_REQUIRED")

# 理由コードに個人情報が混じらないよう長さを絞る
MAX_REASON_CHARS = 120


class LedgerError(ValueError):
    pass


def _redact(text: str) -> str:
    """念のためメールアドレスと電話番号を伏せる。"""
    import re

    text = re.sub(
        r"[\w.+-]+@([\w-]+(?:\.[\w-]+)+)",
        lambda m: f"***@{m.group(1)}",
        text or "",
    )
    text = re.sub(r"(?:\+81|0)\d{1,4}[-(\s]?\d{2,4}[-)\s]?\d{3,4}", "[電話番号]", text)
    return " ".join(text.split())


def normalize(record: dict, previous: dict | None = None) -> dict:
    """1レコードを検証・正規化する。不正なら例外。"""
    message_id = str(record.get("messageId", "")).strip()
    if not message_id:
        raise LedgerError("messageId は必須です")

    classification = str(record.get("classification", "")).strip()
    if classification not in CLASSIFICATIONS:
        raise LedgerError(
            f"classification は {' / '.join(CLASSIFICATIONS)} のいずれかにしてください"
            f"（受け取った値: {classification!r}）"
        )

    try:
        confidence = float(record.get("confidence", 0))
    except (TypeError, ValueError) as exc:
        raise LedgerError("confidence は数値にしてください") from exc
    if not 0.0 <= confidence <= 1.0:
        raise LedgerError(f"confidence は 0〜1 にしてください（受け取った値: {confidence}）")

    reason = _redact(str(record.get("reasonCode", "")))[:MAX_REASON_CHARS]
    attempts = 1 if previous is None else int(previous.get("attempts", 1)) + 1

    return {
        "processedAt": record.get("processedAt") or dt.datetime.now(
            dt.timezone(dt.timedelta(hours=9))
        ).isoformat(timespec="seconds"),
        "messageId": message_id,
        "threadId": str(record.get("threadId", "")),
        "receivedAt": str(record.get("receivedAt", "")),
        "classification": classification,
        "confidence": round(confidence, 3),
        "action": str(record.get("action", "log-only")),
        "draftId": str(record.get("draftId", "")),
        "error": _redact(str(record.get("error", "")))[:MAX_REASON_CHARS],
        "model": str(record.get("model", "")),
        "important": bool(record.get("important", False)),
        "injectionSuspected": bool(record.get("injectionSuspected", False)),
        "senderDomain": str(record.get("senderDomain", "")),
        "reasonCode": reason,
        "attempts": attempts,
    }


def load(path: pathlib.Path | None = None) -> list[dict]:
    """全レコードを古い順に返す。壊れた行は読み飛ばす（実行を止めない）。"""
    path = path or LEDGER_PATH
    if not path.exists():
        return []
    out: list[dict] = []
    for line in path.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and parsed.get("messageId"):
            out.append(parsed)
    return out


def processed_map(path: pathlib.Path | None = None) -> dict[str, dict]:
    """messageId → 最新レコード。重複排除の判定に使う。"""
    result: dict[str, dict] = {}
    for record in load(path):
        result[record["messageId"]] = record
    return result


def append(records: list[dict], path: pathlib.Path | None = None) -> list[dict]:
    """レコードを追記する。同一 messageId の再処理は attempts を増やす。"""
    path = path or LEDGER_PATH
    existing = processed_map(path)
    normalized = [normalize(r, existing.get(str(r.get("messageId", "")))) for r in records]
    if not normalized:
        return []
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        for record in normalized:
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return normalized


def records_for_date(iso_date: str, path: pathlib.Path | None = None) -> list[dict]:
    """指定日（現地時刻の YYYY-MM-DD）の処理分。"""
    return [r for r in load(path) if str(r.get("processedAt", "")).startswith(iso_date)]
