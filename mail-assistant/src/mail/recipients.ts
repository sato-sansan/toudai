/**
 * 返信の宛先決定（純関数）。
 *
 * 誤送信防止の中核。設計方針:
 *   - To は Reply-To（あれば）または From の1件のみ。
 *   - Cc は既定で空。勝手に「全員に返信」しない。
 *   - ccMode='mirror-previous' のときだけ、同一スレッドで佐藤自身が過去に Cc していた
 *     アドレスに限り引き継ぐ（＝佐藤の過去の判断を再現するだけで、新規に広げない）。
 *   - 自分自身、no-reply、メーリングリストのアドレスは常に除外。
 */
import type { Config } from '../config.js';
import type { EmailAddress, MailMessage, MailThread } from '../types.js';

export interface ReplyRecipients {
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  /** 判断根拠（ログ用）。 */
  readonly notes: readonly string[];
}

function dedupeByEmail(list: readonly EmailAddress[]): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of list) {
    if (a.email === '' || seen.has(a.email)) continue;
    seen.add(a.email);
    out.push(a);
  }
  return out;
}

/** 宛先として使えるアドレスの形をしているか。 */
function isUsableAddress(email: string): boolean {
  const at = email.indexOf('@');
  return at > 0 && at < email.length - 1;
}

function isExcluded(address: EmailAddress, config: Config): boolean {
  // From ヘッダが壊れている等でアドレスが取れなかった場合は宛先にできない。
  // ここで弾かないと To が空の下書きができてしまう。
  if (!isUsableAddress(address.email)) return true;
  if (address.email === config.targetEmail) return true;
  const lower = address.email.toLowerCase();
  if (config.notifySenderPatterns.some((p) => p !== '' && lower.includes(p.toLowerCase()))) {
    return true;
  }
  return false;
}

/** メーリングリストのアドレス（List-Id / List-Post から推定）。 */
function listAddresses(thread: MailThread | null): Set<string> {
  const out = new Set<string>();
  if (!thread) return out;
  for (const m of thread.messages) {
    const post = m.headers['list-post'];
    if (post === undefined) continue;
    const match = post.match(/<mailto:([^>]+)>/i);
    if (match?.[1] !== undefined) out.add(match[1].toLowerCase());
  }
  return out;
}

/**
 * 同一スレッドで佐藤自身が過去に Cc に入れていたアドレス集合。
 * 「佐藤が過去にそうしていた」という実績のあるものだけを引き継ぎ対象にする。
 */
function previouslyCcdBySato(thread: MailThread | null, targetEmail: string): Set<string> {
  const out = new Set<string>();
  if (!thread) return out;
  for (const m of thread.messages) {
    const sentBySato = m.from.email === targetEmail || m.labelIds.includes('SENT');
    if (!sentBySato) continue;
    if (m.labelIds.includes('DRAFT')) continue;
    for (const a of m.cc) out.add(a.email);
  }
  return out;
}

/** 返信先を決める。 */
export function resolveReplyRecipients(
  message: MailMessage,
  thread: MailThread | null,
  config: Config,
): ReplyRecipients {
  const notes: string[] = [];
  const lists = listAddresses(thread);

  // To: Reply-To 優先。複数あっても先頭1件に絞る（宛先を広げない）。
  const replyToCandidates = dedupeByEmail(message.replyTo).filter(
    (a) => !isExcluded(a, config) && !lists.has(a.email),
  );
  let to: EmailAddress[];
  if (replyToCandidates.length > 0) {
    to = [replyToCandidates[0] as EmailAddress];
    notes.push('to=reply-to');
    if (replyToCandidates.length > 1) notes.push('reply-to-truncated');
  } else if (!isExcluded(message.from, config) && !lists.has(message.from.email)) {
    to = [message.from];
    notes.push('to=from');
  } else {
    to = [];
    notes.push('to=none');
  }

  // Cc: 既定は空
  let cc: EmailAddress[] = [];
  if (config.ccMode === 'mirror-previous') {
    const allowed = previouslyCcdBySato(thread, config.targetEmail);
    if (allowed.size === 0) {
      notes.push('cc=none(no-precedent)');
    } else {
      cc = dedupeByEmail(message.cc).filter(
        (a) =>
          allowed.has(a.email) &&
          !isExcluded(a, config) &&
          !lists.has(a.email) &&
          !to.some((t) => t.email === a.email),
      );
      notes.push(`cc=mirror(${cc.length})`);
    }
  } else {
    notes.push('cc=none');
  }

  return { to, cc, notes };
}

/** 下書きを作れる宛先が揃っているか。 */
export function hasDeliverableRecipient(recipients: ReplyRecipients): boolean {
  return recipients.to.length > 0;
}
