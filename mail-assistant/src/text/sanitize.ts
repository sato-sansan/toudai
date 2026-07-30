/**
 * メール本文の整形（純関数）。
 *
 * AI へ渡す前に「引用履歴・署名・免責文・長い定型文」を落として実質本文だけにする。
 * 目的は3つ:
 *   1. トークン節約（無料枠を守る）
 *   2. 精度向上（過去の引用に引っぱられた判定を防ぐ）
 *   3. 情報漏えい面積の縮小（不要な個人情報を外部 API へ送らない）
 */
import { toPlainText } from './html.js';

/** 引用履歴の開始を示す行のパターン。 */
const QUOTE_MARKERS: readonly RegExp[] = [
  /^-{2,}\s*(?:original message|元のメッセージ|返信元のメッセージ)\s*-{2,}/i,
  /^-{2,}\s*forwarded message\s*-{2,}/i,
  /^_{5,}$/,
  /^-{5,}$/,
  // 「2026年7月30日(木) 12:34 山田太郎 <...> のメッセージ:」
  /^\d{4}年\d{1,2}月\d{1,2}日.*(?:のメッセージ|wrote:|さんは書きました)/,
  // 「On Thu, Jul 30, 2026 at 12:34 PM Taro Yamada wrote:」
  /^on\s.{0,120}\swrote:\s*$/i,
  // Outlook 形式のヘッダ再掲
  /^(?:差出人|送信者|from)\s*[:：]/i,
  /^(?:送信日時|日付|date|sent)\s*[:：]/i,
];

/** 免責文・定型フッタの開始を示すパターン。 */
const DISCLAIMER_MARKERS: readonly RegExp[] = [
  /本(?:電子)?メール(?:に含まれる情報|の内容)?は/,
  /このメールは.*(?:配信|送信)されています/,
  /機密情報が含まれ/,
  /this e?-?mail (?:and any (?:files|attachments)|message) /i,
  /confidential(?:ity)? notice/i,
  /if you are not the intended recipient/i,
  /配信(?:の)?停止(?:を)?(?:ご)?希望/,
  /unsubscribe/i,
];

/** 署名ブロックの開始を示すパターン。 */
const SIGNATURE_MARKERS: readonly RegExp[] = [
  /^--\s*$/,
  /^-{3,}\s*$/,
  /^[=＝]{3,}\s*$/,
  /^[*＊]{3,}\s*$/,
];

export interface SanitizeOptions {
  /** 最大文字数。超過分は切り捨てて印を付ける。 */
  readonly maxChars: number;
  /** 引用履歴を落とすか。 */
  readonly stripQuotes?: boolean;
}

export interface SanitizedBody {
  readonly text: string;
  /** 切り捨てが発生したか。 */
  readonly truncated: boolean;
  /** 引用履歴を落としたか。 */
  readonly quotesStripped: boolean;
}

function firstMatchingLine(lines: readonly string[], patterns: readonly RegExp[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    for (const re of patterns) {
      if (re.test(line)) return i;
    }
  }
  return -1;
}

/**
 * 引用履歴を落とす。
 * 「> で始まる行が連続する塊」と「引用開始マーカー以降」の両方に対応する。
 */
export function stripQuotedHistory(text: string): { text: string; stripped: boolean } {
  const lines = text.split('\n');

  let cut = firstMatchingLine(lines, QUOTE_MARKERS);

  // 引用記号 '>' が3行以上続く塊も引用と見なす
  let run = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*>/.test(lines[i] ?? '')) {
      run += 1;
      if (run >= 3) {
        const start = i - run + 1;
        if (cut === -1 || start < cut) cut = start;
        break;
      }
    } else if ((lines[i] ?? '').trim() !== '') {
      run = 0;
    }
  }

  if (cut === -1) {
    // 単発の '>' 行だけ落とす
    const kept = lines.filter((l) => !/^\s*>/.test(l));
    return { text: kept.join('\n').trim(), stripped: kept.length !== lines.length };
  }
  return { text: lines.slice(0, cut).join('\n').trim(), stripped: true };
}

/** 免責文・配信停止案内以降を落とす。 */
export function stripDisclaimers(text: string): string {
  const lines = text.split('\n');
  const cut = firstMatchingLine(lines, DISCLAIMER_MARKERS);
  if (cut === -1) return text.trim();
  return lines.slice(0, cut).join('\n').trim();
}

/** 署名区切り（"--" 等）以降を落とす。 */
export function stripSignatureBlock(text: string): string {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    for (const re of SIGNATURE_MARKERS) {
      // 冒頭すぎる位置の区切りは本文の飾りとみなして無視する
      if (re.test(line) && i > 2) {
        return lines.slice(0, i).join('\n').trim();
      }
    }
  }
  return text.trim();
}

/** 本文を AI 入力用に整形する。 */
export function sanitizeBody(raw: string, options: SanitizeOptions): SanitizedBody {
  const stripQuotes = options.stripQuotes !== false;
  let text = toPlainText(raw);
  let quotesStripped = false;

  if (stripQuotes) {
    const r = stripQuotedHistory(text);
    text = r.text;
    quotesStripped = r.stripped;
  }
  text = stripDisclaimers(text);
  text = stripSignatureBlock(text);
  text = text.replace(/\n{3,}/g, '\n\n').trim();

  let truncated = false;
  if (text.length > options.maxChars) {
    text = `${text.slice(0, options.maxChars)}\n…（以下省略）`;
    truncated = true;
  }
  return { text, truncated, quotesStripped };
}

/**
 * 佐藤本人の送信メールから、返信文本体だけを取り出す（文体推定用）。
 * 署名は style.ts 側で別途推定するため、ここでは引用と免責のみ落とす。
 */
export function sanitizeSentBody(raw: string, maxChars: number): string {
  const text = toPlainText(raw);
  const stripped = stripQuotedHistory(text).text;
  const clean = stripDisclaimers(stripped).replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > maxChars ? clean.slice(0, maxChars) : clean;
}
