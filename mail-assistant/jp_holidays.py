"""日本の祝日判定（標準ライブラリのみ）。

祝日 API を叩かない理由は2つ。
  1. 外部サービスが落ちた日に「休日なのに動く／平日なのに止まる」が起きる
  2. 祝日法は決定的な計算で表現でき、テストで固定できる

対応範囲: 2022年以降の現行祝日法。
  - 2020/2021 の東京五輪特例（海の日・スポーツの日・山の日の移動）は再現しない
  - 春分/秋分の近似式は 1980〜2099 年が有効範囲
範囲外の年や特例日は config.json の extraHolidays で補える。
"""
from __future__ import annotations

import datetime as dt
from functools import lru_cache

SUNDAY = 6  # date.weekday() は月曜=0, 日曜=6


def _nth_monday(year: int, month: int, nth: int) -> int:
    """その月の n 番目の月曜日の日にちを返す。"""
    first_weekday = dt.date(year, month, 1).weekday()
    offset_to_monday = (7 - first_weekday) % 7
    return 1 + offset_to_monday + (nth - 1) * 7


def _vernal_equinox_day(year: int) -> int:
    """春分の日（1980〜2099 の近似式）。"""
    return int(20.8431 + 0.242194 * (year - 1980) - (year - 1980) // 4)


def _autumnal_equinox_day(year: int) -> int:
    """秋分の日（1980〜2099 の近似式）。"""
    return int(23.2488 + 0.242194 * (year - 1980) - (year - 1980) // 4)


@lru_cache(maxsize=8)
def japanese_holidays(year: int) -> dict[dt.date, str]:
    """指定年の祝日表（date → 祝日名）。振替休日・国民の休日を含む。"""
    base: dict[dt.date, str] = {
        dt.date(year, 1, 1): "元日",
        dt.date(year, 1, _nth_monday(year, 1, 2)): "成人の日",
        dt.date(year, 2, 11): "建国記念の日",
        dt.date(year, 2, 23): "天皇誕生日",
        dt.date(year, 3, _vernal_equinox_day(year)): "春分の日",
        dt.date(year, 4, 29): "昭和の日",
        dt.date(year, 5, 3): "憲法記念日",
        dt.date(year, 5, 4): "みどりの日",
        dt.date(year, 5, 5): "こどもの日",
        dt.date(year, 7, _nth_monday(year, 7, 3)): "海の日",
        dt.date(year, 8, 11): "山の日",
        dt.date(year, 9, _nth_monday(year, 9, 3)): "敬老の日",
        dt.date(year, 9, _autumnal_equinox_day(year)): "秋分の日",
        dt.date(year, 10, _nth_monday(year, 10, 2)): "スポーツの日",
        dt.date(year, 11, 3): "文化の日",
        dt.date(year, 11, 23): "勤労感謝の日",
    }

    all_days = dict(base)

    # 振替休日: 日曜と重なった祝日の後、最も近い「祝日でない日」を休日にする
    for day in sorted(base):
        if day.weekday() != SUNDAY:
            continue
        candidate = day + dt.timedelta(days=1)
        while candidate in all_days:
            candidate += dt.timedelta(days=1)
        if candidate.year == year:
            all_days[candidate] = "振替休日"

    # 国民の休日: 前日と翌日がともに祝日である平日（日曜を除く）
    # 典型例は敬老の日と秋分の日に挟まれた9月の1日
    for day in sorted(base):
        gap = day + dt.timedelta(days=1)
        after = gap + dt.timedelta(days=1)
        if gap.year != year or gap in all_days or gap.weekday() == SUNDAY:
            continue
        if after in base:
            all_days[gap] = "国民の休日"

    return all_days


def holiday_name(day: dt.date) -> str | None:
    """祝日名を返す。祝日でなければ None。"""
    return japanese_holidays(day.year).get(day)


def is_holiday(day: dt.date) -> bool:
    return holiday_name(day) is not None


def is_weekend(day: dt.date) -> bool:
    return day.weekday() >= 5  # 土曜=5, 日曜=6


if __name__ == "__main__":
    import sys

    year = int(sys.argv[1]) if len(sys.argv) > 1 else dt.date.today().year
    for day, name in sorted(japanese_holidays(year).items()):
        print(f"{day} ({'月火水木金土日'[day.weekday()]}) {name}")
