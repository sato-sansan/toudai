"""AIメール返信下書きアシスタントの CLI。

Claude Code（スキル `mail-assistant`）がこのコマンドを呼び、
Gmail の読み取り・判定・起草そのものは Claude 自身が行う。
ここが担うのは「決定的に決まること」だけ:

    gate     … 今動いてよいか（営業日・稼働時間・祝日）＋ 検索クエリ
    triage   … 機械判定と重複排除（Claude に読ませる対象を絞る）
    record   … 処理履歴の追記
    summary  … 日次集計
    config   … 有効な設定の表示

すべて標準ライブラリのみ。リポジトリルートから実行する:

    python mail-assistant/assistant.py gate
    python mail-assistant/assistant.py triage < threads.json
    python mail-assistant/assistant.py record < records.json
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
import summary as S


def _print_json(payload: dict) -> None:
    json.dump(payload, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")


def _read_stdin_json() -> dict:
    raw = sys.stdin.read().strip()
    if not raw:
        raise SystemExit("標準入力が空です。JSON を渡してください。")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SystemExit(f"標準入力の JSON を解釈できません: {exc}")
    if not isinstance(parsed, dict):
        raise SystemExit("標準入力の JSON はオブジェクトにしてください。")
    return parsed


def cmd_gate(args: argparse.Namespace) -> int:
    config = G.load_config()
    moment = (
        dt.datetime.fromisoformat(args.now).astimezone(G.tzinfo_of(config))
        if args.now
        else G.now_local(config)
    )
    report = G.gate_report(config, moment)
    _print_json(report)
    # 稼働条件外でも異常ではないので終了コードは 0。判断は ok フィールドで行う。
    return 0


def cmd_triage(args: argparse.Namespace) -> int:
    import triage as T

    config = G.load_config()
    payload = _read_stdin_json()
    processed = L.processed_map()
    result = T.triage_threads(payload, config, processed)
    _print_json(result)
    return 0


def cmd_record(args: argparse.Namespace) -> int:
    config = G.load_config()
    payload = _read_stdin_json()
    records = payload.get("records", [])
    if not isinstance(records, list):
        raise SystemExit("records は配列にしてください。")

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
            "ledgerPath": str(L.LEDGER_PATH.relative_to(L.ROOT)),
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
    try:
        config = G.load_config()
    except G.ConfigError as exc:
        raise SystemExit(f"設定が不正です: {exc}")
    # 秘密情報は持たない設計だが、念のため内部キーは伏せる
    shown = {k: v for k, v in config.items() if not k.startswith("_")}
    _print_json(shown)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="assistant.py",
        description="AIメール返信下書きアシスタントの補助コマンド（判定と起草は Claude が行う）",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_gate = sub.add_parser("gate", help="稼働条件の判定と検索クエリの出力")
    p_gate.add_argument("--now", help="判定に使う時刻（ISO8601）。テスト用")
    p_gate.set_defaults(func=cmd_gate)

    p_triage = sub.add_parser("triage", help="機械判定と重複排除（stdin に JSON）")
    p_triage.set_defaults(func=cmd_triage)

    p_record = sub.add_parser("record", help="処理履歴の追記（stdin に JSON）")
    p_record.add_argument(
        "--force", action="store_true", help="ドライランでも履歴を書く"
    )
    p_record.set_defaults(func=cmd_record)

    p_summary = sub.add_parser("summary", help="日次集計")
    p_summary.add_argument("--date", help="対象日（YYYY-MM-DD）。既定は今日")
    p_summary.add_argument("--json", action="store_true", help="JSON で出力")
    p_summary.set_defaults(func=cmd_summary)

    p_config = sub.add_parser("config", help="有効な設定の表示")
    p_config.set_defaults(func=cmd_config)

    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except G.ConfigError as exc:
        raise SystemExit(f"設定が不正です: {exc}")


if __name__ == "__main__":
    sys.exit(main())
