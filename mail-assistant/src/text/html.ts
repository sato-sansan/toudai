/**
 * HTML メールをプレーンテキストへ落とす（純関数）。
 *
 * 目的は「AI に渡す読める本文」を作ることだけ。レンダリング再現は狙わない。
 * URL は原則落とす（本文中の URL へ自動アクセスしないという方針と揃え、
 * AI が拾ってリンクを捏造する余地も減らす）。
 */

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  yen: '¥',
  copy: '©',
  reg: '®',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  laquo: '«',
  raquo: '»',
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z][a-zA-Z0-9]{1,10});/g, (m, name: string) => {
      const v = NAMED_ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function safeCodePoint(code: number): string {
  if (!isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** HTML かどうかの粗い判定。 */
export function looksLikeHtml(input: string): boolean {
  return /<(?:html|body|div|p|br|table|span|a|meta)\b|<\/(?:div|p|span|table)>/i.test(input);
}

/** HTML → テキスト。 */
export function htmlToText(input: string): string {
  let s = input;
  // 表示されない要素はまるごと落とす
  s = s.replace(/<(script|style|head|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  // ブロック境界を改行にする
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table)\s*>/gi, '\n');
  s = s.replace(/<(p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n');
  s = s.replace(/<td\b[^>]*>/gi, ' ');
  // 残りのタグを除去
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  // 裸の URL は落とす（自動アクセスしない方針・捏造防止）
  s = s.replace(/https?:\/\/\S+/g, '[リンク]');
  // 空白の正規化（改行は最大2つまで残す）
  s = s.replace(/[ \t　]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** text/plain 本文の軽い正規化。 */
export function normalizePlainText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/https?:\/\/\S+/g, '[リンク]')
    .replace(/[ \t　]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 形式を自動判定してテキスト化する。 */
export function toPlainText(input: string): string {
  if (!input) return '';
  return looksLikeHtml(input) ? htmlToText(input) : normalizePlainText(input);
}
