"""Gmail 操作の安全ポリシー（純関数・標準ライブラリのみ）。

このモジュールは2か所から使われる:
  - guard.py（PreToolUse フック）… ハーネスが Gmail 操作を実行する直前に強制する
  - assistant.py vet            … モデルが下書きを作る前に自分で点検する

同じ関数を両方が呼ぶので、「点検では通ったのに実行時に弾かれる」「その逆」が起きない。

設計の前提:
  Gmail コネクタには send_message / reply / forward / trash_* が存在する。
  コネクタ自体には「下書きは作れるが送信はできない」という制限が無いため、
  送信しないことはここ（とフック）で機械的に担保する。
  モデルが指示を守ることには依存しない。安いモデルで回す前提なので特に重要。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# ツールの分類
# ---------------------------------------------------------------------------

# どんな理由があっても実行させないもの。送信・削除・迷惑メール化・既存下書きの改変。
# label_thread も含める: スレッドに付けたラベルは以後届く続報にも自動で付き、
# 続報が「処理済み」扱いになって取りこぼされるため。
ALWAYS_DENY = frozenset(
    {
        # 送信
        "send_message",
        "send_draft",
        "reply",
        "reply_all",
        "forward",
        # 削除・ゴミ箱
        "trash_message",
        "trash_thread",
        "untrash_message",
        "untrash_thread",
        "delete_message",
        "delete_thread",
        "delete_draft",
        # 迷惑メール
        "mark_message_spam",
        "mark_thread_spam",
        "unmark_message_spam",
        "unmark_thread_spam",
        "apply_sensitive_message_label",
        "apply_sensitive_thread_label",
        # 既存のものを書き換える操作
        "update_draft",
        "update_label",
        "delete_label",
        "unlabel_message",
        "unlabel_thread",
        "label_thread",
    }
)

# 条件付きで許可するもの。dryRun・マニフェスト・宛先・本文を検査する。
GATED = frozenset({"create_draft", "label_message", "update_message_labels", "create_label"})

# 読み取り専用。常に許可する。
READS = frozenset(
    {
        "search_threads",
        "get_thread",
        "get_message",
        "list_labels",
        "list_drafts",
        "get_draft",
    }
)

# ツール名だけで Gmail のものと判断するための署名。
# MCP サーバー名は接続のたびに変わりうる（実際に "5c3da92a-..." から "Gmail" に変わった）ので、
# サーバー名だけに頼らずツール名でも判定する。
GMAIL_SIGNATURE = ALWAYS_DENY | GATED | READS


@dataclass(frozen=True)
class ToolClass:
    kind: str  # "deny" / "gated" / "read" / "unknown-gmail" / "other"
    server: str
    base: str


def classify_tool(tool_name: str) -> ToolClass:
    """フックに渡されたツール名を分類する。

    MCP ツールは `mcp__<server>__<tool>` の形。サーバー名に "gmail" を含むか、
    ツール名が Gmail の署名に一致すれば Gmail とみなす。

    送信系の名前（send_message 等）は、Gmail 以外のサーバーのものでも拒否する。
    このリポジトリでメッセージを送る正当な用途は無く、取りこぼした場合の損害
    （誤送信）が過剰に止めた場合の損害（手で送れば済む）より圧倒的に大きいため。
    """
    if not tool_name.startswith("mcp__"):
        return ToolClass("other", "", tool_name)
    parts = tool_name.split("__")
    if len(parts) < 3:
        return ToolClass("other", "", tool_name)
    server, base = parts[1], parts[-1]

    is_gmail = "gmail" in server.lower() or base in GMAIL_SIGNATURE
    if not is_gmail:
        return ToolClass("other", server, base)
    if base in ALWAYS_DENY:
        return ToolClass("deny", server, base)
    if base in GATED:
        return ToolClass("gated", server, base)
    if base in READS:
        return ToolClass("read", server, base)
    # Gmail の未知のツールは安全側に倒して拒否する（fail closed）。
    # 添付ファイルの取得など、要件で自動実行を禁じた操作もここで止まる。
    return ToolClass("unknown-gmail", server, base)


# ---------------------------------------------------------------------------
# 違反の表現
# ---------------------------------------------------------------------------


@dataclass
class Verdict:
    """ポリシー判定の結果。violations が空なら許可。"""

    violations: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.violations

    def add(self, code: str, detail: str = "") -> None:
        self.violations.append(f"{code}: {detail}" if detail else code)

    def reason(self) -> str:
        return " / ".join(self.violations)


# ---------------------------------------------------------------------------
# 本文の検査
# ---------------------------------------------------------------------------

REVIEW_NOTICE = "【AI判定：要確認】"
PLACEHOLDER_RE = re.compile(r"【要確認[：:][^】]+】")
URL_RE = re.compile(r"https?://|www\.[a-z0-9-]+\.", re.I)
MAX_BODY_CHARS = 4000

# 「AI が書いた」と本文で明かしてしまうパターン。
# 業務語としての「AI」（AI事業部など）を誤検知しないよう、書き手を指す言い回しに限る。
AI_SELF_REFERENCE = [
    re.compile(r"AI(?:が|により|によって)(?:作成|生成|代筆|自動|書)"),
    re.compile(r"AIアシスタント"),
    re.compile(r"人工知能"),
    re.compile(r"(?:言語|生成)モデル"),
    re.compile(r"自動生成(?:された|し|の)"),
    re.compile(r"\bas an AI\b", re.I),
    re.compile(r"\bI(?:'m| am) an AI\b", re.I),
    # \b は使わない。Unicode の正規表現では「で」「を」も単語文字なので、
    # 「Claudeで生成」の e と で の間に単語境界ができず一致しなくなる。
    # 日本語では英語名に助詞が直接続くのが普通なので、ASCII 英字だけを境界として見る。
    re.compile(r"(?<![A-Za-z])(?:ChatGPT|Gemini|Claude|Copilot)(?![A-Za-z])", re.I),
]

# コネクタは body に Markdown を書くなと明記している。安いモデルが付けがちな装飾を止める。
MARKDOWN_RE = [
    re.compile(r"^\s{0,3}#{1,6}\s", re.M),  # 見出し
    re.compile(r"\*\*[^*\n]+\*\*"),  # 太字
    re.compile(r"^\s*\|.*\|\s*$", re.M),  # 表
    re.compile(r"```"),  # コードブロック
]


def check_draft_body(
    body: str,
    *,
    missing_information: list[str] | None = None,
    review_draft: bool = False,
) -> Verdict:
    """返信本文を検査する。"""
    verdict = Verdict()
    text = body or ""

    if not text.strip():
        verdict.add("empty-body", "本文が空")
        return verdict
    if len(text) > MAX_BODY_CHARS:
        verdict.add("too-long", f"{len(text)}字（上限 {MAX_BODY_CHARS}）")
    if any(p.search(text) for p in AI_SELF_REFERENCE):
        verdict.add("ai-self-reference", "AI・自動生成・モデル名への言及がある")
    if URL_RE.search(text):
        # 参照元の本文は URL を除いて読ませている。返信案の URL は捏造の疑いが強い。
        verdict.add("url-in-body", "URL を含む（出典の無いリンクは捏造の疑い）")
    if any(p.search(text) for p in MARKDOWN_RE):
        verdict.add("markdown", "Markdown の装飾がある（Gmail ではそのまま表示される）")
    if missing_information and not PLACEHOLDER_RE.search(text):
        verdict.add("missing-placeholder", "不明な情報があるのに【要確認：…】が無い")
    if review_draft and not text.lstrip().startswith(REVIEW_NOTICE):
        verdict.add("missing-review-notice", f"確認用下書きは先頭に {REVIEW_NOTICE} が必要")
    return verdict


# ---------------------------------------------------------------------------
# 宛先の検査
# ---------------------------------------------------------------------------

EMAIL_RE = re.compile(r"^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$")


def normalize_address(value: str) -> str:
    """'山田 <taro@example.com>' → 'taro@example.com'。"""
    value = (value or "").strip()
    match = re.search(r"<([^>]+)>", value)
    return (match.group(1) if match else value).strip().lower()


def check_recipients(
    to: list[str],
    cc: list[str],
    bcc: list[str],
    *,
    target_email: str,
    notify_patterns: list[str],
) -> Verdict:
    """宛先の形だけを検査する（誰宛てかの照合は guard 側でマニフェストと行う）。"""
    verdict = Verdict()
    to_n = [normalize_address(a) for a in to or []]
    cc_n = [normalize_address(a) for a in cc or []]

    if bcc:
        verdict.add("bcc-forbidden", "Bcc は使わない")
    if len(to_n) != 1:
        verdict.add("to-must-be-one", f"To は1件のみ（{len(to_n)}件）")
    for address in to_n + cc_n:
        if not EMAIL_RE.match(address):
            verdict.add("invalid-address", "アドレスの形式が不正")
        elif address == target_email.lower():
            verdict.add("self-address", "自分自身を宛先にしている")
        elif any(p and p.lower() in address for p in notify_patterns):
            verdict.add("no-reply-address", "返信不可のアドレスを宛先にしている")
    return verdict


# ---------------------------------------------------------------------------
# ラベルの検査
# ---------------------------------------------------------------------------

USER_LABEL_RE = re.compile(r"^Label_[0-9A-Za-z_-]+$")


def check_label_change(add: list[str], remove: list[str]) -> Verdict:
    """ラベル変更を検査する。

    - 外すのは禁止（INBOX を外す＝アーカイブ、UNREAD を外す＝既読化になる）
    - 付けられるのはユーザーラベルのみ（TRASH / SPAM / UNREAD 等のシステムラベルを
      付けるとゴミ箱送り・迷惑メール化・未読化になる）
    """
    verdict = Verdict()
    if remove:
        verdict.add("label-removal-forbidden", "ラベルを外す操作は禁止（アーカイブ・既読化になる）")
    if not add:
        verdict.add("no-labels", "付けるラベルが無い")
    for label_id in add or []:
        if not USER_LABEL_RE.match(str(label_id)):
            verdict.add("system-label-forbidden", f"システムラベル {label_id} は付けない")
    return verdict
