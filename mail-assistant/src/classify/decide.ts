/**
 * 最終判定（純関数）。
 *
 * AI の出力・ヒューリスティクス・確信度閾値・安全チェックを突き合わせて、
 * 「何をするか」（Action）まで決める。ここが誤送信防止の最後の関門なので、
 * 迷ったら必ず下書きを作らない側へ倒す。
 *
 * 確信度の既定:
 *   >= 0.85            → 返信下書きを作成
 *   0.60 〜 0.84       → 要確認（ラベルのみ、または確認用下書き）
 *   < 0.60             → 下書きを作らずログのみ
 *
 * 2段構成に対応して関数を分けている:
 *   decide()            … Stage 1（返信要否）の結果から判定
 *   applyDraftChecks()  … Stage 2（起草）の返信案を検査して必要なら降格
 */
import type { Config } from '../config.js';
import type { AiResult, Action, Classification } from '../types.js';
import {
  containsAiSelfReference,
  containsPlaceholder,
  detectInjection,
  fabricatedUrls,
} from '../ai/contract.js';
import type { HeuristicVerdict } from './heuristics.js';

export interface Decision {
  readonly classification: Classification;
  readonly confidence: number;
  readonly action: Action;
  readonly reason: string;
  readonly riskFlags: readonly string[];
  readonly missingInformation: readonly string[];
  readonly injectionSuspected: boolean;
}

/** 確信度だけから区分を決める。 */
export function classifyByConfidence(
  aiClassification: Classification,
  confidence: number,
  config: Config,
): { classification: Classification; belowReviewFloor: boolean } {
  if (confidence < config.confidenceReviewThreshold) {
    return { classification: 'REVIEW_REQUIRED', belowReviewFloor: true };
  }
  if (confidence < config.confidenceReplyThreshold) {
    return { classification: 'REVIEW_REQUIRED', belowReviewFloor: false };
  }
  return { classification: aiClassification, belowReviewFloor: false };
}

/** 区分から実行する副作用を決める。 */
export function actionFor(
  classification: Classification,
  belowReviewFloor: boolean,
  config: Config,
): Action {
  if (belowReviewFloor) return 'log-only';
  switch (classification) {
    case 'REPLY_REQUIRED':
      return 'draft';
    case 'REVIEW_REQUIRED':
      return config.reviewCreatesDraft ? 'review-draft' : 'label-review';
    case 'NO_REPLY_REQUIRED':
      return 'label-no-reply';
  }
}

/** ヒューリスティクスで skip 確定した場合の判定。AI は呼ばない。 */
export function decideFromHeuristics(verdict: HeuristicVerdict): Decision {
  return {
    classification: 'NO_REPLY_REQUIRED',
    confidence: 1,
    action: 'label-no-reply',
    reason: `heuristic:${verdict.reasons.join(',')}`,
    riskFlags: verdict.important ? ['重要メール'] : [],
    missingInformation: [],
    injectionSuspected: false,
  };
}

/** AI 出力が JSON として壊れていた場合の判定（安全側＝要確認）。 */
export function decideFromParseFailure(error: string): Decision {
  return {
    classification: 'REVIEW_REQUIRED',
    confidence: 0,
    action: 'label-review',
    reason: `ai-output-invalid:${error}`,
    riskFlags: ['AI出力の検証失敗'],
    missingInformation: [],
    injectionSuspected: false,
  };
}

export interface DecideInput {
  readonly ai: AiResult;
  readonly heuristics: HeuristicVerdict;
  /** インジェクション検査に掛ける受信側テキスト（件名＋本文）。 */
  readonly inboundText: string;
  readonly config: Config;
}

/**
 * Stage 1 の総合判定。
 *
 * 降格（＝下書きを作らない方向）の条件:
 *   - 確信度が閾値未満
 *   - ヒューリスティクスが downgrade（Cc のみ等）
 *   - プロンプトインジェクションの疑い
 */
export function decide(input: DecideInput): Decision {
  const { ai, heuristics, config } = input;
  const riskFlags = new Set<string>(ai.riskFlags);
  const notes: string[] = [];

  const byConfidence = classifyByConfidence(ai.classification, ai.confidence, config);
  let classification = byConfidence.classification;
  const belowReviewFloor = byConfidence.belowReviewFloor;

  if (byConfidence.classification !== ai.classification) {
    notes.push(`confidence-gate=${ai.confidence.toFixed(2)}`);
  }

  const injectionSuspected = detectInjection(input.inboundText);
  if (injectionSuspected) {
    riskFlags.add('プロンプトインジェクションの疑い');
    notes.push('injection-suspected');
    if (classification === 'REPLY_REQUIRED') classification = 'REVIEW_REQUIRED';
  }

  // Cc のみ等: 原則返信不要なので REPLY_REQUIRED には上げない
  if (heuristics.action === 'downgrade' && classification === 'REPLY_REQUIRED') {
    classification = 'REVIEW_REQUIRED';
    notes.push(`downgraded:${heuristics.reasons.join(',')}`);
  }

  if (heuristics.important) riskFlags.add('重要メール');

  return {
    classification,
    confidence: ai.confidence,
    action: actionFor(classification, belowReviewFloor, config),
    reason: [ai.reason, ...notes].filter((s) => s !== '').join(' | '),
    riskFlags: Array.from(riskFlags),
    missingInformation: ai.missingInformation,
    injectionSuspected,
  };
}

/**
 * Stage 2 の返信案を検査する。
 *
 * 返信要否の区分（classification / confidence）は Stage 1 の結果を維持し、
 * ここでは返信案の内容だけを見て、危なければ降格する。
 *
 * 降格条件:
 *   - 返信案が AI であることに言及している
 *   - 返信案が URL を含む（参照元では URL を除去済みなので捏造の疑い）
 *   - 不明情報があるのにプレースホルダーが無い
 *   - 返信案が空
 */
export function applyDraftChecks(base: Decision, draft: AiResult, config: Config): Decision {
  const riskFlags = new Set<string>([...base.riskFlags, ...draft.riskFlags]);
  const notes: string[] = [];
  let classification = base.classification;
  let emptyDraft = false;

  if (draft.draftBody.trim() === '') {
    riskFlags.add('返信案が空');
    notes.push('empty-draft');
    classification = 'REVIEW_REQUIRED';
    emptyDraft = true;
  }
  if (containsAiSelfReference(draft.draftBody)) {
    riskFlags.add('返信案にAIへの言及');
    notes.push('ai-self-reference');
    classification = 'REVIEW_REQUIRED';
  }
  const urls = fabricatedUrls(draft.draftBody);
  if (urls.length > 0) {
    riskFlags.add('返信案に出典不明のURL');
    notes.push('fabricated-url');
    classification = 'REVIEW_REQUIRED';
  }
  const missing = draft.missingInformation.length > 0 ? draft.missingInformation : base.missingInformation;
  if (missing.length > 0 && !containsPlaceholder(draft.draftBody)) {
    riskFlags.add('不明情報のプレースホルダー欠落');
    notes.push('missing-placeholder');
    classification = 'REVIEW_REQUIRED';
  }

  // 返信案が空なら下書きを作る意味がないので、ラベルのみに落とす。
  const action =
    emptyDraft && classification === 'REVIEW_REQUIRED'
      ? 'label-review'
      : actionFor(classification, false, config);

  return {
    classification,
    confidence: base.confidence,
    action,
    reason: [base.reason, ...notes].filter((s) => s !== '').join(' | '),
    riskFlags: Array.from(riskFlags),
    missingInformation: missing,
    injectionSuspected: base.injectionSuspected,
  };
}

/** Stage 2（起草）を走らせるべきか。 */
export function needsDrafting(decision: Decision): boolean {
  return decision.action === 'draft' || decision.action === 'review-draft';
}
