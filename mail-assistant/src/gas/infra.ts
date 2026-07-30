/**
 * その他の GAS アダプタ（状態・時刻・ログ・通知・ロック）。
 */
import type { ClockPort, LoggerPort, NotifierPort, StatePort } from '../ports.js';
import { STATE_KEYS } from '../config.js';
import type { Config } from '../config.js';

export class GasClock implements ClockPort {
  nowMs(): number {
    return Date.now();
  }
}

export class GasState implements StatePort {
  constructor(private readonly properties: GoogleAppsScript.Properties.Properties) {}

  getLastRunAt(): number | null {
    const raw = this.properties.getProperty(STATE_KEYS.LAST_RUN_AT);
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return isFinite(n) && n > 0 ? n : null;
  }

  setLastRunAt(epochMs: number): void {
    this.properties.setProperty(STATE_KEYS.LAST_RUN_AT, String(Math.floor(epochMs)));
  }
}

/**
 * Cloud Logging へ出すロガー。
 *
 * 受信メールの本文・件名・氏名・アドレスは載せない。data に渡すのは
 * ID・件数・区分・ドメイン等に限る（呼び出し側の責任だが、ここでも長さを切る）。
 */
export class GasLogger implements LoggerPort {
  private static readonly MAX_DATA_CHARS = 1200;

  private format(message: string, data?: Readonly<Record<string, unknown>>): string {
    if (data === undefined) return message;
    let json: string;
    try {
      json = JSON.stringify(data);
    } catch {
      json = '[unserializable]';
    }
    if (json.length > GasLogger.MAX_DATA_CHARS) {
      json = `${json.slice(0, GasLogger.MAX_DATA_CHARS)}…`;
    }
    return `${message} ${json}`;
  }

  info(message: string, data?: Readonly<Record<string, unknown>>): void {
    console.log(this.format(message, data));
  }

  warn(message: string, data?: Readonly<Record<string, unknown>>): void {
    console.warn(this.format(message, data));
  }

  error(message: string, data?: Readonly<Record<string, unknown>>): void {
    console.error(this.format(message, data));
  }
}

/**
 * 集計の通知。
 *
 * メール送信は実装しない。SUMMARY_CHANNEL='log' ならログ出力のみ、
 * 'chat' なら Google Chat の Webhook へ POST する。
 */
export class GasNotifier implements NotifierPort {
  constructor(
    private readonly config: Config,
    private readonly logger: LoggerPort,
  ) {}

  notify(text: string): void {
    if (this.config.summaryChannel === 'log' || this.config.chatWebhookUrl === '') {
      this.logger.info(`[日次集計]\n${text}`);
      return;
    }
    try {
      UrlFetchApp.fetch(this.config.chatWebhookUrl, {
        method: 'post',
        contentType: 'application/json; charset=UTF-8',
        payload: JSON.stringify({ text }),
        muteHttpExceptions: true,
      });
    } catch (e) {
      this.logger.warn('Chat 通知に失敗。ログへ出力する', { error: String(e).slice(0, 200) });
      this.logger.info(`[日次集計]\n${text}`);
    }
  }
}

/**
 * スクリプトロック。多重起動を防ぐ。
 * 取得できなければ即座に諦める（次のトリガーで処理すればよい）。
 */
export function withScriptLock<T>(fn: () => T): T | null {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) return null;
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
