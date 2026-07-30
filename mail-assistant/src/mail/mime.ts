/**
 * 返信下書きの MIME 組み立て（純関数）。
 *
 * Gmail 高度サービス（REST）で下書きを作るには RFC 5322 のメッセージを自前で作る必要がある。
 * GmailApp の createDraftReply に頼らない理由:
 *   - GmailApp は実質 https://mail.google.com/（全権）スコープを要求する
 *   - 宛先・ヘッダを完全に自分で決められる＝勝手な「全員に返信」を構造的に防げる
 *
 * From ヘッダは意図的に付けない。Gmail 側が既定の送信元（sendAs）を使うため、
 * アカウントの既存設定を尊重できる。
 */
import type { EmailAddress } from '../types.js';
import { base64EncodeUtf8, encodeWord, isAscii, wrapBase64 } from './encoding.js';

export interface ReplyMimeInput {
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  /** 元メールの件名（Re: は必要に応じてこちらで付ける）。 */
  readonly originalSubject: string;
  readonly body: string;
  /** 元メールの Message-ID ヘッダ値（"<...>" を含む形）。 */
  readonly inReplyTo: string;
  /** 元メールの References ヘッダ値。 */
  readonly references: string;
  /** 末尾に付ける署名（空文字なら付けない）。 */
  readonly signature: string;
  /** 先頭に付ける注記（REVIEW_REQUIRED の確認用下書きなど）。空文字なら付けない。 */
  readonly notice: string;
}

const RE_PREFIX = /^\s*(?:re|Re|RE|rE)\s*(?:\[\d+\])?\s*[:：]/;

/** 件名を維持しつつ Re: を1つだけ付ける。 */
export function replySubject(originalSubject: string): string {
  const s = originalSubject.trim();
  if (s === '') return 'Re:';
  return RE_PREFIX.test(s) ? s : `Re: ${s}`;
}

/** ヘッダ用のアドレス表記。表示名は必要なら encoded-word 化する。 */
export function formatAddress(address: EmailAddress): string {
  const email = address.email.trim();
  const name = address.name.trim();
  if (name === '') return email;
  if (isAscii(name)) {
    // 特殊文字を含む表示名は quoted-string にする
    const quoted = /[()<>@,;:\\".[\]]/.test(name) ? `"${name.replace(/(["\\])/g, '\\$1')}"` : name;
    return `${quoted} <${email}>`;
  }
  return `${encodeWord(name)} <${email}>`;
}

export function formatAddressList(list: readonly EmailAddress[]): string {
  return list.map(formatAddress).join(', ');
}

/**
 * References ヘッダを組む。
 * 元の References に元メールの Message-ID を追加するのが RFC の作法。
 */
export function buildReferences(references: string, inReplyTo: string): string {
  const parts = `${references} ${inReplyTo}`
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('<') && s.endsWith('>'));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  // 長くなりすぎる場合は先頭と直近を残す（一般的な実装の慣習）
  if (out.length > 20) {
    return [out[0] as string, ...out.slice(out.length - 19)].join(' ');
  }
  return out.join(' ');
}

/** 本文の改行を CRLF に正規化する。 */
function normalizeBody(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
}

/** 返信下書きの RFC 5322 メッセージを組み立てる。 */
export function buildReplyMime(input: ReplyMimeInput): string {
  const headers: string[] = [];

  headers.push(`To: ${formatAddressList(input.to)}`);
  if (input.cc.length > 0) headers.push(`Cc: ${formatAddressList(input.cc)}`);
  headers.push(`Subject: ${encodeWord(replySubject(input.originalSubject))}`);

  if (input.inReplyTo.trim() !== '') {
    headers.push(`In-Reply-To: ${input.inReplyTo.trim()}`);
    const refs = buildReferences(input.references, input.inReplyTo);
    if (refs !== '') headers.push(`References: ${refs}`);
  }

  headers.push('MIME-Version: 1.0');
  headers.push('Content-Type: text/plain; charset="UTF-8"');
  headers.push('Content-Transfer-Encoding: base64');

  const parts: string[] = [];
  if (input.notice.trim() !== '') parts.push(input.notice.trim(), '');
  parts.push(input.body.trim());
  if (input.signature.trim() !== '') parts.push('', input.signature.trim());

  const body = normalizeBody(parts.join('\n'));
  const encoded = wrapBase64(base64EncodeUtf8(body));

  return `${headers.join('\r\n')}\r\n\r\n${encoded}`;
}
