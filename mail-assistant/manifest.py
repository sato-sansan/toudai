"""実行マニフェスト（1回の実行で「何に下書きを作ってよいか」の台帳）。

triage が書き、inspect が更新し、guard（フック）が読む。

これがあることで、フックは create_draft の呼び出しを次の条件で照合できる:
  - 返信先のメッセージが今回 triage で承認されたものか（勝手な宛先への下書きを防ぐ）
  - 宛先が、そのメッセージの送信者本人か（宛先の取り違えを防ぐ）
  - 本文全体のインジェクション検査（inspect）を済ませたか
  - 同じメッセージに2通目の下書きを作ろうとしていないか

プロンプトインジェクションで「全員に返信して」と指示されても、マニフェストに無い
メッセージ・送信者以外の宛先への下書きはハーネスが拒否する。

個人情報の扱い:
  メールアドレスは平文で置かず、実行ごとの乱数ソルト付きハッシュで保存する。
  ファイルは state/run/ 配下（gitignore 済み）に置き、コミットしない。
  暗号学的な秘匿を約束するものではなく、ログや誤コミットでの露出を減らすための措置。
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import os
import pathlib
import secrets
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
# テストでは MAIL_ASSISTANT_STATE_DIR で差し替える（本番の state/ を汚さないため）
STATE_DIR = pathlib.Path(os.environ.get("MAIL_ASSISTANT_STATE_DIR") or ROOT / "mail-assistant" / "state")
RUN_DIR = STATE_DIR / "run"
MANIFEST_PATH = RUN_DIR / "manifest.json"

# これより古いマニフェストは無効（前回の実行の残骸で下書きを作らせない）
TTL = dt.timedelta(hours=3)

VERSION = 1


def _now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def hash_address(address: str, salt: str) -> str:
    """アドレスをソルト付きでハッシュ化する。大文字小文字・前後空白は無視する。"""
    normalized = (address or "").strip().lower()
    return hashlib.sha256(f"{salt}:{normalized}".encode("utf-8")).hexdigest()[:32]


def _atomic_write(path: pathlib.Path, data: dict) -> None:
    """途中で落ちても壊れたファイルを残さない書き込み。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".manifest-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    except BaseException:
        pathlib.Path(tmp).unlink(missing_ok=True)
        raise


def build(entries: list[dict], *, now: dt.datetime | None = None) -> dict:
    """triage の判定結果からマニフェストを作る。

    entries の各要素:
        messageId, threadId, verdict, reasons, senderEmail, ccAllowed(list[str]),
        receivedAt, senderDomain, important
    senderEmail / ccAllowed はここでハッシュ化され、平文は残らない。
    """
    salt = secrets.token_hex(16)
    messages: dict[str, dict] = {}
    for entry in entries:
        message_id = entry.get("messageId")
        if not message_id:
            continue
        messages[message_id] = {
            "threadId": entry.get("threadId", ""),
            "verdict": entry.get("verdict", ""),
            "reasons": list(entry.get("reasons", [])),
            "senderHash": hash_address(entry.get("senderEmail", ""), salt)
            if entry.get("senderEmail")
            else "",
            "ccAllowedHashes": sorted(
                {hash_address(a, salt) for a in entry.get("ccAllowed", []) if a}
            ),
            # inspect（本文全体の検査）を済ませたか。済むまで下書きは作れない。
            "inspected": False,
            # 下書き作成を1回試みたか。同じメッセージへの2通目を防ぐ。
            "draftAttempted": False,
            # 以下は履歴（ledger）を機械的に作るための非個人情報
            "receivedAt": entry.get("receivedAt", ""),
            "senderDomain": entry.get("senderDomain", ""),
            "important": bool(entry.get("important", False)),
        }
    return {
        "version": VERSION,
        "createdAt": (now or _now()).isoformat(),
        "salt": salt,
        "messages": messages,
    }


def write(manifest: dict, path: pathlib.Path | None = None) -> None:
    _atomic_write(path or MANIFEST_PATH, manifest)


def load(
    path: pathlib.Path | None = None, *, now: dt.datetime | None = None
) -> tuple[dict | None, str]:
    """マニフェストを読む。(manifest, 使えない理由) を返す。

    欠落・破損・期限切れ・版違いはすべて None（呼び出し側は安全側に倒す）。
    """
    path = path or MANIFEST_PATH
    if not path.exists():
        return None, "manifest-missing"
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, "manifest-corrupt"
    if not isinstance(data, dict) or data.get("version") != VERSION:
        return None, "manifest-version"
    try:
        created = dt.datetime.fromisoformat(data["createdAt"])
    except (KeyError, TypeError, ValueError):
        return None, "manifest-corrupt"
    if (now or _now()) - created > TTL:
        return None, "manifest-expired"
    if not isinstance(data.get("messages"), dict) or not data.get("salt"):
        return None, "manifest-corrupt"
    return data, ""


def update_entry(message_id: str, changes: dict, path: pathlib.Path | None = None) -> bool:
    """1メッセージ分のエントリを更新する。無ければ False。"""
    path = path or MANIFEST_PATH
    data, _ = load(path)
    if data is None or message_id not in data["messages"]:
        return False
    data["messages"][message_id].update(changes)
    _atomic_write(path, data)
    return True
