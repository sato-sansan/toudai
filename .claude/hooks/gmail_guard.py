#!/usr/bin/env python3
"""PreToolUse フックの入口（mail-assistant の Gmail ガード）。

本体は mail-assistant/guard.py。ここは入口に徹する薄いシムで、次の2点だけを保証する:

  1. 送信・返信・転送・削除系は、本体を読み込む**前に**ここで拒否する。
     本体に不具合があって import できなくても、送信だけは絶対に通さない。
  2. 本体が読み込めないときは、Gmail の書き込み系を拒否する（fail closed）。
     Gmail 以外のツールには干渉しない。

入力を解釈できない場合は終了コード 2（ツール実行をブロック）で返す。
"""
import json
import os
import pathlib
import sys

# policy.ALWAYS_DENY のうち、誤送信・データ消失に直結するものの最小集合。
# 本体と二重に持つのは意図的（本体が壊れても効くようにするため）。
HARD_DENY = {
    "send_message",
    "send_draft",
    "reply",
    "reply_all",
    "forward",
    "trash_message",
    "trash_thread",
    "delete_message",
    "delete_thread",
    "delete_draft",
    "mark_message_spam",
    "mark_thread_spam",
}
GMAIL_WRITES = {"create_draft", "label_message", "update_message_labels", "create_label"}


def _root() -> pathlib.Path:
    return pathlib.Path(os.environ.get("CLAUDE_PROJECT_DIR") or pathlib.Path(__file__).resolve().parents[2])


def _audit(tool: str, code: str) -> None:
    """ここで拒否したものも監査ログに残す（本体を読み込まずに書く）。

    送信の試みこそ記録すべき出来事なので、本体に届く前に止めた場合も必ず残す。
    書式は guard._log と揃える。引数（宛先・本文）は残さない。失敗しても判定は変えない。
    """
    try:
        import datetime

        state = pathlib.Path(os.environ.get("MAIL_ASSISTANT_STATE_DIR") or _root() / "mail-assistant" / "state")
        log = state / "run" / "guard.log"
        log.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "tool": tool,
            "kind": "deny",
            "decision": "deny",
            "codes": [code],
        }
        with log.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 - 監査の失敗で拒否を取り消さない
        pass


def _deny(reason: str) -> None:
    sys.stdout.write(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": f"[mail-assistant guard] {reason}",
                }
            },
            ensure_ascii=False,
        )
    )
    sys.exit(0)


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
    except (json.JSONDecodeError, ValueError):
        print("[mail-assistant guard] フック入力を解釈できないため拒否", file=sys.stderr)
        sys.exit(2)

    tool_name = str(payload.get("tool_name", ""))
    base = tool_name.split("__")[-1] if tool_name.startswith("mcp__") else ""

    if base in HARD_DENY:
        _audit(base, "forbidden-tool")
        _deny(f"{base} は実行しない。メールの送信・削除は必ず人間が Gmail で行う")

    sys.path.insert(0, str(_root() / "mail-assistant"))
    try:
        import guard  # noqa: PLC0415
    except Exception as exc:  # 本体が壊れていても書き込みは通さない
        if base in GMAIL_WRITES or "gmail" in tool_name.lower():
            _audit(base, "guard-unavailable")
            _deny(f"ガード本体を読み込めないため Gmail の書き込みを拒否（{type(exc).__name__}）")
        sys.exit(0)

    sys.exit(guard.run(payload))


if __name__ == "__main__":
    main()
