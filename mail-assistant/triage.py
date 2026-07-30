"""AI（Claude）に読ませる前の機械判定（標準ライブラリのみ）。

ここで弾けるものは Claude に読ませない。理由は3つ:
  1. 明らかな自動配信を読み込むだけでターンと時間を消費するのを避ける
  2. 決定的な規則は決定的に扱う（判断の揺らぎを持ち込まない）
  3. 処理対象を絞ることで、1回の実行で扱える件数を安定させる

判定は3段階:
  skip      … Claude に読ませず NO_REPLY_REQUIRED 確定
  downgrade … Claude は読むが REPLY_REQUIRED まで上げない（＝下書きを作らない）
  proceed   … 通常処理

【重要】Gmail コネクタの制約（実データで確認済み）:
  1. 生ヘッダ（List-Id / Precedence / Auto-Submitted）を返さない
  2. カテゴリラベル（CATEGORY_PROMOTIONS 等）も返さない。
     実際の labelIds は INBOX / UNREAD / IMPORTANT / ユーザーラベルのみだった

そのため GAS 版のヘッダ判定は使えない。代わりに観測可能なものだけで判定する:
  - 送信者アドレスのパターン（no-reply, notification@ 等）
  - 配信システム特有の不可視パディング文字（U+034F の連続。プリヘッダ埋めに使われる）
  - 本文・スニペットの文言（配信停止・メルマガ解除・unsubscribe 等）
  - カテゴリラベル（返ってくる環境なら効く。保険として残す）

ここで弾き切れなかった配信メールは Claude が読んで NO_REPLY_REQUIRED にする。
安全性の問題ではなく、無駄な読み込みが増えるだけなので、判定は「取りこぼしより誤爆を避ける」
方向に寄せてある。
"""
from __future__ import annotations

import datetime as dt
import re

# Gmail のカテゴリラベル。プロモーション・SNS・フォーラムは返信対象外とみなす。
SKIP_CATEGORY_LABELS = {
    "CATEGORY_PROMOTIONS",  # メールマガジン・広告
    "CATEGORY_SOCIAL",      # SNS の通知
    "CATEGORY_FORUMS",      # メーリングリスト
}
# 自動通知が多いが業務メールも混じるため、判断材料として Claude に渡すだけにする
HINT_CATEGORY_LABELS = {"CATEGORY_UPDATES"}

NO_REPLY_PHRASES = [
    re.compile(r"返信は?(?:不要|無用|ご遠慮)"),
    re.compile(r"この(?:メール|アドレス)(?:に|へ)(?:は)?返信(?:でき|しないで)"),
    re.compile(r"返信いただ(?:く必要|かなくて)"),
    re.compile(r"(?:本|この)メールは送信専用"),
    re.compile(r"配信(?:の)?停止"),
    re.compile(r"(?:メルマガ|メールマガジン).{0,6}(?:解除|停止)"),
    re.compile(r"do not reply", re.I),
    re.compile(r"no need to reply", re.I),
    re.compile(r"this is an automated", re.I),
    re.compile(r"unsubscribe", re.I),
]

# 配信システムがプリヘッダを埋めるために使う不可視文字。
# U+034F(結合書記素接合子) / U+200B(ゼロ幅スペース) / U+200C / U+FEFF が連続していたら
# 一斉配信メールとみなす。実際の受信箱で配信メールを高い精度で拾えた指標。
BULK_PADDING_RE = re.compile(r"[͏​‌﻿](?:\s*[͏​‌﻿]){2,}")


def looks_like_bulk_padding(text: str) -> bool:
    """配信システム特有の不可視パディングを含むか。"""
    return bool(BULK_PADDING_RE.search(text or ""))

# プロンプトインジェクションの疑い。検知しても処理は止めず、
# REVIEW_REQUIRED へ落として人間の目に回す。
INJECTION_PATTERNS = [
    re.compile(r"(?:これまで|以前|上記|先)の(?:指示|命令|プロンプト).{0,10}(?:無視|忘れ|破棄)"),
    re.compile(r"指示を(?:無視|忘れ)"),
    re.compile(r"ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions?|prompts?)", re.I),
    re.compile(r"disregard (?:all |any )?(?:previous|prior|above) (?:instructions?|prompts?)", re.I),
    re.compile(r"you are now (?:a|an|acting)", re.I),
    re.compile(r"system\s*(?:prompt|message)\s*[:：]", re.I),
    re.compile(r"\b(?:developer|system)\s+mode\b", re.I),
    re.compile(r"(?:あなた|君)は(?:今|これから).{0,20}として(?:振る舞|ふるま|動作)"),
    re.compile(r"(?:全て|すべて)のメールに(?:返信|下書き)(?:を)?(?:作成|して)"),
    re.compile(r"(?:自動|即時|今すぐ|直ちに|ただちに)(?:で|に)?(?:返信|送信)(?:して|せよ|しろ|願い)"),
    re.compile(r"reply to (?:all|every) emails?", re.I),
    re.compile(r"send (?:this|the) (?:email|message) (?:now|immediately|automatically)", re.I),
    re.compile(r"<\|?(?:im_start|im_end|system|endoftext)\|?>", re.I),
    re.compile(r"プロンプト(?:を)?(?:出力|表示|開示)"),
    re.compile(r"reveal (?:your )?(?:system )?prompt", re.I),
]


def detect_injection(text: str) -> bool:
    """プロンプトインジェクションらしい文言を検知する。"""
    return any(p.search(text or "") for p in INJECTION_PATTERNS)


def _norm_email(value: str) -> str:
    """'山田太郎 <taro@example.com>' → 'taro@example.com'。"""
    if not value:
        return ""
    match = re.search(r"<([^>]+)>", value)
    raw = match.group(1) if match else value
    return raw.strip().lower()


def _emails(values) -> list[str]:
    if not values:
        return []
    if isinstance(values, str):
        values = [values]
    return [e for e in (_norm_email(v) for v in values) if e]


def domain_of(email: str) -> str:
    at = email.rfind("@")
    return email[at + 1:].lower() if 0 <= at < len(email) - 1 else ""


def _parse_date(value: str) -> dt.datetime | None:
    if not value:
        return None
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        pass
    try:
        from email.utils import parsedate_to_datetime

        return parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None


def is_important(subject: str, body: str, config: dict) -> bool:
    """請求・契約・セキュリティ等の重要メールか（返信不要でも記録する）。"""
    haystack = f"{subject}\n{body}".lower()
    return any(k and k.lower() in haystack for k in config.get("importantKeywords", []))


def _is_notify_sender(email: str, config: dict) -> bool:
    return any(p and p.lower() in email for p in config.get("notifySenderPatterns", []))


def _replied_after(thread_messages: list[dict], message: dict, target: str) -> bool:
    """対象メール以降に、佐藤または社内ドメインからの送信があるか。"""
    own_domain = domain_of(target)
    base = _parse_date(message.get("date", ""))
    if base is None:
        return False
    for other in thread_messages:
        if other.get("id") == message.get("id"):
            continue
        when = _parse_date(other.get("date", ""))
        if when is None or when <= base:
            continue
        labels = other.get("labelIds") or []
        if "DRAFT" in labels:
            continue
        sender = _norm_email(_first(other, "from", "sender") or "")
        if sender == target or "SENT" in labels:
            return True
        if own_domain and sender.endswith(f"@{own_domain}"):
            return True
    return False


def _first(message: dict, *names):
    """Gmail コネクタの実際のフィールド名と、正規化後の名前の両方を受け付ける。

    search_threads は sender / toRecipients / ccRecipients を返すが、
    呼び出し側が from / to / cc に直して渡すこともある。どちらでも壊れないようにする
    （取り違えると「Cc のみ」判定が効かなくなり、誤って下書きを作りうる）。
    """
    for name in names:
        value = message.get(name)
        if value:
            return value
    return None


def triage_message(message: dict, thread: dict, config: dict) -> dict:
    """1通の機械判定。"""
    target = config["targetEmail"].lower()
    thread_messages = thread.get("messages") or []
    labels = set(message.get("labelIds") or [])
    sender = _norm_email(_first(message, "from", "sender") or "")
    subject = message.get("subject", "") or ""
    # スニペットしか無い段階でも判定できるようにしておく
    body = _first(message, "plaintextBody", "body", "snippet") or ""
    to_list = _emails(_first(message, "to", "toRecipients"))
    cc_list = _emails(_first(message, "cc", "ccRecipients"))

    important = is_important(subject, body, config)
    cc_only = target not in to_list and target in cc_list
    # 宛先に本人が全く現れないメール（エイリアス・グループ経由の転送、
    # 別担当者宛のメールなど）。実受信箱では billing@ 宛のメールが多数流れてくる。
    # 本人が明示的な宛先でないものに自動で返信下書きを作るのは危険なので降格する。
    not_direct = target not in to_list and target not in cc_list
    injection = detect_injection(f"{subject}\n{body}")
    signals: list[str] = []
    if labels & HINT_CATEGORY_LABELS:
        signals.append("gmail-category-updates")
    if message.get("attachmentIds") or message.get("attachments"):
        signals.append("has-attachments")
    if len(to_list) + len(cc_list) >= 5:
        signals.append("many-recipients")

    def result(verdict: str, reasons: list[str]) -> dict:
        return {
            "messageId": message.get("id", ""),
            "threadId": thread.get("id", "") or message.get("threadId", ""),
            "verdict": verdict,
            "reasons": reasons,
            "signals": signals,
            "important": important,
            "ccOnly": cc_only,
            "notDirectRecipient": not_direct,
            "injectionSuspected": injection,
            "senderDomain": domain_of(sender),
        }

    # --- AI を呼ばずに確定するもの ---
    if sender == target or "SENT" in labels:
        return result("skip", ["self-sent"])
    if "DRAFT" in labels:
        return result("skip", ["is-draft"])
    if "SPAM" in labels:
        return result("skip", ["spam"])
    if "TRASH" in labels:
        return result("skip", ["trash"])
    if _is_notify_sender(sender, config):
        return result("skip", ["no-reply-sender"])
    matched_categories = labels & SKIP_CATEGORY_LABELS
    if matched_categories:
        return result("skip", [f"gmail-category:{sorted(matched_categories)[0]}"])
    if any(p.search(body) or p.search(subject) for p in NO_REPLY_PHRASES):
        return result("skip", ["sender-says-no-reply"])
    if looks_like_bulk_padding(body):
        return result("skip", ["bulk-preheader-padding"])
    if _replied_after(thread_messages, message, target):
        return result("skip", ["already-replied"])
    if any("DRAFT" in (m.get("labelIds") or []) for m in thread_messages):
        return result("skip", ["draft-exists"])

    # --- Claude は読むが REPLY_REQUIRED には上げないもの ---
    reasons: list[str] = []
    if cc_only:
        reasons.append("cc-only")
    elif not_direct:
        reasons.append("not-direct-recipient")
    if injection:
        reasons.append("injection-suspected")
    if reasons:
        return result("downgrade", reasons)

    return result("proceed", [])


def triage_threads(payload: dict, config: dict, processed: dict) -> dict:
    """スレッド群を機械判定し、処理対象と除外対象に振り分ける。

    processed は ledger から読んだ {messageId: record}。
    正常終了済みは再処理せず、エラー終了は retryMax の範囲で再試行する。
    """
    from gate import is_received_in_scope, tzinfo_of  # 遅延 import（循環回避）

    to_process: list[dict] = []
    skipped: list[dict] = []
    already: list[str] = []
    out_of_scope: list[str] = []
    retry_max = config.get("retryMax", 2)
    limit = config.get("maxMessagesPerRun", 20)

    for thread in payload.get("threads", []):
        for message in thread.get("messages") or []:
            message_id = message.get("id", "")
            if not message_id:
                continue

            record = processed.get(message_id)
            if record is not None:
                if not record.get("error"):
                    already.append(message_id)
                    continue
                if retry_max <= 0 or int(record.get("attempts", 1)) > retry_max:
                    already.append(message_id)
                    continue

            when = _parse_date(message.get("date", ""))
            if when is None:
                out_of_scope.append(message_id)
                continue
            if when.tzinfo is None:
                when = when.replace(tzinfo=tzinfo_of(config))
            if not is_received_in_scope(when, config):
                out_of_scope.append(message_id)
                continue

            verdict = triage_message(message, thread, config)
            if verdict["verdict"] == "skip":
                skipped.append(verdict)
            else:
                to_process.append(verdict)

    # 古い順に処理する（会話の流れを壊さない）
    to_process.sort(key=lambda v: v.get("messageId", ""))
    truncated = len(to_process) > limit

    return {
        "process": to_process[:limit],
        "skip": skipped,
        "stats": {
            "candidates": len(to_process) + len(skipped),
            "toProcess": min(len(to_process), limit),
            "machineSkipped": len(skipped),
            "alreadyProcessed": len(already),
            "outOfScope": len(out_of_scope),
            "truncated": truncated,
        },
    }
