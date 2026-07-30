import { describe, expect, it } from 'vitest';
import {
  isJapaneseHoliday,
  japaneseHolidayName,
  japaneseHolidays,
  isWeekend,
  toIsoDate,
  weekdayOf,
} from '../src/time/holidays.js';
import {
  computeSearchWindow,
  evaluateRunGate,
  isBusinessDay,
  isReceivedInScope,
  isWithinWorkHours,
  toZoned,
} from '../src/time/schedule.js';
import { makeConfig } from './fakes.js';

describe('holidays', () => {
  it('固定日の祝日を判定する', () => {
    expect(japaneseHolidayName({ year: 2026, month: 1, day: 1 })).toBe('元日');
    expect(japaneseHolidayName({ year: 2026, month: 2, day: 11 })).toBe('建国記念の日');
    expect(japaneseHolidayName({ year: 2026, month: 5, day: 5 })).toBe('こどもの日');
    expect(japaneseHolidayName({ year: 2026, month: 11, day: 23 })).toBe('勤労感謝の日');
  });

  it('ハッピーマンデーを算出する', () => {
    // 2026-01-12 は1月第2月曜
    expect(japaneseHolidayName({ year: 2026, month: 1, day: 12 })).toBe('成人の日');
    expect(weekdayOf({ year: 2026, month: 1, day: 12 })).toBe(1);
    // 2026-07-20 は7月第3月曜
    expect(japaneseHolidayName({ year: 2026, month: 7, day: 20 })).toBe('海の日');
    // 2026-10-12 は10月第2月曜
    expect(japaneseHolidayName({ year: 2026, month: 10, day: 12 })).toBe('スポーツの日');
  });

  it('春分・秋分を算出する', () => {
    expect(japaneseHolidayName({ year: 2026, month: 3, day: 20 })).toBe('春分の日');
    expect(japaneseHolidayName({ year: 2026, month: 9, day: 23 })).toBe('秋分の日');
  });

  it('日曜と重なった祝日の振替休日を作る', () => {
    // 2026-02-23（天皇誕生日）は月曜なので振替なし
    expect(japaneseHolidayName({ year: 2026, month: 2, day: 24 })).toBeNull();
    // 2027-02-11 は木曜、2032-02-11 は水曜…日曜になる年で検証する
    // 2029-02-11 は日曜 → 2029-02-12 が振替休日
    expect(weekdayOf({ year: 2029, month: 2, day: 11 })).toBe(0);
    expect(japaneseHolidayName({ year: 2029, month: 2, day: 12 })).toBe('振替休日');
  });

  it('国民の休日を作る（敬老の日と秋分の日に挟まれた日）', () => {
    // 2026: 敬老の日 9/21(月), 秋分の日 9/23(水) → 9/22(火) が国民の休日
    expect(japaneseHolidayName({ year: 2026, month: 9, day: 21 })).toBe('敬老の日');
    expect(japaneseHolidayName({ year: 2026, month: 9, day: 23 })).toBe('秋分の日');
    expect(japaneseHolidayName({ year: 2026, month: 9, day: 22 })).toBe('国民の休日');
  });

  it('平日は祝日ではない', () => {
    expect(isJapaneseHoliday({ year: 2026, month: 7, day: 30 })).toBe(false);
  });

  it('土日を判定する', () => {
    // 2026-08-01 は土曜, 08-02 は日曜
    expect(isWeekend({ year: 2026, month: 8, day: 1 })).toBe(true);
    expect(isWeekend({ year: 2026, month: 8, day: 2 })).toBe(true);
    expect(isWeekend({ year: 2026, month: 7, day: 30 })).toBe(false);
  });

  it('祝日表をキャッシュしても同じ結果を返す', () => {
    const a = japaneseHolidays(2026);
    const b = japaneseHolidays(2026);
    expect(a).toBe(b);
    expect(toIsoDate({ year: 2026, month: 1, day: 1 })).toBe('2026-01-01');
  });
});

describe('schedule', () => {
  const config = makeConfig();

  it('JST へ変換する', () => {
    // 2026-07-30 01:00 UTC = 10:00 JST
    const z = toZoned(Date.UTC(2026, 6, 30, 1, 0), 540);
    expect(z.year).toBe(2026);
    expect(z.month).toBe(7);
    expect(z.day).toBe(30);
    expect(z.hour).toBe(10);
  });

  it('日付を跨ぐ変換が正しい', () => {
    // 2026-07-29 22:00 UTC = 2026-07-30 07:00 JST
    const z = toZoned(Date.UTC(2026, 6, 29, 22, 0), 540);
    expect(z.day).toBe(30);
    expect(z.hour).toBe(7);
  });

  it('稼働時間帯は [開始, 終了)', () => {
    const at = (h: number) => ({ year: 2026, month: 7, day: 30, hour: h, minute: 0, weekday: 4 });
    expect(isWithinWorkHours(at(7), 8, 18)).toBe(false);
    expect(isWithinWorkHours(at(8), 8, 18)).toBe(true);
    expect(isWithinWorkHours(at(17), 8, 18)).toBe(true);
    expect(isWithinWorkHours(at(18), 8, 18)).toBe(false);
  });

  it('土日・祝日は営業日ではない', () => {
    expect(isBusinessDay({ year: 2026, month: 7, day: 30 }, config)).toBe(true);
    expect(isBusinessDay({ year: 2026, month: 8, day: 1 }, config)).toBe(false);
    expect(isBusinessDay({ year: 2026, month: 7, day: 20 }, config)).toBe(false);
  });

  it('祝日除外を無効にすると祝日も営業日になる', () => {
    const noHoliday = makeConfig({ SKIP_JP_HOLIDAYS: 'false' });
    expect(isBusinessDay({ year: 2026, month: 7, day: 20 }, noHoliday)).toBe(true);
  });

  it('EXTRA_HOLIDAYS を休業日として扱う', () => {
    const withExtra = makeConfig({ EXTRA_HOLIDAYS: '2026-07-30' });
    expect(isBusinessDay({ year: 2026, month: 7, day: 30 }, withExtra)).toBe(false);
  });

  it('稼働ゲート: 平日日中は通す', () => {
    expect(evaluateRunGate(Date.UTC(2026, 6, 30, 1, 0), config)).toEqual({ ok: true, reason: '' });
  });

  it('稼働ゲート: 時間外は止める', () => {
    // 2026-07-30 22:00 JST
    const r = evaluateRunGate(Date.UTC(2026, 6, 30, 13, 0), config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('outside-work-hours');
  });

  it('稼働ゲート: 土曜は止める', () => {
    // 2026-08-01(土) 10:00 JST
    const r = evaluateRunGate(Date.UTC(2026, 7, 1, 1, 0), config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-business-day');
  });

  it('稼働ゲート: 祝日は止める', () => {
    // 2026-07-20(海の日) 10:00 JST
    const r = evaluateRunGate(Date.UTC(2026, 6, 20, 1, 0), config);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not-business-day');
  });

  it('受信時刻ゲート: 稼働時間内の受信のみ対象', () => {
    expect(isReceivedInScope(Date.UTC(2026, 6, 30, 1, 0), config)).toBe(true);
    // 22:00 JST 受信
    expect(isReceivedInScope(Date.UTC(2026, 6, 30, 13, 0), config)).toBe(false);
    // 土曜受信
    expect(isReceivedInScope(Date.UTC(2026, 7, 1, 1, 0), config)).toBe(false);
  });

  it('INCLUDE_OFF_HOURS_RECEIVED=true なら受信時刻を問わない', () => {
    const anytime = makeConfig({ INCLUDE_OFF_HOURS_RECEIVED: 'true' });
    expect(isReceivedInScope(Date.UTC(2026, 6, 30, 13, 0), anytime)).toBe(true);
    expect(isReceivedInScope(Date.UTC(2026, 7, 1, 1, 0), anytime)).toBe(true);
  });

  it('検索窓: 前回実行時刻から余裕分だけ巻き戻す', () => {
    const now = Date.UTC(2026, 6, 30, 1, 0);
    const last = now - 10 * 60_000;
    const w = computeSearchWindow(now, last, config);
    // 30分の余裕なので last - 30min
    expect(w.fromMs).toBe(last - 30 * 60_000);
    expect(w.afterEpochSeconds).toBe(Math.floor(w.fromMs / 1000));
  });

  it('検索窓: 初回は maxCatchupHours まで遡る', () => {
    const now = Date.UTC(2026, 6, 30, 1, 0);
    const w = computeSearchWindow(now, null, config);
    expect(w.fromMs).toBe(now - 96 * 3_600_000);
  });

  it('検索窓: 長期停止後も maxCatchupHours で頭打ちにする', () => {
    const now = Date.UTC(2026, 6, 30, 1, 0);
    const last = now - 365 * 24 * 3_600_000;
    const w = computeSearchWindow(now, last, config);
    expect(w.fromMs).toBe(now - 96 * 3_600_000);
  });

  it('検索窓: 連休明けでも金曜夕方をカバーする', () => {
    // 月曜 8:00 JST に実行、前回は金曜 17:50 JST
    const monday8 = Date.UTC(2026, 7, 3, 23, 0); // 2026-08-04 08:00 JST
    const friday1750 = Date.UTC(2026, 6, 31, 8, 50); // 2026-07-31 17:50 JST
    const w = computeSearchWindow(monday8, friday1750, makeConfig());
    expect(w.fromMs).toBeLessThanOrEqual(friday1750);
  });
});
