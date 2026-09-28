"""AIメール返信下書きアシスタントの CLI。

Claude Code（スキル `mail-assistant`）がこのコマンドを呼び、
Gmail の読み取り・判定・起草そのものは Claude 自身が行う。
ここが担うのは「決定的に決まること」だけ:

    gate     … 今動いてよいか（営業日・稼働時間・祝日）と設定値
    query    … ラベル ID を反映した最終的な Gmail 検索クエリ
    triage   … 機械判定と重複排除。実行マニフェストを書く
    inspect  … 本文全体の検査。マニフェストに「検査済み」を記録（未検査だと下書き不可）
    vet      … 下書きの事前点検（guard と同じ規則で判定する）
    record   … 処理履歴の追記（--include-skips で機械判定分も自動で記録）
    summary  … 日次集計
    config   … 有効な設定の表示

モデルに任せる作業を減らし、決定的に処理できるものはここへ寄せている。
安いモデル（Haiku）で回しても手順の取りこぼしが起きにくくするため。

すべて標準ライブラリのみ。リポジトリルートから実行する:

    python mail-assistant/assistant.py gate
    python mail-assistant/assistant.py query --done-label-id Label_123
    python mail-assistant/assistant.py triage  < threads.json
    python mail-assistant/assistant.py inspect < body.json
    python mail-assistant/assistant.py vet     < draft.json
    python mail-assistant/assistant.py record --include-skips < records.json
    python mail-assistant/assistant.py summary
    python mail-assistant/assistant.py config
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import sys

import gate as G
import ledger as L
import manifest as M
import summary as S


def _print_json(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _read_stdin_json(*, allow_empty: bool = False) -> dict:
    raw = "" if sys.stdin.isatty() else sys.stdin.read().strip()
    if not raw:
        if allow_empty:
            return {}
        raise SystemExit("標準入力が空です。JSON を渡してください。")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"標準入力の JSON を解釈できません: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit("標準入力の JSON はオブジェクトにしてください。")
    return parsed


def _display(path) -> str:
    """リポジトリ内なら相対パス、外（テストの一時ディレクトリ等）なら絶対パスで示す。"""
    try:
        return str(path.relative_to(L.ROOT))
    except ValueError:
        return str(path)


def _moment(args: argparse.Namespace, config: dict) -> dt.datetime:
    if getattr(args, "now", None):
        return dt.datetime.fromisoformat(args.now).astimezone(G.tzinfo_of(config))
    return G.now_local(config)


def cmd_gate(args: argparse.Namespace) -> int:
    config = G.load_config()
    _print_json(G.gate_report(config, _moment(args, config)))
    # 稼働条件外でも異常ではないので終了コードは 0。判断は ok フィールドで行う。
    return 0


def cmd_query(args: argparse.Namespace) -> int:
    config = G.load_config()
    if config.get("testMode") and config.get("testLabel") and not args.test_label_id:
        raise SystemExit(
            f"testMode が true です。テスト対象ラベル「{config['testLabel']}」の ID を "
            "--test-label-id で渡してください（ラベルが無ければ Gmail で作成してから）。"
        )
    query = G.build_search_query(
        _moment(args, config),
        config,
        done_label_id=args.done_label_id or "",
        test_label_id=args.test_label_id or "",
    )
    _print_json({"query": query, "pageSize": 50, "maxPages": 5})
    return 0


def cmd_triage(args: argparse.Namespace) -> int:
    import triage as T

    config = G.load_config()
    payload = _read_stdin_json()
    if not isinstance(payload.get("draftThreadIds"), list):
        # 下書きは検索結果に出ないので、list_drafts で確認しないと重複を防げない。
        # 確認を飛ばせないよう、キーの存在自体を必須にする（下書きが無ければ空配列）。
        raise SystemExit(
            "draftThreadIds（既存の下書きがあるスレッド ID の配列）が必要です。"
            "list_drafts で集めて渡してください。下書きが無ければ [] を渡します。"
        )
    result = T.triage_threads(payload, config, L.processed_map())
    entries = result.pop("_manifestEntries")
    M.write(M.build(entries))
    result["manifest"] = {
        "path": _display(M.MANIFEST_PATH),
        "messages": len(entries),
        "note": "下書き・ラベルはこの一覧にあるメッセージにだけ作れる（guard が照合する）",
    }
    _print_json(result)
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    import triage as T

    config = G.load_config()
    payload = _read_stdin_json()
    message_id = str(payload.get("messageId", ""))
    if not message_id:
        raise SystemExit("messageId は必須です。")

    data, why = M.load()
    if data is None:
        raise SystemExit(f"実行マニフェストが使えません（{why}）。先に triage を実行してください。")
    entry = data["messages"].get(message_id)
    if entry is None:
        raise SystemExit("このメッセージは今回の triage の対象ではありません。")

    flags = T.inspect_body(str(payload.get("subject", "")), str(payload.get("body", "")), config)
    changes: dict = {"inspected": True}
    downgraded_now = False
    if flags["injectionSuspected"] and entry.get("verdict") == "proceed":
        # 本文の奥に埋め込まれたインジェクション。降格し、guard に通常の下書きを拒否させる。
        changes["verdict"] = "downgrade"
        changes["reasons"] = list(entry.get("reasons", [])) + ["injection-in-body"]
        downgraded_now = True
    if flags["important"]:
        changes["important"] = True
    M.update_entry(message_id, changes)

    verdict = changes.get("verdict", entry.get("verdict"))
    _print_json(
        {
            "messageId": message_id,
            **flags,
            "verdict": verdict,
            "downgradedNow": downgraded_now,
            "maxClassification": "REVIEW_REQUIRED" if verdict == "downgrade" else "REPLY_REQUIRED",
        }
    )
    return 0


def cmd_vet(args: argparse.Namespace) -> int:
    """下書きを guard と同じ規則で事前点検する（dryRun は無視して中身だけ見る）。"""
    import guard
    import policy as P

    config = G.load_config()
    payload = _read_stdin_json()
    data, why = M.load()
    tool_input = {
        "replyToMessageId": payload.get("messageId", ""),
        "to": payload.get("to", []),
        "cc": payload.get("cc", []),
        "bcc": payload.get("bcc", []),
        "body": payload.get("body", ""),
        "subject": payload.get("subject", ""),
    }
    verdict = guard.check_create_draft(tool_input, config, data, why)
    # guard は下書きの本文しか見られない。「不明情報があるのにプレースホルダーが無い」は
    # モデルの判定結果（missingInformation）が要るので、ここで追加で見る。
    extra = P.check_draft_body(
        str(payload.get("body", "")),
        missing_information=list(payload.get("missingInformation") or []),
    )
    for violation in extra.violations:
        if violation not in verdict.violations:
            verdict.violations.append(violation)

    if not verdict.ok:
        next_step = "直すか、REVIEW_REQUIRED にして下書きを作らない"
    elif config["dryRun"]:
        next_step = "dryRun のため create_draft は呼ばない。返信案は報告に含める"
    else:
        next_step = "create_draft を呼んでよい"
    _print_json(
        {"ok": verdict.ok, "violations": verdict.violations, "dryRun": config["dryRun"], "next": next_step}
    )
    return 0 if verdict.ok else 1


def _skip_records_from_manifest(processed: dict) -> list[dict]:
    """マニフェストの機械判定（skip）分から履歴レコードを作る。モデルに書かせない。"""
    data, _ = M.load()
    if data is None:
        return []
    records = []
    for message_id, entry in data["messages"].items():
        if entry.get("verdict") != "skip" or message_id in processed:
            continue
        records.append(
            {
                "messageId": message_id,
                "threadId": entry.get("threadId", ""),
                "receivedAt": entry.get("receivedAt", ""),
                "classification": "NO_REPLY_REQUIRED",
                "confidence": 1.0,
                "action": "label-no-reply",
                "model": "rule",
                "important": entry.get("important", False),
                "injectionSuspected": False,
                "senderDomain": entry.get("senderDomain", ""),
                "reasonCode": "heuristic:" + ",".join(entry.get("reasons", [])),
            }
        )
    return records


def cmd_record(args: argparse.Namespace) -> int:
    config = G.load_config()
    payload = _read_stdin_json(allow_empty=args.include_skips)
    records = payload.get("records", [])
    if not isinstance(records, list):
        raise SystemExit("records は配列にしてください。")

    if args.include_skips:
        given = {str(r.get("messageId")) for r in records}
        processed = L.processed_map()
        records = records + [
            r for r in _skip_records_from_manifest(processed) if r["messageId"] not in given
        ]

    if config["dryRun"] and not args.force:
        _print_json(
            {
                "written": 0,
                "skipped": len(records),
                "reason": "dry-run（履歴を書かないので同じメールを再判定できる）",
            }
        )
        return 0

    try:
        written = L.append(records)
    except L.LedgerError as exc:
        raise SystemExit(f"履歴の検証に失敗: {exc}")
    _print_json(
        {
            "written": len(written),
            "ledgerPath": _display(L.LEDGER_PATH),
            "messageIds": [r["messageId"] for r in written],
        }
    )
    return 0


def cmd_summary(args: argparse.Namespace) -> int:
    config = G.load_config()
    iso_date = args.date or G.now_local(config).date().isoformat()
    records = L.records_for_date(iso_date)
    stats = S.aggregate(iso_date, records)
    if args.json:
        _print_json(stats)
    else:
        print(S.format_summary(stats, config))
    return 0


def cmd_config(args: argparse.Namespace) -> int:
    config = G.load_config()
    _print_json({k: v for k, v in config.items() if not k.startswith("_")})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="assistant.py",
        description="AIメール返信下書きアシスタントの補助コマンド（判定と起草は Claude が行う）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("gate", help="稼働条件の判定と設定値の出力")
    p.add_argument("--now", help="判定に使う時刻（ISO8601）。テスト用")
    p.set_defaults(func=cmd_gate)

    p = sub.add_parser("query", help="ラベル ID を反映した Gmail 検索クエリ")
    p.add_argument("--done-label-id", help="処理済みラベルの ID（list_labels で解決）")
    p.add_argument("--test-label-id", help="テスト対象ラベルの ID（testMode 時は必須）")
    p.add_argument("--now", help="基準時刻（ISO8601）。テスト用")
    p.set_defaults(func=cmd_query)

    p = sub.add_parser("triage", help="機械判定と重複排除（stdin に JSON）。マニフェストを書く")
    p.set_defaults(func=cmd_triage)

    p = sub.add_parser("inspect", help="本文全体の検査（stdin に JSON）。検査済みを記録する")
    p.set_defaults(func=cmd_inspect)

    p = sub.add_parser("vet", help="下書きの事前点検（stdin に JSON）。guard と同じ規則")
    p.set_defaults(func=cmd_vet)

    p = sub.add_parser("record", help="処理履歴の追記（stdin に JSON）")
    p.add_argument("--force", action="store_true", help="ドライランでも履歴を書く")
    p.add_argument(
        "--include-skips",
        action="store_true",
        help="マニフェストの機械判定（skip）分も自動で記録する",
    )
    p.set_defaults(func=cmd_record)

    p = sub.add_parser("summary", help="日次集計")
    p.add_argument("--date", help="対象日（YYYY-MM-DD）。既定は今日")
    p.add_argument("--json", action="store_true", help="JSON で出力")
    p.set_defaults(func=cmd_summary)

    p = sub.add_parser("config", help="有効な設定の表示")
    p.set_defaults(func=cmd_config)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return args.func(args)
    except G.ConfigError as exc:
        raise SystemExit(f"設定が不正です: {exc}")


if __name__ == "__main__":
    sys.exit(main())
