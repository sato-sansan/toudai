"""日次集計。

メール送信は行わない（そもそもコネクタに送信ツールが無い）。
出力は実行ログのみで、Routine の完了通知（プッシュ／メール）に乗って手元へ届く。
"""
from __future__ import annotations


def aggregate(iso_date: str, records: list[dict]) -> dict:
    """当日の処理履歴から件数を集計する。"""
    stats = {
        "date": iso_date,
        "examined": len(records),
        "drafted": 0,
        "review": 0,
        "noReply": 0,
        "errors": 0,
        "important": 0,
        "injectionSuspected": 0,
        "draftsCreated": 0,
    }
    for record in records:
        classification = record.get("classification")
        if classification == "REPLY_REQUIRED":
            stats["drafted"] += 1
        elif classification == "REVIEW_REQUIRED":
            stats["review"] += 1
        elif classification == "NO_REPLY_REQUIRED":
            stats["noReply"] += 1
        if record.get("error"):
            stats["errors"] += 1
        if record.get("important"):
            stats["important"] += 1
        if record.get("injectionSuspected"):
            stats["injectionSuspected"] += 1
        if record.get("draftId"):
            stats["draftsCreated"] += 1
    return stats


def format_summary(stats: dict, config: dict) -> str:
    """通知用テキスト。件数のみで個人情報を含めない。"""
    lines = [
        f"📧 メール返信下書きアシスタント 日次集計 {stats['date']}",
        f"対象アカウント: {config['targetEmail']}",
        "",
        f"確認したメール数: {stats['examined']}",
        f"返信下書きを作成: {stats['drafted']}（実際に作成した下書き: {stats['draftsCreated']}）",
        f"要確認: {stats['review']}",
        f"返信不要: {stats['noReply']}",
        f"エラー: {stats['errors']}",
    ]
    if stats["important"]:
        lines.append(f"重要メール（請求・契約・セキュリティ等）: {stats['important']}")
    if stats["injectionSuspected"]:
        lines.append(f"プロンプトインジェクションの疑い: {stats['injectionSuspected']}")

    if config.get("dryRun", True):
        lines += ["", "※ ドライラン中です。下書き作成・ラベル付与は行っていません。"]
    elif stats["drafted"] and not stats["draftsCreated"]:
        lines += ["", "※ 返信必要と判定したのに下書きが0件です。ラベル・権限設定を確認してください。"]
    if stats["review"]:
        lines += ["", f"「{config.get('labels', {}).get('review', 'AI要確認')}」ラベルを確認してください。"]
    return "\n".join(lines)
