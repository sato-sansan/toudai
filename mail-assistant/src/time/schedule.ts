/**
 * 稼働時間・営業日の判定（純関数）。
 *
 * GAS V8 の Intl はタイムゾーン変換に信頼が置けないため、固定オフセット方式で計算する。
 * Asia/Tokyo は DST が無いので常に UTC+9 として正しい（config.ts の TZ_OFFSETS 参照）。
 */
import type { Config } from '../config.js';
import { isJapaneseHoliday, isWeekend, toIsoDate, type CivilDate } from './holidays.js';

export interface ZonedTime extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  /** 0=日曜。 */
  readonly weekday: number;
}

/** epoch ミリ秒を指定オフセットの現地時刻へ。 */
export function toZoned(epochMs: number, offsetMinutes: number): ZonedTime {
  const shifted = new Date(epochMs + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** 稼働時間帯に入っているか。区間は [startHour, endHour)。 */
export function isWithinWorkHours(t: ZonedTime, startHour: number, endHour: number): boolean {
  return t.hour >= startHour && t.hour < endHour;
}

/** 営業日か（土日・祝日・追加休業日の設定を反映）。 */
export function isBusinessDay(t: CivilDate, config: Config): boolean {
  if (config.weekdaysOnly && isWeekend(t)) return false;
  if (config.skipJapaneseHolidays && isJapaneseHoliday(t)) return false;
  if (config.extraHolidays.includes(toIsoDate(t))) return false;
  return true;
}

export interface GateResult {
  readonly ok: boolean;
  /** ok=false のときの理由（ログ用の短い識別子）。 */
  readonly reason: string;
}

/**
 * 今このタイミングで処理を実行してよいか。
 * 時間主導トリガーは 24 時間動くので、実際の絞り込みはここで行う。
 */
export function evaluateRunGate(nowMs: number, config: Config): GateResult {
  const t = toZoned(nowMs, config.timezoneOffsetMinutes);
  if (!isBusinessDay(t, config)) return { ok: false, reason: 'not-business-day' };
  if (!isWithinWorkHours(t, config.workStartHour, config.workEndHour)) {
    return { ok: false, reason: 'outside-work-hours' };
  }
  return { ok: true, reason: '' };
}

/**
 * 受信時刻が処理対象の時間帯か。
 * includeOffHoursReceived=true なら時刻の制約を外す（営業日判定も外す）。
 */
export function isReceivedInScope(receivedAtMs: number, config: Config): boolean {
  if (config.includeOffHoursReceived) return true;
  const t = toZoned(receivedAtMs, config.timezoneOffsetMinutes);
  return isBusinessDay(t, config) && isWithinWorkHours(t, config.workStartHour, config.workEndHour);
}

export interface SearchWindow {
  /** Gmail 検索の after: に渡す epoch 秒。 */
  readonly afterEpochSeconds: number;
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * 検索対象の時間窓を決める。
 *
 * - 前回実行時刻から cursorOverlapMinutes 分だけ巻き戻す（取りこぼし防止。重複は履歴で排除）。
 * - 初回や長期停止後は maxCatchupHours で頭を打つ（大量処理の暴走を防ぐ）。
 */
export function computeSearchWindow(
  nowMs: number,
  lastRunAtMs: number | null,
  config: Config,
): SearchWindow {
  const catchupFloor = nowMs - config.maxCatchupHours * 3_600_000;
  const base = lastRunAtMs === null ? catchupFloor : lastRunAtMs - config.cursorOverlapMinutes * 60_000;
  const fromMs = Math.max(base, catchupFloor);
  return {
    fromMs,
    toMs: nowMs,
    // Gmail の after: は秒単位。切り捨てて範囲を広めに取る。
    afterEpochSeconds: Math.floor(fromMs / 1000),
  };
}
