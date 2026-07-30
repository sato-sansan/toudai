/**
 * 設定。
 *
 * 値はすべて Script Properties（GAS）から文字列で来る。ここで型付き・既定値付きに
 * 正規化し、以降のコードは Config だけを見る。コードへの直書きを禁止する。
 *
 * 安全側の既定値:
 *   - dryRun = true          … 明示的に false にするまで Gmail へ一切書き込まない
 *   - reviewCreatesDraft = false … REVIEW_REQUIRED ではラベルのみ
 *   - ccMode = 'none'        … 勝手に Cc を広げない
 *   - summaryChannel = 'log' … メール送信は実装しない
 */

export type CcMode = 'none' | 'mirror-previous';
export type SummaryChannel = 'log' | 'chat';

export interface Config {
  // --- 対象 ---
  readonly targetEmail: string;
  // --- 時刻・稼働条件 ---
  readonly timezone: string;
  /** timezone に対応する UTC オフセット（分）。DST の無いゾーンのみ対応。 */
  readonly timezoneOffsetMinutes: number;
  readonly workStartHour: number;
  readonly workEndHour: number;
  readonly runIntervalMinutes: number;
  readonly weekdaysOnly: boolean;
  readonly skipJapaneseHolidays: boolean;
  /** 追加の休業日（YYYY-MM-DD）。 */
  readonly extraHolidays: readonly string[];
  /** 稼働時間外に受信したメールも対象にするか。 */
  readonly includeOffHoursReceived: boolean;
  /** 未処理メールを遡る上限（時間）。実行漏れの補完幅。 */
  readonly maxCatchupHours: number;
  /** 前回実行時刻から巻き戻して検索する余裕（分）。取りこぼし防止。 */
  readonly cursorOverlapMinutes: number;
  // --- 過去メール分析 ---
  readonly historyLookbackMonths: number;
  readonly historyMaxMessages: number;
  readonly threadMaxMessages: number;
  /** AI へ渡す1メールあたりの最大文字数。 */
  readonly bodyMaxChars: number;
  // --- AI ---
  readonly geminiApiKey: string;
  readonly geminiModel: string;
  readonly geminiThinkingBudget: number;
  readonly confidenceReplyThreshold: number;
  readonly confidenceReviewThreshold: number;
  // --- 動作 ---
  readonly reviewCreatesDraft: boolean;
  readonly ccMode: CcMode;
  readonly signatureText: string;
  readonly importantKeywords: readonly string[];
  readonly notifySenderPatterns: readonly string[];
  readonly retryMax: number;
  // --- ラベル ---
  readonly labelDraft: string;
  readonly labelReview: string;
  readonly labelNoReply: string;
  readonly labelDone: string;
  readonly labelError: string;
  /** 空文字ならラベル付与しない（重要メールはログのみ）。 */
  readonly labelImportant: string;
  // --- テスト・安全 ---
  readonly dryRun: boolean;
  readonly testMode: boolean;
  readonly testLabel: string;
  readonly testSenders: readonly string[];
  readonly maxMessagesPerRun: number;
  /** プレビューに生成した返信案を含めるか（受信本文は常に含めない）。 */
  readonly previewIncludeDraft: boolean;
  // --- 履歴・通知 ---
  readonly historySheetId: string;
  readonly summaryEnabled: boolean;
  readonly summaryChannel: SummaryChannel;
  readonly chatWebhookUrl: string;
}

/** DST を持たないタイムゾーンのみ（Intl は GAS で信頼できないため固定表）。 */
const TZ_OFFSETS: Readonly<Record<string, number>> = {
  'Asia/Tokyo': 540,
  'Asia/Seoul': 540,
  'Asia/Shanghai': 480,
  'Asia/Singapore': 480,
  'Asia/Kolkata': 330,
  UTC: 0,
};

/** GAS の時間主導トリガーが受け付ける分間隔。 */
export const ALLOWED_INTERVALS = [1, 5, 10, 15, 30] as const;

export const DEFAULTS = {
  TARGET_EMAIL: 'sato@sanrikutech.jp',
  TIMEZONE: 'Asia/Tokyo',
  WORK_START_HOUR: '8',
  WORK_END_HOUR: '18',
  RUN_INTERVAL_MINUTES: '10',
  WEEKDAYS_ONLY: 'true',
  SKIP_JP_HOLIDAYS: 'true',
  EXTRA_HOLIDAYS: '',
  INCLUDE_OFF_HOURS_RECEIVED: 'false',
  MAX_CATCHUP_HOURS: '96',
  CURSOR_OVERLAP_MINUTES: '30',
  HISTORY_LOOKBACK_MONTHS: '12',
  HISTORY_MAX_MESSAGES: '30',
  THREAD_MAX_MESSAGES: '10',
  BODY_MAX_CHARS: '4000',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_THINKING_BUDGET: '0',
  CONFIDENCE_REPLY_THRESHOLD: '0.85',
  CONFIDENCE_REVIEW_THRESHOLD: '0.60',
  REVIEW_CREATES_DRAFT: 'false',
  CC_MODE: 'none',
  SIGNATURE_TEXT: '',
  IMPORTANT_KEYWORDS:
    '請求,契約,見積,支払,振込,入金,解約,納期,セキュリティ,invoice,contract,security,payment',
  NOTIFY_SENDER_PATTERNS:
    'no-reply,noreply,do-not-reply,donotreply,notifications@,notification@,mailer-daemon,postmaster,bounce',
  RETRY_MAX: '2',
  LABEL_DRAFT: 'AI返信下書き',
  LABEL_REVIEW: 'AI要確認',
  LABEL_NO_REPLY: 'AI返信不要',
  LABEL_DONE: 'AI処理済み',
  LABEL_ERROR: 'AI処理エラー',
  LABEL_IMPORTANT: '',
  DRY_RUN: 'true',
  TEST_MODE: 'false',
  TEST_LABEL: 'AIテスト対象',
  TEST_SENDERS: '',
  MAX_MESSAGES_PER_RUN: '20',
  PREVIEW_INCLUDE_DRAFT: 'true',
  HISTORY_SHEET_ID: '',
  SUMMARY_ENABLED: 'true',
  SUMMARY_CHANNEL: 'log',
  CHAT_WEBHOOK_URL: '',
} as const;

/** 設定として読まないキー（実行状態）。 */
export const STATE_KEYS = { LAST_RUN_AT: 'STATE_LAST_RUN_AT' } as const;

/** 秘密として扱い、ログ・プレビューへ出さないキー。 */
export const SECRET_KEYS: readonly string[] = ['GEMINI_API_KEY', 'CHAT_WEBHOOK_URL'];

export class ConfigError extends Error {}

type Raw = Readonly<Record<string, string | undefined>>;

function str(raw: Raw, key: keyof typeof DEFAULTS | 'GEMINI_API_KEY'): string {
  const v = raw[key];
  if (v !== undefined && v !== '') return v.trim();
  const d = (DEFAULTS as Readonly<Record<string, string>>)[key];
  return d === undefined ? '' : d;
}

function bool(raw: Raw, key: keyof typeof DEFAULTS): boolean {
  const v = str(raw, key).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off', ''].includes(v)) return false;
  throw new ConfigError(`${key} は true/false で指定してください（現在: ${v}）`);
}

function num(raw: Raw, key: keyof typeof DEFAULTS, min: number, max: number): number {
  const v = Number(str(raw, key));
  if (!isFinite(v)) throw new ConfigError(`${key} は数値で指定してください`);
  if (v < min || v > max) throw new ConfigError(`${key} は ${min}〜${max} の範囲で指定してください（現在: ${v}）`);
  return v;
}

function list(raw: Raw, key: keyof typeof DEFAULTS): readonly string[] {
  return str(raw, key)
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Script Properties 相当の文字列マップから Config を組み立てる。
 * 不正値は例外にする（安全側に倒し、実行を止める）。
 */
export function loadConfig(raw: Raw): Config {
  const timezone = str(raw, 'TIMEZONE');
  const offset = TZ_OFFSETS[timezone];
  if (offset === undefined) {
    throw new ConfigError(
      `TIMEZONE "${timezone}" は未対応です。対応: ${Object.keys(TZ_OFFSETS).join(', ')}`,
    );
  }

  const workStartHour = num(raw, 'WORK_START_HOUR', 0, 23);
  const workEndHour = num(raw, 'WORK_END_HOUR', 1, 24);
  if (workStartHour >= workEndHour) {
    throw new ConfigError('WORK_START_HOUR は WORK_END_HOUR より小さくしてください');
  }

  const runIntervalMinutes = num(raw, 'RUN_INTERVAL_MINUTES', 1, 30);
  if (!(ALLOWED_INTERVALS as readonly number[]).includes(runIntervalMinutes)) {
    throw new ConfigError(
      `RUN_INTERVAL_MINUTES は ${ALLOWED_INTERVALS.join(' / ')} のいずれかにしてください（GAS の制約）`,
    );
  }

  const replyThreshold = num(raw, 'CONFIDENCE_REPLY_THRESHOLD', 0, 1);
  const reviewThreshold = num(raw, 'CONFIDENCE_REVIEW_THRESHOLD', 0, 1);
  if (reviewThreshold > replyThreshold) {
    throw new ConfigError(
      'CONFIDENCE_REVIEW_THRESHOLD は CONFIDENCE_REPLY_THRESHOLD 以下にしてください',
    );
  }

  const extraHolidays = list(raw, 'EXTRA_HOLIDAYS');
  for (const d of extraHolidays) {
    if (!DATE_RE.test(d)) throw new ConfigError(`EXTRA_HOLIDAYS の "${d}" は YYYY-MM-DD 形式にしてください`);
  }

  const ccModeRaw = str(raw, 'CC_MODE');
  if (ccModeRaw !== 'none' && ccModeRaw !== 'mirror-previous') {
    throw new ConfigError('CC_MODE は none / mirror-previous のいずれかにしてください');
  }

  const summaryChannelRaw = str(raw, 'SUMMARY_CHANNEL');
  if (summaryChannelRaw !== 'log' && summaryChannelRaw !== 'chat') {
    throw new ConfigError('SUMMARY_CHANNEL は log / chat のいずれかにしてください');
  }

  const targetEmail = str(raw, 'TARGET_EMAIL').toLowerCase();
  if (!targetEmail.includes('@')) throw new ConfigError('TARGET_EMAIL が不正です');

  return {
    targetEmail,
    timezone,
    timezoneOffsetMinutes: offset,
    workStartHour,
    workEndHour,
    runIntervalMinutes,
    weekdaysOnly: bool(raw, 'WEEKDAYS_ONLY'),
    skipJapaneseHolidays: bool(raw, 'SKIP_JP_HOLIDAYS'),
    extraHolidays,
    includeOffHoursReceived: bool(raw, 'INCLUDE_OFF_HOURS_RECEIVED'),
    maxCatchupHours: num(raw, 'MAX_CATCHUP_HOURS', 1, 720),
    cursorOverlapMinutes: num(raw, 'CURSOR_OVERLAP_MINUTES', 0, 720),
    historyLookbackMonths: num(raw, 'HISTORY_LOOKBACK_MONTHS', 1, 60),
    historyMaxMessages: num(raw, 'HISTORY_MAX_MESSAGES', 1, 200),
    threadMaxMessages: num(raw, 'THREAD_MAX_MESSAGES', 1, 100),
    bodyMaxChars: num(raw, 'BODY_MAX_CHARS', 200, 40000),
    geminiApiKey: str(raw, 'GEMINI_API_KEY'),
    geminiModel: str(raw, 'GEMINI_MODEL'),
    geminiThinkingBudget: num(raw, 'GEMINI_THINKING_BUDGET', 0, 24576),
    confidenceReplyThreshold: replyThreshold,
    confidenceReviewThreshold: reviewThreshold,
    reviewCreatesDraft: bool(raw, 'REVIEW_CREATES_DRAFT'),
    ccMode: ccModeRaw,
    signatureText: str(raw, 'SIGNATURE_TEXT'),
    importantKeywords: list(raw, 'IMPORTANT_KEYWORDS'),
    notifySenderPatterns: list(raw, 'NOTIFY_SENDER_PATTERNS'),
    retryMax: num(raw, 'RETRY_MAX', 0, 10),
    labelDraft: str(raw, 'LABEL_DRAFT'),
    labelReview: str(raw, 'LABEL_REVIEW'),
    labelNoReply: str(raw, 'LABEL_NO_REPLY'),
    labelDone: str(raw, 'LABEL_DONE'),
    labelError: str(raw, 'LABEL_ERROR'),
    labelImportant: str(raw, 'LABEL_IMPORTANT'),
    dryRun: bool(raw, 'DRY_RUN'),
    testMode: bool(raw, 'TEST_MODE'),
    testLabel: str(raw, 'TEST_LABEL'),
    testSenders: list(raw, 'TEST_SENDERS').map((s) => s.toLowerCase()),
    maxMessagesPerRun: num(raw, 'MAX_MESSAGES_PER_RUN', 1, 100),
    previewIncludeDraft: bool(raw, 'PREVIEW_INCLUDE_DRAFT'),
    historySheetId: str(raw, 'HISTORY_SHEET_ID'),
    summaryEnabled: bool(raw, 'SUMMARY_ENABLED'),
    summaryChannel: summaryChannelRaw,
    chatWebhookUrl: str(raw, 'CHAT_WEBHOOK_URL'),
  };
}

/** 設定を人が確認するための表示用（秘密は伏せる）。 */
export function describeConfig(config: Config): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(config)) {
    out[k] = Array.isArray(v) ? v.join(',') : String(v);
  }
  out['geminiApiKey'] = config.geminiApiKey ? '***set***' : '(未設定)';
  out['chatWebhookUrl'] = config.chatWebhookUrl ? '***set***' : '(未設定)';
  return out;
}
