/**
 * 佐藤光彦の文体プロファイル推定（純関数）。
 *
 * 過去の送信メールを AI へ大量に流し込む代わりに、ここで「文体の要約」に圧縮する。
 * トークンを節約でき、外部へ送る個人情報も減る。
 *
 * 署名は「複数の送信メールに共通する末尾の行の並び」として検出する。
 * 定型の署名は必ず共通末尾になるので、正規表現で当てるより頑健で、
 * 会社名や電話番号のパターンを決め打ちする必要がない。
 */
import type { StyleProfile } from '../types.js';
import { sanitizeSentBody } from '../text/sanitize.js';

const MAX_EXAMPLES = 3;

/** 冒頭の挨拶にありがちな表現。 */
const GREETING_PATTERNS: readonly RegExp[] = [
  /^(?:いつも)?(?:大変)?お世話になっ(?:て|ており)ます[。、]?/,
  /^お世話になります[。、]?/,
  /^ご連絡(?:ありがとうございます|いただきありがとうございます)[。、]?/,
  /^ご返信(?:ありがとうございます|いただきありがとうございます)[。、]?/,
  /^(?:早速の)?ご対応(?:ありがとうございます)[。、]?/,
  /^おはようございます[。、]?/,
  /^はじめまして[。、]?/,
  /^(?:dear|hello|hi)\b.*/i,
  /^thank you for .*/i,
];

/** 締めの表現にありがちな表現。 */
const CLOSING_PATTERNS: readonly RegExp[] = [
  /(?:何卒)?よろしくお願い(?:いた)?します[。]?$/,
  /よろしくお願い申し上げます[。]?$/,
  /引き続きよろしくお願い(?:いた)?します[。]?$/,
  /ご検討(?:のほど)?よろしくお願い(?:いた)?します[。]?$/,
  /ご確認(?:のほど)?よろしくお願い(?:いた)?します[。]?$/,
  /取り急ぎ(?:ご連絡|ご報告)(?:まで)?[。]?$/,
  /best regards[,.]?$/i,
  /kind regards[,.]?$/i,
];

/** 相手の呼び方（1行目にありがちな "〇〇様" 等）。 */
const SALUTATION_RE = /^(.{1,30}?)(様|さま|さん|殿|御中|先生|部長|課長|社長|様方)\s*$/;

/** 署名ブロックの開始を示す区切り行。 */
const SIGNATURE_DELIMITER = /^(?:--|-{3,}|[=＝]{3,}|[*＊]{3,}|_{3,})\s*$/;

function uniqueTop(values: readonly string[], max: number): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const key = v.trim();
    if (key === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
    if (out.length >= max) break;
  }
  return out;
}

function nonEmptyLines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
}

/**
 * 複数本文の共通末尾（行単位）を署名として抽出する。
 *
 * 単純な共通末尾だと「よろしくお願いします。」のような定型の締め文まで巻き込む。
 * 締め文を署名として扱うと、下書きに締め文が二重で入ってしまうため、
 * 共通末尾から締め文・空行を切り落としてから署名と見なす。
 */
export function detectSignature(bodies: readonly string[]): string {
  const lineSets = bodies.map((b) => b.split('\n').map((l) => l.trimEnd())).filter((ls) => ls.length > 0);
  if (lineSets.length < 2) return '';

  const first = lineSets[0] as string[];
  let common = 0;
  const minLen = Math.min(...lineSets.map((ls) => ls.length));

  while (common < minLen) {
    const candidate = first[first.length - 1 - common];
    if (candidate === undefined) break;
    const allMatch = lineSets.every((ls) => ls[ls.length - 1 - common] === candidate);
    if (!allMatch) break;
    common++;
  }

  if (common === 0) return '';
  let lines = first.slice(first.length - common);

  // 区切り行（"--" 等）があれば、そこより後ろだけを署名にする。
  const delimiterIndex = lines.findIndex((l) => SIGNATURE_DELIMITER.test(l.trim()));
  if (delimiterIndex >= 0) {
    lines = lines.slice(delimiterIndex + 1);
  } else {
    // 区切りが無い場合は、先頭側の締め文・空行を落とす。
    while (lines.length > 0) {
      const head = (lines[0] ?? '').trim();
      const isClosing = head === '' || CLOSING_PATTERNS.some((re) => re.test(head));
      if (!isClosing) break;
      lines = lines.slice(1);
    }
  }

  // 末尾の空行を落とす
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') lines.pop();

  const text = lines.join('\n').trim();
  // 署名は通常2行以上（会社名＋氏名など）。1行だけなら締め文の残りと見なす。
  if (text === '' || nonEmptyLines(text).length < 2) return '';
  return text;
}

/** 本文末尾から署名部分を取り除く。 */
export function removeSignature(body: string, signature: string): string {
  if (signature === '') return body.trim();
  const idx = body.lastIndexOf(signature);
  return (idx >= 0 ? body.slice(0, idx) : body).trim();
}

function detectPoliteness(bodies: readonly string[]): StyleProfile['politeness'] {
  const joined = bodies.join('\n');
  if (joined === '') return 'standard';
  const formalHits = (joined.match(/(?:申し上げ|恐れ入り|拝承|何卒|賜り|存じ)/g) ?? []).length;
  const casualHits = (joined.match(/(?:だね|ですね！|よろしく！|ありがとう[。!！]|了解)/g) ?? []).length;
  const perMail = formalHits / bodies.length;
  if (perMail >= 1) return 'formal';
  if (casualHits > formalHits) return 'casual';
  return 'standard';
}

/**
 * 送信メール群から文体プロファイルを作る。
 * bodies は佐藤自身が送ったメールの生本文（引用・署名込みでよい）。
 */
export function buildStyleProfile(rawBodies: readonly string[], maxCharsPerBody = 2000): StyleProfile {
  const bodies = rawBodies
    .map((b) => sanitizeSentBody(b, maxCharsPerBody))
    .filter((b) => b.trim() !== '');

  if (bodies.length === 0) {
    return {
      greetings: [],
      salutations: [],
      closings: [],
      signature: '',
      averageBodyLength: 0,
      politeness: 'standard',
      sampleCount: 0,
    };
  }

  const signature = detectSignature(bodies);
  const withoutSignature = bodies.map((b) => removeSignature(b, signature));

  const greetings: string[] = [];
  const salutations: string[] = [];
  const closings: string[] = [];

  for (const body of withoutSignature) {
    const lines = nonEmptyLines(body);
    if (lines.length === 0) continue;

    // 相手の呼び方は先頭2行のどこか
    for (const line of lines.slice(0, 2)) {
      const m = line.match(SALUTATION_RE);
      if (m) {
        // 実名は残さず「〇〇様」の形にする（プロファイルは AI へ渡るため）
        salutations.push(`〇〇${m[2] ?? ''}`);
        break;
      }
    }
    // 冒頭挨拶は先頭3行のどこか
    for (const line of lines.slice(0, 3)) {
      const hit = GREETING_PATTERNS.find((re) => re.test(line));
      if (hit) {
        greetings.push(line);
        break;
      }
    }
    // 締めは末尾3行のどこか
    for (const line of lines.slice(-3).reverse()) {
      const hit = CLOSING_PATTERNS.find((re) => re.test(line));
      if (hit) {
        closings.push(line);
        break;
      }
    }
  }

  const lengths = withoutSignature.map((b) => b.replace(/\s/g, '').length);
  const averageBodyLength =
    lengths.length === 0 ? 0 : lengths.reduce((a, b) => a + b, 0) / lengths.length;

  return {
    greetings: uniqueTop(greetings, MAX_EXAMPLES),
    salutations: uniqueTop(salutations, MAX_EXAMPLES),
    closings: uniqueTop(closings, MAX_EXAMPLES),
    signature,
    averageBodyLength,
    politeness: detectPoliteness(withoutSignature),
    sampleCount: bodies.length,
  };
}

/**
 * 下書きに付ける署名を決める。
 * 設定の SIGNATURE_TEXT が最優先。無ければ過去の送信メールから推定したもの。
 */
export function resolveSignature(configured: string, profile: StyleProfile): string {
  if (configured.trim() !== '') return configured.trim();
  return profile.signature;
}
