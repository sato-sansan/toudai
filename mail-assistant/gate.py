"""設定の読み込みと稼働条件の判定（標準ライブラリのみ）。

Routine（cron）は「平日の毎時」までしか表現できないので、
祝日・稼働時間の最終判定はここで行う。cron が多めに起動し、ここで絞る形。

タイムゾーンは固定オフセット方式。Asia/Tokyo は DST が無いので常に UTC+9 で正しい。
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

import jp_holidays as H

ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG_PATH = ROOT / "mail-assistant" / "config.json"

# DST を持たないタイムゾーンのみ対応（zoneinfo に頼らず決定的に扱う）
TZ_OFFSETS = {
    "Asia/Tokyo": 9,
    "Asia/Seoul": 9,
    "Asia/Shanghai": 8,
    "Asia/Singapore": 8,
    "UTC": 0,
}


class ConfigError(ValueError):
    """設定が不正なときに送出する。安全側に倒して実行を止めるため例外にする。"""


def load_config(path: pathlib.Path | None = None) -> dict:
    """config.json を読み、値域を検証して返す。"""
    path = path or CONFIG_PATH
    config = json.loads(path.read_text("utf-8"))

    tz = config.get("timezone", "Asia/Tokyo")
    if tz not in TZ_OFFSETS:
        raise ConfigError(
            f"timezone '{tz}' は未対応です。対応: {', '.join(TZ_OFFSETS)}"
        )
    config["_tzOffsetHours"] = TZ_OFFSETS[tz]

    start = config.get("workStartHour", 8)
    end = config.get("workEndHour", 18)
    if not (0 <= start < end <= 24):
        raise ConfigError("workStartHour < workEndHour（0〜24）にしてください")

    reply = config.get("confidenceReplyThreshold", 0.85)
    review = config.get("confidenceReviewThreshold", 0.6)
    if not (0 <= review <= reply <= 1):
        raise ConfigError(
            "0 <= confidenceReviewThreshold <= confidenceReplyThreshold <= 1 にしてください"
        )

    if config.get("ccMode", "none") not in ("none", "mirror-previous"):
        raise ConfigError("ccMode は none / mirror-previous のいずれかにしてください")

    if "@" not in config.get("targetEmail", ""):
        raise ConfigError("targetEmail が不正です")

    for day in config.get("extraHolidays", []):
        try:
            dt.date.fromisoformat(day)
        except ValueError as exc:
            raise ConfigError(f"extraHolidays の '{day}' は YYYY-MM-DD 形式にしてください") from exc

    # dryRun は「明示的に false と書いたときだけ」解除される（安全側の既定）
    config["dryRun"] = config.get("dryRun", True) is not False

    return config


def tzinfo_of(config: dict) -> dt.timezone:
    return dt.timezone(dt.timedelta(hours=config["_tzOffsetHours"]))


def now_local(config: dict) -> dt.datetime:
    return dt.datetime.now(tz=tzinfo_of(config))


def is_business_day(day: dt.date, config: dict) -> bool:
    """営業日か（土日・祝日・追加休業日の設定を反映）。"""
    if config.get("weekdaysOnly", True) and H.is_weekend(day):
        return False
    if config.get("skipJapaneseHolidays", True) and H.is_holiday(day):
        return False
    if day.isoformat() in config.get("extraHolidays", []):
        return False
    return True


def is_within_work_hours(moment: dt.datetime, config: dict) -> bool:
    """稼働時間帯に入っているか。区間は [workStartHour, workEndHour)。"""
    return config["workStartHour"] <= moment.hour < config["workEndHour"]


def evaluate_gate(moment: dt.datetime, config: dict) -> tuple[bool, str]:
    """今このタイミングで処理してよいか。(ok, reason) を返す。"""
    if not is_business_day(moment.date(), config):
        name = H.holiday_name(moment.date())
        return False, f"not-business-day{f'({name})' if name else ''}"
    if not is_within_work_hours(moment, config):
        return False, "outside-work-hours"
    return True, ""


def is_received_in_scope(received: dt.datetime, config: dict) -> bool:
    """受信時刻が処理対象の時間帯か。"""
    if config.get("includeOffHoursReceived", False):
        return True
    local = received.astimezone(tzinfo_of(config))
    return is_business_day(local.date(), config) and is_within_work_hours(local, config)


def search_window_start(moment: dt.datetime, config: dict) -> dt.datetime:
    """検索窓の開始時刻。実行漏れを次回で補完できるよう maxCatchupHours 分遡る。

    重複は ledger で排除するので、広めに取っても二重処理にはならない。
    """
    return moment - dt.timedelta(hours=config.get("maxCatchupHours", 96))


def build_search_query(moment: dt.datetime, config: dict) -> str:
    """Gmail 検索クエリを組み立てる。

    - in:inbox          … 受信トレイのみ（アーカイブ済み・送信済みを拾わない）
    - -in:draft         … 下書きを拾わない
    - -from:me          … 自分の送信メールを除外
    - after:YYYY/MM/DD  … 検索窓（日付粒度。細かい重複排除は ledger 側）

    処理済みラベルによる除外はここでは行わない。スレッド検索は
    「1通でも条件に合えばスレッド全体が返る」ため、ラベル除外は
    続報メールの取りこぼしを招く。重複排除は ledger に一元化する。
    """
    start = search_window_start(moment, config)
    parts = [
        "in:inbox",
        "-in:draft",
        "-in:chats",
        "-from:me",
        f"after:{start.strftime('%Y/%m/%d')}",
    ]
    senders = config.get("testSenders") or []
    if config.get("testMode", False) and senders:
        parts.append("(" + " OR ".join(f"from:{s}" for s in senders) + ")")
    return " ".join(parts)


def gate_report(config: dict, moment: dt.datetime | None = None) -> dict:
    """スキル側が最初に読む実行計画。"""
    moment = moment or now_local(config)
    ok, reason = evaluate_gate(moment, config)
    labels = config.get("labels", {})
    return {
        "ok": ok,
        "reason": reason,
        "nowLocal": moment.isoformat(),
        "windowFromLocal": search_window_start(moment, config).isoformat(),
        "searchQuery": build_search_query(moment, config),
        "dryRun": config["dryRun"],
        "testMode": config.get("testMode", False),
        # テストモードでラベル絞り込みが必要な場合、ラベル ID は実行時に
        # list_labels で解決してクエリへ足す（Gmail 検索は表示名ではなく ID を取る）
        "testLabelName": config.get("testLabel", "") if config.get("testMode", False) else "",
        "maxMessagesPerRun": config.get("maxMessagesPerRun", 20),
        "historyLookbackMonths": config.get("historyLookbackMonths", 12),
        "historyMaxMessages": config.get("historyMaxMessages", 30),
        "confidenceReplyThreshold": config.get("confidenceReplyThreshold", 0.85),
        "confidenceReviewThreshold": config.get("confidenceReviewThreshold", 0.6),
        "reviewCreatesDraft": config.get("reviewCreatesDraft", False),
        "ccMode": config.get("ccMode", "none"),
        "signatureText": config.get("signatureText", ""),
        "targetEmail": config["targetEmail"],
        "targetName": config.get("targetName", ""),
        "labels": labels,
    }
