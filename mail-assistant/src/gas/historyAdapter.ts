/**
 * 処理履歴アダプタ。
 *
 * 保存先はスプレッドシート。理由: message ID・判定・確信度・下書き ID 等の表形式ログに
 * 最も適しており、人が直接開いて監査できる。PropertiesService は 9KB/値・500KB 合計の
 * 制限があり日次で増える履歴には向かない。
 *
 * HISTORY_SHEET_ID が未設定のときは PropertiesService に直近分だけを保持する
 * フォールバックへ切り替える（スプレッドシートのスコープを付けずに試せるようにするため）。
 *
 * 保存しないもの: 本文、件名、氏名、メールアドレスの局所部。
 */
import type { HistoryPort, LoggerPort } from '../ports.js';
import type { Classification, ProcessingRecord, Action } from '../types.js';
import { CLASSIFICATIONS } from '../types.js';

const SHEET_NAME = 'history';
const HEADERS = [
  'processedAt',
  'messageId',
  'threadId',
  'receivedAt',
  'classification',
  'confidence',
  'action',
  'draftId',
  'error',
  'model',
  'important',
  'injectionSuspected',
  'senderDomain',
  'reasonCode',
] as const;

function toRow(record: ProcessingRecord): unknown[] {
  return [
    record.processedAt,
    record.messageId,
    record.threadId,
    record.receivedAt,
    record.classification,
    record.confidence,
    record.action,
    record.draftId,
    record.error,
    record.model,
    record.important ? 'TRUE' : 'FALSE',
    record.injectionSuspected ? 'TRUE' : 'FALSE',
    record.senderDomain,
    record.reasonCode,
  ];
}

function isClassification(value: string): value is Classification {
  return (CLASSIFICATIONS as readonly string[]).includes(value);
}

function fromRow(row: readonly unknown[]): ProcessingRecord | null {
  const str = (i: number): string => {
    const v = row[i];
    return v === undefined || v === null ? '' : String(v);
  };
  const messageId = str(1);
  if (messageId === '') return null;
  const classification = str(4);
  return {
    processedAt: str(0),
    messageId,
    threadId: str(2),
    receivedAt: str(3),
    classification: isClassification(classification) ? classification : 'REVIEW_REQUIRED',
    confidence: Number(str(5)) || 0,
    action: (str(6) || 'log-only') as Action,
    draftId: str(7),
    error: str(8),
    model: str(9),
    important: str(10).toUpperCase() === 'TRUE',
    injectionSuspected: str(11).toUpperCase() === 'TRUE',
    senderDomain: str(12),
    reasonCode: str(13),
  };
}

export class SpreadsheetHistoryAdapter implements HistoryPort {
  private cache: Map<string, ProcessingRecord> | null = null;

  constructor(
    private readonly sheetId: string,
    private readonly logger: LoggerPort,
  ) {}

  private sheet(): GoogleAppsScript.Spreadsheet.Sheet {
    const ss = SpreadsheetApp.openById(this.sheetId);
    let sheet = ss.getSheetByName(SHEET_NAME);
    if (sheet === null) {
      sheet = ss.insertSheet(SHEET_NAME);
      sheet.appendRow(HEADERS.slice());
      sheet.setFrozenRows(1);
    }
    return sheet;
  }

  private allRecords(): ProcessingRecord[] {
    const sheet = this.sheet();
    const lastRow = sheet.getLastRow();
    if (lastRow <= 1) return [];
    const values = sheet.getRange(2, 1, lastRow - 1, HEADERS.length).getValues();
    const out: ProcessingRecord[] = [];
    for (const row of values) {
      const record = fromRow(row);
      if (record !== null) out.push(record);
    }
    return out;
  }

  loadProcessed(): ReadonlyMap<string, ProcessingRecord> {
    if (this.cache !== null) return this.cache;
    const map = new Map<string, ProcessingRecord>();
    try {
      for (const record of this.allRecords()) {
        map.set(record.messageId, record);
      }
    } catch (e) {
      this.logger.warn('履歴の読み込みに失敗（重複判定が効かない可能性あり）', {
        error: String(e).slice(0, 200),
      });
    }
    this.cache = map;
    return map;
  }

  append(record: ProcessingRecord): void {
    this.sheet().appendRow(toRow(record));
    this.cache?.set(record.messageId, record);
  }

  recordsForDate(isoDate: string): readonly ProcessingRecord[] {
    try {
      return this.allRecords().filter((r) => r.processedAt.startsWith(isoDate));
    } catch (e) {
      this.logger.warn('履歴の集計読み込みに失敗', { error: String(e).slice(0, 200) });
      return [];
    }
  }
}

const PROPS_KEY = 'STATE_HISTORY_FALLBACK';
const PROPS_MAX_RECORDS = 400;

/**
 * スプレッドシート未設定時のフォールバック。
 * 直近 PROPS_MAX_RECORDS 件だけを保持する（PropertiesService の容量制限のため）。
 */
export class PropertiesHistoryAdapter implements HistoryPort {
  private records: ProcessingRecord[] | null = null;

  constructor(
    private readonly properties: GoogleAppsScript.Properties.Properties,
    private readonly logger: LoggerPort,
  ) {}

  private load(): ProcessingRecord[] {
    if (this.records !== null) return this.records;
    const raw = this.properties.getProperty(PROPS_KEY);
    if (raw === null || raw === '') {
      this.records = [];
      return this.records;
    }
    try {
      const parsed = JSON.parse(raw) as ProcessingRecord[];
      this.records = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      this.logger.warn('履歴フォールバックの読み込みに失敗。空として扱う', {
        error: String(e).slice(0, 200),
      });
      this.records = [];
    }
    return this.records;
  }

  private persist(): void {
    const records = this.load();
    const trimmed = records.slice(Math.max(0, records.length - PROPS_MAX_RECORDS));
    this.records = trimmed;
    this.properties.setProperty(PROPS_KEY, JSON.stringify(trimmed));
  }

  loadProcessed(): ReadonlyMap<string, ProcessingRecord> {
    const map = new Map<string, ProcessingRecord>();
    for (const r of this.load()) map.set(r.messageId, r);
    return map;
  }

  append(record: ProcessingRecord): void {
    this.load().push(record);
    this.persist();
  }

  recordsForDate(isoDate: string): readonly ProcessingRecord[] {
    return this.load().filter((r) => r.processedAt.startsWith(isoDate));
  }
}
