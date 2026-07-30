/**
 * Gmail 検索クエリの組み立て（純関数）。
 *
 * クエリを文字列連結で散らすと「対象外のメールまで拾う」事故につながるため、
 * ここに集約してテストで固定する。
 */
import type { Config } from '../config.js';

function quote(value: string): string {
  // Gmail 検索の値に空白や記号が入る場合に備えて引用する
  return `"${value.replace(/"/g, '')}"`;
}

/**
 * 新着メールの検索クエリ。
 *
 * - in:inbox         … 受信トレイのみ（アーカイブ済み・送信済みを拾わない）
 * - -from:me         … 自分の送信メールを除外
 * - -label:AI処理済み … 前回処理済みを二重に拾わない（履歴とは別の第2の防波堤）
 * - テストモード時は対象ラベル・対象送信者に限定する
 */
export function buildInboxQuery(config: Config, afterEpochSeconds: number): string {
  const parts: string[] = ['in:inbox', '-in:chats', '-in:trash', '-in:spam', '-from:me'];

  parts.push(`after:${Math.max(0, Math.floor(afterEpochSeconds))}`);

  if (config.labelDone !== '') parts.push(`-label:${quote(config.labelDone)}`);
  if (config.labelError !== '') parts.push(`-label:${quote(config.labelError)}`);

  if (config.testMode) {
    if (config.testLabel !== '') parts.push(`label:${quote(config.testLabel)}`);
    if (config.testSenders.length > 0) {
      const senders = config.testSenders.map((s) => `from:${s}`).join(' OR ');
      parts.push(`(${senders})`);
    }
  }

  return parts.join(' ');
}

/** 同じ送信者との過去のやり取りを探すクエリ。 */
export function buildSenderHistoryQuery(
  senderEmail: string,
  afterEpochSeconds: number,
): string {
  return [
    `(from:${senderEmail} OR to:${senderEmail})`,
    `after:${Math.max(0, Math.floor(afterEpochSeconds))}`,
    '-in:chats',
    '-in:spam',
    '-in:trash',
  ].join(' ');
}

/** 同じ会社（ドメイン）との過去のやり取りを探すクエリ。 */
export function buildDomainHistoryQuery(domain: string, afterEpochSeconds: number): string {
  return [
    `(from:@${domain} OR to:@${domain})`,
    `after:${Math.max(0, Math.floor(afterEpochSeconds))}`,
    '-in:chats',
    '-in:spam',
    '-in:trash',
  ].join(' ');
}

/** 佐藤自身が送信した、類似件名のメールを探すクエリ（文体・回答パターンの参考）。 */
export function buildSentSimilarQuery(
  subjectKeywords: readonly string[],
  afterEpochSeconds: number,
): string {
  const parts = ['in:sent', `after:${Math.max(0, Math.floor(afterEpochSeconds))}`];
  const usable = subjectKeywords.filter((k) => k.length >= 2).slice(0, 4);
  if (usable.length > 0) {
    parts.push(`(${usable.map((k) => `subject:${quote(k)}`).join(' OR ')})`);
  }
  return parts.join(' ');
}

/** 佐藤自身の送信メール全般（文体推定の土台）。 */
export function buildSentStyleQuery(afterEpochSeconds: number): string {
  return ['in:sent', `after:${Math.max(0, Math.floor(afterEpochSeconds))}`, '-in:chats'].join(' ');
}

const SUBJECT_NOISE = /^(?:re|fwd?|返信|転送)$/i;

/**
 * 件名からキーワードを抽出する（類似件名検索用）。
 * Re: / Fwd: や記号を落とし、意味のありそうな語だけを返す。
 */
export function subjectKeywords(subject: string, max = 4): readonly string[] {
  const cleaned = subject
    .replace(/^(?:\s*(?:re|fwd?|返信|転送)\s*(?:\[\d+\])?\s*[:：])+/gi, '')
    .replace(/[【】\[\]（）()<>「」『』:：,、。.!?！？*"'\\/|]/g, ' ')
    .trim();
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !SUBJECT_NOISE.test(t));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
