/**
 * 外部依存の境界（ポート）。
 *
 * pipeline.ts はこのインターフェースだけを見る。GAS 実装は src/gas/ に、
 * テスト実装は tests/fakes.ts に置く。これで GAS 無しに全シナリオを検証できる。
 *
 * 重要: このインターフェースに「送信」に相当するメソッドは存在しない。
 * パイプラインから送信を呼ぶ手段が型レベルで無い、というのが自動送信防止の一次防衛線。
 */
import type { MailMessage, MailThread, ProcessingRecord } from './types.js';

export interface DraftRequest {
  readonly threadId: string;
  /** RFC 5322 のメッセージ全体（mime.ts が組み立てたもの）。 */
  readonly raw: string;
}

export interface GmailPort {
  /** 検索して message ID の一覧を返す（新しい順）。 */
  searchMessageIds(query: string, maxResults: number): readonly string[];
  /** 1メッセージを取得。 */
  getMessage(id: string): MailMessage;
  /** スレッド全体を取得（messages は古い順）。取得できなければ null。 */
  getThread(threadId: string): MailThread | null;
  /** 返信下書きを作成し、下書き ID を返す。送信は行わない。 */
  createDraft(request: DraftRequest): string;
  /** スレッドに下書きが存在するか。 */
  threadHasDraft(threadId: string): boolean;
  /** ラベルを用意して ID を返す（無ければ作成）。 */
  ensureLabel(name: string): string;
  /** スレッドにラベルを付ける。既読化・アーカイブ・削除は行わない。 */
  addThreadLabels(threadId: string, labelIds: readonly string[]): void;
}

export interface AiPort {
  /** 生成結果のテキストを返す。失敗時は例外を投げる。 */
  generate(system: string, user: string): string;
  /** 実際に使ったモデル識別子。 */
  readonly modelId: string;
}

export interface HistoryPort {
  /** 処理済み message ID → 記録（同一 ID の最新のもの）。 */
  loadProcessed(): ReadonlyMap<string, ProcessingRecord>;
  append(record: ProcessingRecord): void;
  /** 指定日（YYYY-MM-DD、現地時刻基準）の記録。 */
  recordsForDate(isoDate: string): readonly ProcessingRecord[];
}

export interface StatePort {
  getLastRunAt(): number | null;
  setLastRunAt(epochMs: number): void;
}

export interface ClockPort {
  nowMs(): number;
}

export interface LoggerPort {
  info(message: string, data?: Readonly<Record<string, unknown>>): void;
  warn(message: string, data?: Readonly<Record<string, unknown>>): void;
  error(message: string, data?: Readonly<Record<string, unknown>>): void;
}

export interface NotifierPort {
  /** 集計結果を通知する（ログ or Google Chat）。メール送信は実装しない。 */
  notify(text: string): void;
}

export interface Ports {
  readonly gmail: GmailPort;
  readonly ai: AiPort;
  readonly history: HistoryPort;
  readonly state: StatePort;
  readonly clock: ClockPort;
  readonly logger: LoggerPort;
  readonly notifier: NotifierPort;
}
