/**
 * AI 出力の契約と検証（純関数）。
 *
 * AI の出力は信頼しない。JSON として妥当か、値域が正しいかを機械的に検証し、
 * 少しでも怪しければ REVIEW_REQUIRED へ落とす（安全側に倒す）。
 */
import { CLASSIFICATIONS, type AiResult, type Classification } from '../types.js';

export type ParseResult =
  | { readonly ok: true; readonly value: AiResult }
  | { readonly ok: false; readonly error: string };

const MAX_REASON = 400;
const MAX_BODY = 8000;
const MAX_SUBJECT = 400;
const MAX_LIST_ITEMS = 20;
const MAX_LIST_ITEM_CHARS = 200;

function isClassification(v: unknown): v is Classification {
  return typeof v === 'string' && (CLASSIFICATIONS as readonly string[]).includes(v);
}

function asString(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  const s = v.replace(/\r\n?/g, '\n').trim();
  return s.length > max ? s.slice(0, max) : s;
}

function asStringList(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const s = item.trim();
    if (s === '') continue;
    out.push(s.length > MAX_LIST_ITEM_CHARS ? s.slice(0, MAX_LIST_ITEM_CHARS) : s);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out;
}

/**
 * コードフェンス付き・前後に文章付きの出力からも JSON を取り出す。
 * 灯台の summarize.py と同じ問題への同じ対処（モデルは指示に反して装飾を付けてくる）。
 */
export function extractJsonObject(raw: string): unknown {
  let text = (raw ?? '').trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return JSON.parse(text);
  } catch {
    // 前後に余分な文章がある場合に最初の { から最後の } までを試す
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/** AI 出力を検証して AiResult にする。壊れていれば ok:false。 */
export function parseAiResult(raw: string): ParseResult {
  const parsed = extractJsonObject(raw);
  if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'json-parse-failed' };
  }
  const obj = parsed as Record<string, unknown>;

  if (!isClassification(obj['classification'])) {
    return { ok: false, error: 'invalid-classification' };
  }
  const confidenceRaw = obj['confidence'];
  if (typeof confidenceRaw !== 'number' || !isFinite(confidenceRaw)) {
    return { ok: false, error: 'invalid-confidence' };
  }
  // 0〜1 以外（例: 0〜100 で返してきた）は信頼できないので弾く
  if (confidenceRaw < 0 || confidenceRaw > 1) {
    return { ok: false, error: 'confidence-out-of-range' };
  }

  const reason = asString(obj['reason'], MAX_REASON);
  if (reason === '') return { ok: false, error: 'missing-reason' };

  const language = asString(obj['language'], 16) || 'ja';

  return {
    ok: true,
    value: {
      classification: obj['classification'],
      confidence: confidenceRaw,
      reason,
      language,
      draftSubject: asString(obj['draftSubject'], MAX_SUBJECT),
      draftBody: asString(obj['draftBody'], MAX_BODY),
      missingInformation: asStringList(obj['missingInformation']),
      riskFlags: asStringList(obj['riskFlags']),
    },
  };
}

// ---------------------------------------------------------------------------
// 出力の内容チェック（捏造・AI 自己言及・未知 URL）
// ---------------------------------------------------------------------------

/** 「AI が書いた」と本文で明かしてしまうパターン。 */
const AI_SELF_REFERENCE: readonly RegExp[] = [
  /AI(?:が|により|によって|アシスタント|が生成|が作成)/,
  /人工知能/,
  /(?:言語|生成)モデル/,
  /as an AI\b/i,
  /I am an AI\b/i,
  /(?:chatgpt|gemini|claude|copilot)/i,
  /自動生成(?:された|され た)?(?:返信|メール|文)/,
];

export function containsAiSelfReference(body: string): boolean {
  return AI_SELF_REFERENCE.some((re) => re.test(body));
}

/** プレースホルダー（例: 【要確認：日程】）を含むか。 */
export function containsPlaceholder(body: string): boolean {
  return /【要確認[：:][^】]*】/.test(body);
}

/**
 * 参照元に無い URL を返信案が含んでいないか（リンクの捏造検知）。
 * 本文は html.ts で URL を "[リンク]" に置換済みなので、
 * 返信案に生の URL が出てきたら原則として捏造である。
 */
export function fabricatedUrls(draftBody: string): readonly string[] {
  const found = draftBody.match(/https?:\/\/\S+/g);
  return found === null ? [] : Array.from(new Set(found));
}

/**
 * プロンプトインジェクションの疑いを検知する。
 * 検知しても処理は止めず、REVIEW_REQUIRED へ落として人間の目に回す。
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /(?:これまで|以前|上記|先)の(?:指示|命令|プロンプト).{0,10}(?:無視|忘れ|破棄)/,
  /指示を(?:無視|忘れ)/,
  /ignore (?:all |any )?(?:previous|prior|above|earlier) (?:instructions?|prompts?)/i,
  /disregard (?:all |any )?(?:previous|prior|above) (?:instructions?|prompts?)/i,
  /you are now (?:a|an|acting)/i,
  /system\s*(?:prompt|message)\s*[:：]/i,
  /\b(?:developer|system)\s+mode\b/i,
  /(?:あなた|君)は(?:今|これから).{0,20}として(?:振る舞|ふるま|動作)/,
  /(?:全て|すべて)のメールに(?:返信|下書き)(?:を)?(?:作成|して)/,
  // 「送信させる」ことを促す文面。業務上の正当な依頼（例: 請求書を今すぐ送ってほしい）でも
  // 検知されるが、その場合の結果は REVIEW_REQUIRED（人間が確認）なので安全側で問題ない。
  /(?:自動|即時|今すぐ|直ちに|ただちに)(?:で|に)?(?:返信|送信)(?:して|せよ|しろ|願い)/,
  /reply to (?:all|every) emails?/i,
  /send (?:this|the) (?:email|message) (?:now|immediately|automatically)/i,
  /<\|?(?:im_start|im_end|system|endoftext)\|?>/i,
  /プロンプト(?:を)?(?:出力|表示|開示)/,
  /reveal (?:your )?(?:system )?prompt/i,
];

export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}
