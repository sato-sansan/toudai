/**
 * Gmail 高度サービス（REST）アダプタ。
 *
 * GmailApp を使わない理由: GmailApp は実質 https://mail.google.com/（全権）を要求する。
 * REST なら gmail.modify に絞れ、MIME を自分で組めるので宛先制御が確実になる。
 *
 * このファイルには **送信 API を一切書かない**。
 * Gmail.Users.Messages.send / Gmail.Users.Drafts.send / GmailApp.sendEmail / MailApp は
 * 参照しない（tests/no-send.test.ts がソース走査で検証する）。
 */
import type { DraftRequest, GmailPort } from '../ports.js';
import type { EmailAddress, MailMessage, MailThread } from '../types.js';
import { toPlainText } from '../text/html.js';

const USER = 'me';

/** "Taro Yamada <taro@example.com>, foo@example.com" をパースする。 */
export function parseAddressList(value: string | undefined): EmailAddress[] {
  if (value === undefined || value.trim() === '') return [];
  const out: EmailAddress[] = [];
  // 引用符内のカンマを壊さないよう素朴に走査する
  let depth = 0;
  let quoted = false;
  let buf = '';
  const flush = (): void => {
    const item = buf.trim();
    buf = '';
    if (item === '') return;
    const angle = item.match(/^(.*?)<([^>]+)>$/);
    if (angle) {
      const name = (angle[1] ?? '').trim().replace(/^"(.*)"$/, '$1');
      out.push({ name, email: (angle[2] ?? '').trim().toLowerCase() });
    } else {
      out.push({ name: '', email: item.toLowerCase() });
    }
  };
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '(') depth++;
    if (!quoted && ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && !quoted && depth === 0) {
      flush();
      continue;
    }
    buf += ch;
  }
  flush();
  return out.filter((a) => a.email.includes('@'));
}

type GmailPart = GoogleAppsScript.Gmail.Schema.MessagePart;

/** base64url のペイロードを UTF-8 文字列へ。 */
function decodeBody(data: string | undefined): string {
  if (data === undefined || data === '') return '';
  try {
    const bytes = Utilities.base64DecodeWebSafe(data);
    return Utilities.newBlob(bytes).getDataAsString('UTF-8');
  } catch {
    return '';
  }
}

interface ExtractedBody {
  readonly plain: string;
  readonly html: string;
  readonly attachmentNames: string[];
}

/** MIME ツリーを歩いて text/plain・text/html・添付ファイル名を集める。 */
export function extractParts(part: GmailPart | undefined, acc?: ExtractedBody): ExtractedBody {
  const out: ExtractedBody = acc ?? { plain: '', html: '', attachmentNames: [] };
  if (part === undefined) return out;

  const mime = (part.mimeType ?? '').toLowerCase();
  const filename = part.filename ?? '';

  if (filename !== '') {
    out.attachmentNames.push(filename);
  } else if (mime === 'text/plain') {
    const text = decodeBody(part.body?.data);
    if (text !== '') {
      return extractChildren(part, { ...out, plain: out.plain === '' ? text : `${out.plain}\n${text}` });
    }
  } else if (mime === 'text/html') {
    const text = decodeBody(part.body?.data);
    if (text !== '') {
      return extractChildren(part, { ...out, html: out.html === '' ? text : `${out.html}\n${text}` });
    }
  }
  return extractChildren(part, out);
}

function extractChildren(part: GmailPart, acc: ExtractedBody): ExtractedBody {
  let out = acc;
  for (const child of part.parts ?? []) {
    out = extractParts(child, out);
  }
  return out;
}

/** ヘッダ配列を小文字キーの辞書へ。 */
export function headersToRecord(
  headers: readonly GoogleAppsScript.Gmail.Schema.MessagePartHeader[] | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers ?? []) {
    const name = (h.name ?? '').toLowerCase();
    if (name === '') continue;
    // 同名ヘッダは最初のものを優先（Received 等は使わない）
    if (out[name] === undefined) out[name] = h.value ?? '';
  }
  return out;
}

/** Gmail API のメッセージを MailMessage へ正規化する。 */
export function toMailMessage(raw: GoogleAppsScript.Gmail.Schema.Message): MailMessage {
  const headers = headersToRecord(raw.payload?.headers);
  const extracted = extractParts(raw.payload);
  const body = extracted.plain !== '' ? extracted.plain : toPlainText(extracted.html);

  const fromList = parseAddressList(headers['from']);
  const receivedAt = raw.internalDate !== undefined ? Number(raw.internalDate) : Date.now();

  return {
    id: raw.id ?? '',
    threadId: raw.threadId ?? '',
    from: fromList[0] ?? { name: '', email: '' },
    to: parseAddressList(headers['to']),
    cc: parseAddressList(headers['cc']),
    replyTo: parseAddressList(headers['reply-to']),
    subject: headers['subject'] ?? '',
    receivedAt: isFinite(receivedAt) ? receivedAt : Date.now(),
    body,
    labelIds: raw.labelIds ?? [],
    attachmentNames: extracted.attachmentNames,
    headers,
  };
}

export class GasGmailAdapter implements GmailPort {
  private readonly labelCache = new Map<string, string>();

  searchMessageIds(query: string, maxResults: number): readonly string[] {
    const res = Gmail.Users!.Messages!.list(USER, {
      q: query,
      maxResults: Math.max(1, Math.min(500, maxResults)),
    });
    const out: string[] = [];
    for (const m of res.messages ?? []) {
      if (m.id !== undefined) out.push(m.id);
    }
    return out;
  }

  getMessage(id: string): MailMessage {
    const raw = Gmail.Users!.Messages!.get(USER, id, { format: 'full' });
    return toMailMessage(raw);
  }

  getThread(threadId: string): MailThread | null {
    const raw = Gmail.Users!.Threads!.get(USER, threadId, { format: 'full' });
    if (raw.messages === undefined) return null;
    const messages = raw.messages
      .map(toMailMessage)
      .sort((a, b) => a.receivedAt - b.receivedAt);
    return { id: raw.id ?? threadId, messages };
  }

  /**
   * 返信下書きを作成する。threadId を渡すことで既存スレッドに紐づく。
   * このメソッドは下書きの作成だけを行う。送信は行わない。
   */
  createDraft(request: DraftRequest): string {
    const raw = Utilities.base64EncodeWebSafe(
      Utilities.newBlob(request.raw, 'message/rfc822').getBytes(),
    ).replace(/=+$/, '');
    const created = Gmail.Users!.Drafts!.create(
      { message: { threadId: request.threadId, raw } },
      USER,
    );
    return created.id ?? '';
  }

  threadHasDraft(threadId: string): boolean {
    const raw = Gmail.Users!.Threads!.get(USER, threadId, { format: 'minimal' });
    return (raw.messages ?? []).some((m) => (m.labelIds ?? []).includes('DRAFT'));
  }

  ensureLabel(name: string): string {
    const cached = this.labelCache.get(name);
    if (cached !== undefined) return cached;

    const list = Gmail.Users!.Labels!.list(USER);
    for (const label of list.labels ?? []) {
      if (label.name === name && label.id !== undefined) {
        this.labelCache.set(name, label.id);
        return label.id;
      }
    }
    const created = Gmail.Users!.Labels!.create(
      { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
      USER,
    );
    const id = created.id ?? '';
    if (id !== '') this.labelCache.set(name, id);
    return id;
  }

  /**
   * スレッドへラベルを付ける。
   * removeLabelIds は渡さない = 既読化・アーカイブ・削除は一切行わない。
   */
  addThreadLabels(threadId: string, labelIds: readonly string[]): void {
    const ids = labelIds.filter((id) => id !== '');
    if (ids.length === 0) return;
    Gmail.Users!.Threads!.modify({ addLabelIds: ids.slice() }, USER, threadId);
  }
}
