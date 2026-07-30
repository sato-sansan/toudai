/**
 * テスト用のポート実装とファクトリ。
 *
 * GAS を一切使わずに pipeline 全体を回すための土台。
 */
import { loadConfig, type Config } from '../src/config.js';
import type {
  AiPort,
  ClockPort,
  DraftRequest,
  GmailPort,
  HistoryPort,
  LoggerPort,
  NotifierPort,
  Ports,
  StatePort,
} from '../src/ports.js';
import type { EmailAddress, MailMessage, MailThread, ProcessingRecord } from '../src/types.js';

export const TARGET = 'sato@sanrikutech.jp';

/** 2026-07-30(木) 10:00 JST = 01:00 UTC。 */
export const THURSDAY_10AM_JST = Date.UTC(2026, 6, 30, 1, 0, 0);

export function makeConfig(overrides: Readonly<Record<string, string>> = {}): Config {
  return loadConfig({ TARGET_EMAIL: TARGET, GEMINI_API_KEY: 'test-key', ...overrides });
}

export function addr(email: string, name = ''): EmailAddress {
  return { email: email.toLowerCase(), name };
}

let messageCounter = 0;

export function makeMessage(overrides: Partial<MailMessage> = {}): MailMessage {
  messageCounter += 1;
  const id = overrides.id ?? `msg-${messageCounter}`;
  const base: MailMessage = {
    id,
    threadId: overrides.threadId ?? `thread-${messageCounter}`,
    from: addr('taro@torihikisaki.co.jp', '山田太郎'),
    to: [addr(TARGET, '佐藤光彦')],
    cc: [],
    replyTo: [],
    subject: 'お問い合わせ',
    receivedAt: THURSDAY_10AM_JST,
    body: 'お世話になっております。ご確認をお願いいたします。',
    labelIds: ['INBOX'],
    attachmentNames: [],
    headers: { 'message-id': `<${id}@torihikisaki.co.jp>` },
  };
  return { ...base, ...overrides };
}

export function makeThread(messages: readonly MailMessage[], id = 'thread-1'): MailThread {
  return { id, messages: messages.slice().sort((a, b) => a.receivedAt - b.receivedAt) };
}

export class FakeClock implements ClockPort {
  constructor(private current: number = THURSDAY_10AM_JST) {}
  nowMs(): number {
    return this.current;
  }
  set(ms: number): void {
    this.current = ms;
  }
}

export class FakeState implements StatePort {
  constructor(private last: number | null = null) {}
  getLastRunAt(): number | null {
    return this.last;
  }
  setLastRunAt(epochMs: number): void {
    this.last = epochMs;
  }
}

export class FakeHistory implements HistoryPort {
  readonly records: ProcessingRecord[] = [];
  /** true にすると append が失敗する（履歴障害の再現）。 */
  failAppend = false;

  loadProcessed(): ReadonlyMap<string, ProcessingRecord> {
    const map = new Map<string, ProcessingRecord>();
    for (const r of this.records) map.set(r.messageId, r);
    return map;
  }
  append(record: ProcessingRecord): void {
    if (this.failAppend) throw new Error('history unavailable');
    this.records.push(record);
  }
  recordsForDate(isoDate: string): readonly ProcessingRecord[] {
    return this.records.filter((r) => r.processedAt.startsWith(isoDate));
  }
}

export class CollectingLogger implements LoggerPort {
  readonly lines: Array<{ level: string; message: string; data?: Readonly<Record<string, unknown>> }> =
    [];
  info(message: string, data?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: 'info', message, data });
  }
  warn(message: string, data?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: 'warn', message, data });
  }
  error(message: string, data?: Readonly<Record<string, unknown>>): void {
    this.lines.push({ level: 'error', message, data });
  }
  /** 全ログを1つの文字列にして検査しやすくする。 */
  dump(): string {
    return this.lines
      .map((l) => `${l.level} ${l.message} ${l.data === undefined ? '' : JSON.stringify(l.data)}`)
      .join('\n');
  }
}

export class FakeNotifier implements NotifierPort {
  readonly messages: string[] = [];
  notify(text: string): void {
    this.messages.push(text);
  }
}

export interface FakeGmailOptions {
  readonly messages?: readonly MailMessage[];
  readonly threads?: readonly MailThread[];
  /** searchMessageIds が返す ID。省略時は messages の並び。 */
  readonly searchResults?: readonly string[];
  readonly failSearch?: boolean;
  readonly failGetMessage?: boolean;
  readonly failCreateDraft?: boolean;
  readonly threadsWithDraft?: readonly string[];
}

export class FakeGmail implements GmailPort {
  readonly createdDrafts: DraftRequest[] = [];
  readonly appliedLabels: Array<{ threadId: string; labelIds: readonly string[] }> = [];
  readonly ensuredLabels: string[] = [];
  readonly searchQueries: string[] = [];
  private readonly messages = new Map<string, MailMessage>();
  private readonly threads = new Map<string, MailThread>();
  private draftSeq = 0;

  constructor(private readonly options: FakeGmailOptions = {}) {
    for (const m of options.messages ?? []) this.messages.set(m.id, m);
    for (const t of options.threads ?? []) this.threads.set(t.id, t);
  }

  searchMessageIds(query: string, maxResults: number): readonly string[] {
    this.searchQueries.push(query);
    if (this.options.failSearch === true) throw new Error('gmail search failed');
    const ids = this.options.searchResults ?? Array.from(this.messages.keys());
    return ids.slice(0, maxResults);
  }

  getMessage(id: string): MailMessage {
    if (this.options.failGetMessage === true) throw new Error('gmail get failed');
    const m = this.messages.get(id);
    if (m === undefined) throw new Error(`message not found: ${id}`);
    return m;
  }

  getThread(threadId: string): MailThread | null {
    return this.threads.get(threadId) ?? null;
  }

  createDraft(request: DraftRequest): string {
    if (this.options.failCreateDraft === true) throw new Error('draft create failed');
    this.createdDrafts.push(request);
    this.draftSeq += 1;
    return `draft-${this.draftSeq}`;
  }

  threadHasDraft(threadId: string): boolean {
    if ((this.options.threadsWithDraft ?? []).includes(threadId)) return true;
    const thread = this.threads.get(threadId);
    return thread?.messages.some((m) => m.labelIds.includes('DRAFT')) ?? false;
  }

  ensureLabel(name: string): string {
    this.ensuredLabels.push(name);
    return `label-${name}`;
  }

  addThreadLabels(threadId: string, labelIds: readonly string[]): void {
    this.appliedLabels.push({ threadId, labelIds });
  }
}

/**
 * AI のフェイク。呼び出しごとに queue から応答を返す。
 * queue が尽きたら最後の応答を繰り返す。
 */
export class FakeAi implements AiPort {
  readonly calls: Array<{ system: string; user: string }> = [];
  readonly modelId = 'fake-model-1';
  private queue: string[];

  constructor(
    responses: readonly string[],
    private readonly failAfter: number | null = null,
  ) {
    this.queue = responses.slice();
  }

  generate(system: string, user: string): string {
    this.calls.push({ system, user });
    if (this.failAfter !== null && this.calls.length > this.failAfter) {
      throw new Error('gemini unavailable');
    }
    if (this.queue.length > 1) return this.queue.shift() as string;
    return this.queue[0] ?? '{}';
  }
}

/** AI 応答 JSON を組み立てるヘルパ。 */
export function aiJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    classification: 'REPLY_REQUIRED',
    confidence: 0.95,
    reason: '明確な質問があるため返信が必要',
    language: 'ja',
    draftSubject: '',
    draftBody: '',
    missingInformation: [],
    riskFlags: [],
    ...overrides,
  });
}

export interface BuiltPorts extends Ports {
  readonly gmail: FakeGmail;
  readonly ai: FakeAi;
  readonly history: FakeHistory;
  readonly state: FakeState;
  readonly clock: FakeClock;
  readonly logger: CollectingLogger;
  readonly notifier: FakeNotifier;
}

export function makePorts(overrides: Partial<BuiltPorts> = {}): BuiltPorts {
  return {
    gmail: overrides.gmail ?? new FakeGmail(),
    ai: overrides.ai ?? new FakeAi([aiJson()]),
    history: overrides.history ?? new FakeHistory(),
    state: overrides.state ?? new FakeState(),
    clock: overrides.clock ?? new FakeClock(),
    logger: overrides.logger ?? new CollectingLogger(),
    notifier: overrides.notifier ?? new FakeNotifier(),
  };
}
