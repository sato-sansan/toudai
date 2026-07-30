/**
 * AI に渡す前のヒューリスティクス判定（純関数）。
 *
 * ここで弾けるものは AI を呼ばない。理由は3つ:
 *   1. 明らかな自動配信をわざわざ外部 API へ送らない（情報漏えい面積の縮小）
 *   2. 無料枠の節約
 *   3. 決定的な規則は決定的に扱う（AI の揺らぎを持ち込まない）
 *
 * 判定は3段階:
 *   skip      … AI を呼ばず NO_REPLY_REQUIRED 確定
 *   downgrade … AI は呼ぶが REPLY_REQUIRED まで上げない（＝下書きを作らない）
 *   proceed   … 通常処理
 */
import type { Config } from '../config.js';
import type { EmailAddress, MailMessage, MailThread } from '../types.js';
import { toPlainText } from '../text/html.js';

export type HeuristicAction = 'skip' | 'downgrade' | 'proceed';

export interface HeuristicVerdict {
  readonly action: HeuristicAction;
  /** 短い理由コードの並び（ログ用）。 */
  readonly reasons: readonly string[];
  /** 請求・契約・セキュリティ等の重要メールか（返信不要でも記録する）。 */
  readonly important: boolean;
  /** 佐藤が To に入っておらず Cc のみか。 */
  readonly ccOnly: boolean;
  /** すでに佐藤（または同一ドメインの社内担当）が返信済みか。 */
  readonly alreadyReplied: boolean;
}

function hasAddress(list: readonly EmailAddress[], email: string): boolean {
  return list.some((a) => a.email === email);
}

/** 返信不要と本文・件名で明記しているか。 */
const NO_REPLY_PHRASES: readonly RegExp[] = [
  /返信は?(?:不要|無用|ご遠慮)/,
  /この(?:メール|アドレス)(?:に|へ)(?:は)?返信(?:でき|しないで)/,
  /返信いただ(?:く必要|かなくて)/,
  /do not reply/i,
  /no need to reply/i,
  /this is an automated/i,
];

/** 自動配信・通知系のヘッダ。 */
function isBulkOrAuto(message: MailMessage): string | null {
  const h = message.headers;
  if (h['list-id'] !== undefined || h['list-unsubscribe'] !== undefined) return 'mailing-list';
  const precedence = (h['precedence'] ?? '').toLowerCase();
  if (['bulk', 'list', 'junk'].includes(precedence)) return 'precedence-bulk';
  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();
  if (autoSubmitted !== '' && autoSubmitted !== 'no') return 'auto-submitted';
  if (h['x-auto-response-suppress'] !== undefined) return 'auto-response-suppress';
  if ((h['x-mailer'] ?? '').toLowerCase().includes('mailchimp')) return 'bulk-mailer';
  if (h['feedback-id'] !== undefined) return 'bulk-mailer';
  return null;
}

/** 送信者アドレスが no-reply 等の返信不可アドレスか。 */
function isNoReplySender(email: string, patterns: readonly string[]): boolean {
  const lower = email.toLowerCase();
  return patterns.some((p) => lower.includes(p.toLowerCase()));
}

/**
 * スレッド内で、対象メール以降に佐藤（または同一ドメインの社内担当）の送信があるか。
 * Gmail のラベル SENT か、差出人が自分/自社ドメインかで判定する。
 */
function repliedAfter(
  thread: MailThread | null,
  message: MailMessage,
  targetEmail: string,
): boolean {
  if (!thread) return false;
  const ownDomain = targetEmail.slice(targetEmail.lastIndexOf('@') + 1);
  return thread.messages.some((m) => {
    if (m.id === message.id) return false;
    if (m.receivedAt <= message.receivedAt) return false;
    if (m.labelIds.includes('DRAFT')) return false;
    if (m.from.email === targetEmail) return true;
    if (m.labelIds.includes('SENT')) return true;
    return ownDomain !== '' && m.from.email.endsWith(`@${ownDomain}`);
  });
}

/** 重要メール（返信不要でも見落とし防止のため記録する）か。 */
export function isImportant(message: MailMessage, bodyText: string, config: Config): boolean {
  const haystack = `${message.subject}\n${bodyText}`.toLowerCase();
  return config.importantKeywords.some((k) => k !== '' && haystack.includes(k.toLowerCase()));
}

/**
 * ヒューリスティクス判定本体。
 * thread は取得できていれば渡す（無くても判定は成立する）。
 */
export function evaluateHeuristics(
  message: MailMessage,
  thread: MailThread | null,
  config: Config,
): HeuristicVerdict {
  const bodyText = toPlainText(message.body).slice(0, 4000);
  const important = isImportant(message, bodyText, config);
  const ccOnly =
    !hasAddress(message.to, config.targetEmail) && hasAddress(message.cc, config.targetEmail);
  const alreadyReplied = repliedAfter(thread, message, config.targetEmail);
  const reasons: string[] = [];

  const skip = (reason: string): HeuristicVerdict => ({
    action: 'skip',
    reasons: [reason],
    important,
    ccOnly,
    alreadyReplied,
  });

  // 1. 自分が送ったメール
  if (message.from.email === config.targetEmail || message.labelIds.includes('SENT')) {
    return skip('self-sent');
  }
  // 2. 下書きそのもの
  if (message.labelIds.includes('DRAFT')) return skip('is-draft');
  // 3. 迷惑メール・ゴミ箱
  if (message.labelIds.includes('SPAM')) return skip('spam');
  if (message.labelIds.includes('TRASH')) return skip('trash');
  // 4. 返信不可アドレス
  if (isNoReplySender(message.from.email, config.notifySenderPatterns)) {
    return skip('no-reply-sender');
  }
  // 5. メーリングリスト・自動配信
  const bulk = isBulkOrAuto(message);
  if (bulk !== null) return skip(bulk);
  // 6. 返信不要と明記
  if (NO_REPLY_PHRASES.some((re) => re.test(bodyText) || re.test(message.subject))) {
    return skip('sender-says-no-reply');
  }
  // 7. すでに返信済み
  if (alreadyReplied) return skip('already-replied');
  // 8. スレッドに下書きが既にある（重複作成防止）
  if (thread?.messages.some((m) => m.labelIds.includes('DRAFT')) === true) {
    return skip('draft-exists');
  }

  // 9. Cc のみ: 原則は返信不要だが、明確な依頼が本文にある可能性は残る。
  //    AI には掛けるが REPLY_REQUIRED には上げない（＝下書きを作らない）。
  if (ccOnly) reasons.push('cc-only');

  return {
    action: reasons.length > 0 ? 'downgrade' : 'proceed',
    reasons,
    important,
    ccOnly,
    alreadyReplied,
  };
}
