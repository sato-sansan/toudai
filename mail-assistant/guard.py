"""Gmail 操作のガード（Claude Code の PreToolUse フック本体）。

`.claude/settings.json` に登録した PreToolUse フックから、すべての MCP ツール呼び出しの
直前に呼ばれる。Gmail 以外のツールには干渉しない。

判定:
  deny          … 送信・返信・転送・削除・迷惑メール化・既存下書き改変。無条件に拒否
  gated         … 下書き作成・ラベル付与・ラベル作成。下記を満たすときだけ許可
  read          … 読み取り。常に許可
  unknown-gmail … Gmail の未知のツール。安全側に倒して拒否（fail closed）

gated の条件（create_draft）:
  1. config.json の dryRun が false
  2. 添付・HTML 本文・Bcc を使っていない
  3. replyToMessageId があり、実行マニフェストで承認済みのメッセージ
  4. そのメッセージの本文全体を inspect 済み
  5. To がそのメッセージの送信者1名のみ。Cc は ccMode に従う
  6. 本文が policy.check_draft_body を満たす
  7. 同じメッセージへの2通目ではない

モデルが SKILL.md の手順を読み飛ばしても、プロンプトインジェクションで
指示を書き換えられても、ここを通らない操作は実行されない。

送信系の拒否は設定もマニフェストも読まない（状態を持たない）。
設定ファイルやマニフェストを書き換えられても、開くのはせいぜい「下書き」までで、
送信は開かない。この性質はテストで固定している。

出力は Claude Code のフック仕様に従う:
  許可 … 何も出力せず終了コード 0（通常の権限判定に委ねる。勝手に allow しない）
  拒否 … permissionDecision=deny の JSON を出力して終了コード 0
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from dataclasses import dataclass

import manifest as M
import policy as P

GUARD_LOG = M.RUN_DIR / "guard.log"


@dataclass(frozen=True)
class Decision:
    allow: bool
    kind: str
    tool: str
    reason: str = ""
    codes: tuple[str, ...] = ()


def _codes(verdict: P.Verdict) -> tuple[str, ...]:
    return tuple(v.split(":", 1)[0] for v in verdict.violations)


def _deny(kind: str, tool: str, verdict: P.Verdict) -> Decision:
    return Decision(False, kind, tool, verdict.reason(), _codes(verdict))


def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value else []
    return [str(v) for v in value if v]


def _configured_labels(config: dict) -> set[str]:
    names = {v for v in (config.get("labels") or {}).values() if v}
    if config.get("testLabel"):
        names.add(config["testLabel"])
    return names


def check_create_draft(tool_input: dict, config: dict, manifest: dict | None, why: str) -> P.Verdict:
    """create_draft の検査（dryRun 以外）。assistant.py vet からも呼ばれる。"""
    verdict = P.Verdict()

    if tool_input.get("attachments"):
        verdict.add("attachments-forbidden", "添付ファイルは付けない")
    if tool_input.get("htmlBody"):
        # HTML 本文は body の検査をすり抜けられるので使わせない
        verdict.add("html-body-forbidden", "htmlBody は使わず body（プレーンテキスト）のみ")

    reply_to = tool_input.get("replyToMessageId") or ""
    if not reply_to:
        verdict.add("not-a-reply", "replyToMessageId が無い（新規メールの下書きは作らない）")
        return verdict

    if manifest is None:
        verdict.add(why or "manifest-missing", "triage を実行して実行マニフェストを作ってから")
        return verdict

    entry = manifest["messages"].get(reply_to)
    if entry is None:
        verdict.add("not-triaged", "このメッセージは今回の triage で承認されていない")
        return verdict

    body = tool_input.get("body") or ""
    is_review_draft = body.lstrip().startswith(P.REVIEW_NOTICE)
    verdict_kind = entry.get("verdict")

    if verdict_kind == "skip":
        verdict.add("triaged-as-skip", "機械判定で返信不要と確定したメッセージ")
    elif verdict_kind == "downgrade" and not is_review_draft:
        verdict.add(
            "downgraded-message",
            f"このメッセージは降格済み（{','.join(entry.get('reasons', []))}）。"
            f"通常の返信下書きは作れない",
        )
    elif verdict_kind not in ("proceed", "downgrade", "skip"):
        verdict.add("unknown-verdict", str(verdict_kind))

    if is_review_draft and not config.get("reviewCreatesDraft", False):
        verdict.add("review-draft-disabled", "reviewCreatesDraft が false なので確認用下書きは作らない")

    if not entry.get("inspected"):
        verdict.add("not-inspected", "本文全体の inspect を済ませてから")
    if entry.get("draftAttempted"):
        verdict.add("duplicate-draft", "このメッセージには今回すでに下書きを作成済み")

    to = _as_list(tool_input.get("to"))
    cc = _as_list(tool_input.get("cc"))
    bcc = _as_list(tool_input.get("bcc"))
    shape = P.check_recipients(
        to,
        cc,
        bcc,
        target_email=config["targetEmail"],
        notify_patterns=config.get("notifySenderPatterns", []),
    )
    verdict.violations.extend(shape.violations)

    salt = manifest["salt"]
    if len(to) == 1 and entry.get("senderHash"):
        if M.hash_address(P.normalize_address(to[0]), salt) != entry["senderHash"]:
            verdict.add("recipient-mismatch", "To が返信対象メールの送信者ではない")
    elif len(to) == 1 and not entry.get("senderHash"):
        verdict.add("recipient-unknown", "送信者が不明なメッセージには下書きを作らない")

    if cc:
        if config.get("ccMode", "none") != "mirror-previous":
            verdict.add("cc-forbidden", "ccMode が none なので Cc は付けない")
        else:
            allowed = set(entry.get("ccAllowedHashes", []))
            for address in cc:
                if M.hash_address(P.normalize_address(address), salt) not in allowed:
                    verdict.add("cc-not-allowed", "佐藤が過去にこのスレッドで Cc していない相手")

    body_verdict = P.check_draft_body(body, review_draft=is_review_draft)
    verdict.violations.extend(body_verdict.violations)
    return verdict


def _check_labels(tool: str, tool_input: dict, manifest: dict | None, why: str) -> P.Verdict:
    if tool == "label_message":
        add, remove = _as_list(tool_input.get("labelIds")), []
    else:  # update_message_labels
        add = _as_list(tool_input.get("addLabelIds"))
        remove = _as_list(tool_input.get("removeLabelIds"))
    verdict = P.check_label_change(add, remove)

    message_id = tool_input.get("messageId") or ""
    if manifest is None:
        verdict.add(why or "manifest-missing", "triage を実行してから")
    elif message_id not in manifest["messages"]:
        verdict.add("not-triaged", "このメッセージは今回の triage の対象ではない")
    return verdict


def decide(payload: dict, *, load_config, load_manifest) -> Decision:
    """フックの判定本体。副作用なし（テストから直接呼べる）。"""
    tool_name = str(payload.get("tool_name", ""))
    tool_input = payload.get("tool_input") or {}
    if not isinstance(tool_input, dict):
        tool_input = {}
    cls = P.classify_tool(tool_name)

    if cls.kind in ("other", "read"):
        return Decision(True, cls.kind, cls.base)

    if cls.kind == "deny":
        verdict = P.Verdict()
        verdict.add(
            "forbidden-tool",
            f"{cls.base} は実行しない。このリポジトリではメールの送信・返信・転送・削除・"
            f"迷惑メール化・既存下書きの改変を行わない。送信は必ず人間が Gmail で行う",
        )
        return _deny(cls.kind, cls.base, verdict)

    if cls.kind == "unknown-gmail":
        verdict = P.Verdict()
        verdict.add("unknown-gmail-tool", f"{cls.base} は許可リストに無い（安全側で拒否）")
        return _deny(cls.kind, cls.base, verdict)

    # --- gated: 書き込み系 ---
    try:
        config = load_config()
    except Exception as exc:  # 設定が読めないなら書き込ませない
        verdict = P.Verdict()
        verdict.add("config-error", str(exc)[:120])
        return _deny(cls.kind, cls.base, verdict)

    if config.get("dryRun", True):
        verdict = P.Verdict()
        verdict.add(
            "dry-run",
            "mail-assistant/config.json の dryRun が true。Gmail への書き込みは行わない。"
            "判定結果と返信案は報告に含めること",
        )
        return _deny(cls.kind, cls.base, verdict)

    manifest, why = load_manifest()

    if cls.base == "create_draft":
        verdict = check_create_draft(tool_input, config, manifest, why)
    elif cls.base in ("label_message", "update_message_labels"):
        verdict = _check_labels(cls.base, tool_input, manifest, why)
    elif cls.base == "create_label":
        verdict = P.Verdict()
        name = str(tool_input.get("name") or tool_input.get("displayName") or "")
        if name not in _configured_labels(config):
            verdict.add("unconfigured-label", "config.json の labels に無いラベルは作らない")
    else:  # pragma: no cover - GATED と分岐の不一致
        verdict = P.Verdict()
        verdict.add("unhandled-gated-tool", cls.base)

    if verdict.ok:
        return Decision(True, cls.kind, cls.base)
    return _deny(cls.kind, cls.base, verdict)


def _log(decision: Decision) -> None:
    """判定の監査ログ。ツール名と判定コードのみで、引数（宛先・本文）は残さない。"""
    try:
        GUARD_LOG.parent.mkdir(parents=True, exist_ok=True)
        entry = {
            "at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
            "tool": decision.tool,
            "kind": decision.kind,
            "decision": "allow" if decision.allow else "deny",
            "codes": list(decision.codes),
        }
        with GUARD_LOG.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass  # ログの失敗で判定を変えない


def _default_config():
    import gate

    return gate.load_config()


def run(payload: dict) -> int:
    """フックとして実行する。終了コードを返す。"""
    decision = decide(payload, load_config=_default_config, load_manifest=M.load)

    # Gmail 以外のツールはログにも残さない（無関係なので）
    if decision.kind != "other":
        _log(decision)

    if decision.allow:
        # 下書き作成を通したら、同じメッセージへの2通目を止めるため印を付ける
        if decision.tool == "create_draft":
            message_id = (payload.get("tool_input") or {}).get("replyToMessageId", "")
            M.update_entry(message_id, {"draftAttempted": True})
        return 0

    output = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": f"[mail-assistant guard] {decision.reason}",
        }
    }
    sys.stdout.write(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        data = json.loads(sys.stdin.read())
    except json.JSONDecodeError:
        print("[mail-assistant guard] フック入力を解釈できないため拒否", file=sys.stderr)
        sys.exit(2)
    sys.exit(run(data))
