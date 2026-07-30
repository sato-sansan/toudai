/**
 * 日本の祝日判定（純関数・ネットワーク不要）。
 *
 * Google カレンダーの「日本の祝日」を読む方法もあるが、CalendarApp のスコープが増えるため
 * 最小権限の方針に反する。祝日法は決定的な計算で表現できるので自前計算にする。
 *
 * 対応範囲: 2022年以降の現行祝日法（1948年法の最新改正）。
 *   - 2020/2021 の東京五輪特例（海の日・スポーツの日・山の日の移動）は再現しない。
 *   - 春分/秋分の近似式は 1980〜2099 年が有効範囲。
 * 範囲外の年や特例日は Config.extraHolidays（EXTRA_HOLIDAYS）で補える。
 */

/** タイムゾーンに依存しない「暦日」。month は 1〜12。 */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const SUNDAY = 0;
export const SATURDAY = 6;

/** 暦日の曜日（0=日曜）。UTC 固定で計算するのでタイムゾーンの影響を受けない。 */
export function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** "YYYY-MM-DD" 形式へ。 */
export function toIsoDate(date: CivilDate): string {
  const mm = String(date.month).padStart(2, '0');
  const dd = String(date.day).padStart(2, '0');
  return `${date.year}-${mm}-${dd}`;
}

/** "MM-DD" 形式へ（年内キー）。 */
function toMonthDay(month: number, day: number): string {
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(date: CivilDate, days: number): CivilDate {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** その月の n 番目の月曜日。 */
function nthMonday(year: number, month: number, nth: number): number {
  const firstWeekday = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  // 月曜(1)までのオフセット
  const offsetToMonday = (8 - firstWeekday) % 7;
  return 1 + offsetToMonday + (nth - 1) * 7;
}

/** 春分の日（1980〜2099 の近似式）。 */
function vernalEquinoxDay(year: number): number {
  return Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

/** 秋分の日（1980〜2099 の近似式）。 */
function autumnalEquinoxDay(year: number): number {
  return Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4));
}

const holidayCache = new Map<number, ReadonlyMap<string, string>>();

/**
 * 指定年の祝日表（"MM-DD" → 祝日名）。振替休日・国民の休日を含む。
 */
export function japaneseHolidays(year: number): ReadonlyMap<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;

  const base = new Map<string, string>();
  const put = (month: number, day: number, name: string): void => {
    base.set(toMonthDay(month, day), name);
  };

  put(1, 1, '元日');
  put(1, nthMonday(year, 1, 2), '成人の日');
  put(2, 11, '建国記念の日');
  put(2, 23, '天皇誕生日');
  put(3, vernalEquinoxDay(year), '春分の日');
  put(4, 29, '昭和の日');
  put(5, 3, '憲法記念日');
  put(5, 4, 'みどりの日');
  put(5, 5, 'こどもの日');
  put(7, nthMonday(year, 7, 3), '海の日');
  put(8, 11, '山の日');
  put(9, nthMonday(year, 9, 3), '敬老の日');
  put(9, autumnalEquinoxDay(year), '秋分の日');
  put(10, nthMonday(year, 10, 2), 'スポーツの日');
  put(11, 3, '文化の日');
  put(11, 23, '勤労感謝の日');

  const all = new Map(base);

  // 振替休日: 日曜と重なった祝日の後、最も近い「祝日でない日」を休日にする。
  for (const key of Array.from(base.keys()).sort()) {
    const parts = key.split('-');
    const month = Number(parts[0]);
    const day = Number(parts[1]);
    if (weekdayOf({ year, month, day }) !== SUNDAY) continue;
    let candidate = addDays({ year, month, day }, 1);
    while (all.has(toMonthDay(candidate.month, candidate.day)) && candidate.year === year) {
      candidate = addDays(candidate, 1);
    }
    if (candidate.year === year) {
      all.set(toMonthDay(candidate.month, candidate.day), '振替休日');
    }
  }

  // 国民の休日: 前日と翌日がともに祝日である平日（日曜・振替休日を除く）。
  // 典型例は敬老の日と秋分の日に挟まれた9月の1日。
  for (const key of Array.from(base.keys())) {
    const parts = key.split('-');
    const month = Number(parts[0]);
    const day = Number(parts[1]);
    const gap = addDays({ year, month, day }, 1);
    const after = addDays(gap, 1);
    if (gap.year !== year) continue;
    const gapKey = toMonthDay(gap.month, gap.day);
    if (all.has(gapKey)) continue;
    if (weekdayOf(gap) === SUNDAY) continue;
    if (!base.has(toMonthDay(after.month, after.day))) continue;
    all.set(gapKey, '国民の休日');
  }

  holidayCache.set(year, all);
  return all;
}

/** 祝日名を返す。祝日でなければ null。 */
export function japaneseHolidayName(date: CivilDate): string | null {
  return japaneseHolidays(date.year).get(toMonthDay(date.month, date.day)) ?? null;
}

export function isJapaneseHoliday(date: CivilDate): boolean {
  return japaneseHolidayName(date) !== null;
}

/** 土日か。 */
export function isWeekend(date: CivilDate): boolean {
  const w = weekdayOf(date);
  return w === SUNDAY || w === SATURDAY;
}
