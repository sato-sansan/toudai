/**
 * ログ・履歴へ出す前の伏せ字処理（純関数）。
 *
 * 方針: 受信メールの本文・氏名・メールアドレスの局所部はログにも履歴にも残さない。
 * 障害調査に必要な最小限（メッセージ ID・ドメイン・件名の断片）だけを残す。
 */

/** メールアドレスのドメインのみを返す。取れなければ空文字。 */
export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return '';
  return email.slice(at + 1).toLowerCase();
}

/** "sato@example.com" → "s***@example.com"。 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  const head = local.slice(0, 1);
  return `${head}***@${email.slice(at + 1).toLowerCase()}`;
}

/** 本文に混じったメールアドレス・電話番号を伏せる。 */
export function redactPii(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, (m) => maskEmail(m))
    .replace(/(?:\+81|0)\d{1,4}[-(\s]?\d{2,4}[-)\s]?\d{3,4}/g, '[電話番号]');
}

/**
 * 件名の断片だけを残す（プレビュー・ログ用）。
 * 件名にも取引先名等が入るため長さを絞る。
 */
export function subjectExcerpt(subject: string, maxChars = 40): string {
  const s = subject.replace(/\s+/g, ' ').trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`;
}

/** 履歴に入れる理由コード。自由文の PII が漏れないよう長さと文字種を絞る。 */
export function reasonCode(reason: string, maxChars = 80): string {
  const s = redactPii(reason).replace(/\s+/g, ' ').trim();
  return s.length <= maxChars ? s : `${s.slice(0, maxChars)}…`;
}
