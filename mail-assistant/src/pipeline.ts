/**
 * オーケストレーション。
 *
 * 流れ:
 *   1. 稼働ゲート（営業日・稼働時間）
 *   2. 検索窓の決定（前回実行時刻 - 余裕分、上限あり）
 *   3. 新着メールを取得
 *   4. 重複チェック（履歴）→ 受信時刻ゲート
 *   5. ヒューリスティクス（AI を呼ばずに弾けるものを弾く）
 *   6. Stage 1: 返信要否の判定
 *   7. Stage 2: REPLY_REQUIRED のみ、過去メールを集めて返信案を起草
 *   8. 副作用（下書き作成・ラベル付与）— dryRun なら何もしない
 *   9. 履歴へ記録
 *
 * 例外方針: 1通の失敗で実行全体を落とさない。個別に捕捉してエラー記録に残し、
 * 次のメールへ進む。ただし下書き作成は失敗したら作らない（安全側）。
 */
import type { Config } from './config.js';
import type { Ports } from './ports.js';
import type {
  Action,
  AiResult,
  DecisionPreview,
  MailMessage,
  MailThread,
  ProcessingRecord,
  RunSummary,
  StyleProfile,
} from './types.js';
import { computeSearchWindow, evaluateRunGate, isReceivedInScope, toZoned } from './time/schedule.js';
import { toIsoDate } from './time/holidays.js';
import { evaluateHeuristics } from './classify/heuristics.js';
import {
  applyDraftChecks,
  decide,
  decideFromHeuristics,
  decideFromParseFailure,
  needsDrafting,
  type Decision,
} from './classify/decide.js';
import { parseAiResult } from './ai/contract.js';
import { buildClassifyPrompt, buildDraftPrompt, type PromptMessageView } from './ai/prompt.js';
import { sanitizeBody } from './text/sanitize.js';
import { domainOf, reasonCode, subjectExcerpt } from './text/redact.js';
import {
  buildDomainHistoryQuery,
  buildInboxQuery,
  buildSenderHistoryQuery,
  buildSentSimilarQuery,
  buildSentStyleQuery,
  subjectKeywords,
} from './mail/query.js';
import { buildStyleProfile, resolveSignature } from './mail/style.js';
import { buildReplyMime, replySubject } from './mail/mime.js';
import { hasDeliverableRecipient, resolveReplyRecipients } from './mail/recipients.js';

const REVIEW_NOTICE_PREFIX = '【AI判定：要確認】';

interface LabelPlan {
  readonly names: readonly string[];
}

function labelsFor(action: Action, config: Config, important: boolean): LabelPlan {
  const names: string[] = [];
  switch (action) {
    case 'draft':
      names.push(config.labelDraft, config.labelDone);
      break;
    case 'review-draft':
      names.push(config.labelReview, config.labelDone);
      break;
    case 'label-review':
      names.push(config.labelReview, config.labelDone);
      break;
    case 'label-no-reply':
      names.push(config.labelNoReply, config.labelDone);
      break;
    case 'error':
      names.push(config.labelError);
      break;
    case 'log-only':
      break;
  }
  if (important && config.labelImportant !== '') names.push(config.labelImportant);
  return { names: names.filter((n) => n !== '') };
}

function monthsAgoEpochSeconds(nowMs: number, months: number): number {
  const d = new Date(nowMs);
  d.setUTCMonth(d.getUTCMonth() - months);
  return Math.floor(d.getTime() / 1000);
}

function toPromptView(
  message: MailMessage,
  config: Config,
  targetIsSender: boolean,
): PromptMessageView {
  const sanitized = sanitizeBody(message.body, { maxChars: Math.min(1200, config.bodyMaxChars) });
  const zoned = toZoned(message.receivedAt, config.timezoneOffsetMinutes);
  return {
    fromLabel: targetIsSender ? '佐藤光彦' : `${message.from.name} <${message.from.email}>`,
    subject: message.subject,
    dateLabel: `${zoned.year}-${String(zoned.month).padStart(2, '0')}-${String(zoned.day).padStart(2, '0')}`,
    body: sanitized.text,
    direction: targetIsSender ? 'sent' : 'received',
  };
}

function isFromTarget(message: MailMessage, config: Config): boolean {
  return message.from.email === config.targetEmail || message.labelIds.includes('SENT');
}

/** 同一スレッドの履歴を、対象メールを除いて古い順に整える。 */
function threadHistoryViews(
  thread: MailThread | null,
  currentId: string,
  config: Config,
): readonly PromptMessageView[] {
  if (!thread) return [];
  const others = thread.messages
    .filter((m) => m.id !== currentId && !m.labelIds.includes('DRAFT'))
    .slice(-config.threadMaxMessages);
  return others.map((m) => toPromptView(m, config, isFromTarget(m, config)));
}

/**
 * 参考にする過去メールを集める。
 * 優先順位: 同一送信者 → 同一ドメイン → 類似件名の自分の送信メール。
 * 取得件数は historyMaxMessages で頭を打つ。
 */
function collectRelatedHistory(
  ports: Ports,
  message: MailMessage,
  config: Config,
  nowMs: number,
): { views: readonly PromptMessageView[]; style: StyleProfile } {
  const after = monthsAgoEpochSeconds(nowMs, config.historyLookbackMonths);
  const budget = config.historyMaxMessages;
  const seen = new Set<string>([message.id]);
  const collected: MailMessage[] = [];

  const take = (query: string, limit: number): void => {
    if (collected.length >= budget || limit <= 0) return;
    let ids: readonly string[] = [];
    try {
      ids = ports.gmail.searchMessageIds(query, Math.min(limit, budget - collected.length));
    } catch (e) {
      ports.logger.warn('過去メール検索に失敗（この段はスキップ）', { error: String(e).slice(0, 200) });
      return;
    }
    for (const id of ids) {
      if (collected.length >= budget) break;
      if (seen.has(id)) continue;
      seen.add(id);
      try {
        collected.push(ports.gmail.getMessage(id));
      } catch (e) {
        ports.logger.warn('過去メール取得に失敗', { error: String(e).slice(0, 200) });
      }
    }
  };

  const senderShare = Math.max(1, Math.floor(budget * 0.5));
  const domainShare = Math.max(1, Math.floor(budget * 0.25));
  const similarShare = Math.max(1, budget - senderShare - domainShare);

  take(buildSenderHistoryQuery(message.from.email, after), senderShare);
  const domain = domainOf(message.from.email);
  if (domain !== '') take(buildDomainHistoryQuery(domain, after), domainShare);
  take(buildSentSimilarQuery(subjectKeywords(message.subject), after), similarShare);

  // 文体プロファイルは「佐藤自身の送信メール」だけから作る
  const sentBodies: string[] = collected
    .filter((m) => isFromTarget(m, config))
    .map((m) => m.body);

  if (sentBodies.length < 3) {
    // 参考が少なければ送信済みメール全般から補う
    try {
      const ids = ports.gmail.searchMessageIds(buildSentStyleQuery(after), 10);
      for (const id of ids) {
        if (sentBodies.length >= 10) break;
        if (seen.has(id)) continue;
        seen.add(id);
        sentBodies.push(ports.gmail.getMessage(id).body);
      }
    } catch (e) {
      ports.logger.warn('文体推定用の送信メール取得に失敗', { error: String(e).slice(0, 200) });
    }
  }

  const views = collected
    .sort((a, b) => a.receivedAt - b.receivedAt)
    .map((m) => toPromptView(m, config, isFromTarget(m, config)));

  return { views, style: buildStyleProfile(sentBodies) };
}

interface MessageOutcome {
  readonly decision: Decision;
  readonly draftId: string;
  readonly preview: DecisionPreview;
  readonly error: string;
}

/** 1通の処理。副作用は dryRun でない場合のみ行う。 */
function processMessage(
  ports: Ports,
  config: Config,
  message: MailMessage,
  nowMs: number,
): MessageOutcome {
  const thread = safeGetThread(ports, message.threadId);
  const heuristics = evaluateHeuristics(message, thread, config);
  const sanitized = sanitizeBody(message.body, { maxChars: config.bodyMaxChars });
  const senderDomain = domainOf(message.from.email);

  const makePreview = (decision: Decision, draftBody: string): DecisionPreview => ({
    messageId: message.id,
    threadId: message.threadId,
    senderDomain,
    subjectExcerpt: subjectExcerpt(message.subject),
    classification: decision.classification,
    confidence: decision.confidence,
    action: decision.action,
    reason: reasonCode(decision.reason, 200),
    missingInformation: decision.missingInformation,
    riskFlags: decision.riskFlags,
    draftBody: config.previewIncludeDraft ? draftBody : '',
  });

  // --- ヒューリスティクスで確定するもの（AI を呼ばない） ---
  if (heuristics.action === 'skip') {
    const decision = decideFromHeuristics(heuristics);
    applyLabels(ports, config, message.threadId, decision.action, heuristics.important);
    return { decision, draftId: '', preview: makePreview(decision, ''), error: '' };
  }

  // --- Stage 1: 返信要否 ---
  const inboundText = `${message.subject}\n${sanitized.text}`;
  const classifyPrompt = buildClassifyPrompt({
    message,
    bodyText: sanitized.text,
    threadHistory: threadHistoryViews(thread, message.id, config),
    toContainsTarget: message.to.some((a) => a.email === config.targetEmail),
    ccOnly: heuristics.ccOnly,
    recipientCount: message.to.length + message.cc.length,
    hasAttachments: message.attachmentNames.length > 0,
    attachmentNames: message.attachmentNames,
    config,
  });

  let stage1: AiResult;
  try {
    const raw = ports.ai.generate(classifyPrompt.system, classifyPrompt.user);
    const parsed = parseAiResult(raw);
    if (!parsed.ok) {
      const decision = decideFromParseFailure(parsed.error);
      applyLabels(ports, config, message.threadId, decision.action, heuristics.important);
      return { decision, draftId: '', preview: makePreview(decision, ''), error: '' };
    }
    stage1 = parsed.value;
  } catch (e) {
    // AI 障害時は安全側: 下書きを作らずエラーとして残す
    const decision: Decision = {
      classification: 'REVIEW_REQUIRED',
      confidence: 0,
      action: 'error',
      reason: 'ai-request-failed',
      riskFlags: ['AI呼び出し失敗'],
      missingInformation: [],
      injectionSuspected: false,
    };
    applyLabels(ports, config, message.threadId, 'error', heuristics.important);
    return {
      decision,
      draftId: '',
      preview: makePreview(decision, ''),
      error: `ai-request-failed:${String(e).slice(0, 80)}`,
    };
  }

  let decision = decide({ ai: stage1, heuristics, inboundText, config });
  let draftBody = '';
  let draftSubject = replySubject(message.subject);
  let stage2: AiResult | null = null;

  // --- Stage 2: 起草（返信が必要なものだけ） ---
  if (needsDrafting(decision)) {
    const related = collectRelatedHistory(ports, message, config, nowMs);
    const draftPrompt = buildDraftPrompt({
      message,
      bodyText: sanitized.text,
      threadHistory: threadHistoryViews(thread, message.id, config),
      relatedHistory: related.views,
      style: related.style,
      language: stage1.language,
      hasAttachments: message.attachmentNames.length > 0,
      attachmentNames: message.attachmentNames,
      config,
    });

    try {
      const raw = ports.ai.generate(draftPrompt.system, draftPrompt.user);
      const parsed = parseAiResult(raw);
      if (!parsed.ok) {
        decision = decideFromParseFailure(parsed.error);
      } else {
        stage2 = parsed.value;
        decision = applyDraftChecks(decision, stage2, config);
        draftBody = stage2.draftBody;
        if (stage2.draftSubject.trim() !== '') draftSubject = replySubject(stage2.draftSubject);
      }
    } catch (e) {
      const failed: Decision = {
        classification: 'REVIEW_REQUIRED',
        confidence: decision.confidence,
        action: 'error',
        reason: `${decision.reason} | draft-request-failed`,
        riskFlags: [...decision.riskFlags, 'AI起草失敗'],
        missingInformation: decision.missingInformation,
        injectionSuspected: decision.injectionSuspected,
      };
      applyLabels(ports, config, message.threadId, 'error', heuristics.important);
      return {
        decision: failed,
        draftId: '',
        preview: makePreview(failed, ''),
        error: `draft-request-failed:${String(e).slice(0, 80)}`,
      };
    }

    // 署名は設定優先、無ければ過去の送信メールから推定したもの
    const signature = resolveSignature(config.signatureText, related.style);
    const outcome = createDraftIfAllowed(
      ports,
      config,
      message,
      thread,
      decision,
      draftBody,
      draftSubject,
      signature,
    );
    applyLabels(ports, config, message.threadId, outcome.action, heuristics.important);
    const finalDecision: Decision = { ...decision, action: outcome.action, reason: outcome.reason };
    return {
      decision: finalDecision,
      draftId: outcome.draftId,
      preview: makePreview(finalDecision, draftBody),
      error: outcome.error,
    };
  }

  applyLabels(ports, config, message.threadId, decision.action, heuristics.important);
  return { decision, draftId: '', preview: makePreview(decision, draftBody), error: '' };
}

interface DraftOutcome {
  readonly action: Action;
  readonly draftId: string;
  readonly reason: string;
  readonly error: string;
}

/**
 * 下書きを作る（dryRun でなければ）。
 * 宛先が決まらない・スレッドに既に下書きがある場合は作らない。
 */
function createDraftIfAllowed(
  ports: Ports,
  config: Config,
  message: MailMessage,
  thread: MailThread | null,
  decision: Decision,
  draftBody: string,
  draftSubject: string,
  signature: string,
): DraftOutcome {
  // 起草後の検査（applyDraftChecks）で降格していたら、ここで確実に止める。
  // decision.action が下書きを求めていない限り、絶対に書き込まない。
  if (decision.action !== 'draft' && decision.action !== 'review-draft') {
    return { action: decision.action, draftId: '', reason: decision.reason, error: '' };
  }

  const recipients = resolveReplyRecipients(message, thread, config);
  if (!hasDeliverableRecipient(recipients)) {
    return {
      action: 'label-review',
      draftId: '',
      reason: `${decision.reason} | no-recipient`,
      error: '',
    };
  }

  // 重複作成の防止（履歴とは別に、Gmail 側の実状も見る）
  try {
    if (ports.gmail.threadHasDraft(message.threadId)) {
      return {
        action: 'label-review',
        draftId: '',
        reason: `${decision.reason} | draft-already-exists`,
        error: '',
      };
    }
  } catch (e) {
    return {
      action: 'error',
      draftId: '',
      reason: `${decision.reason} | draft-check-failed`,
      error: `draft-check-failed:${String(e).slice(0, 80)}`,
    };
  }

  const notice =
    decision.action === 'review-draft'
      ? `${REVIEW_NOTICE_PREFIX} ${reasonCode(decision.reason, 200)}\n（この下書きは確認用です。内容を必ず確認してから送信してください。）`
      : '';

  const raw = buildReplyMime({
    to: recipients.to,
    cc: recipients.cc,
    originalSubject: draftSubject,
    body: draftBody,
    inReplyTo: message.headers['message-id'] ?? '',
    references: message.headers['references'] ?? '',
    signature,
    notice,
  });

  if (config.dryRun) {
    return {
      action: decision.action,
      draftId: '',
      reason: `${decision.reason} | dry-run(${recipients.notes.join(',')})`,
      error: '',
    };
  }

  try {
    const draftId = ports.gmail.createDraft({ threadId: message.threadId, raw });
    return {
      action: decision.action,
      draftId,
      reason: `${decision.reason} | ${recipients.notes.join(',')}`,
      error: '',
    };
  } catch (e) {
    return {
      action: 'error',
      draftId: '',
      reason: `${decision.reason} | draft-create-failed`,
      error: `draft-create-failed:${String(e).slice(0, 80)}`,
    };
  }
}

function applyLabels(
  ports: Ports,
  config: Config,
  threadId: string,
  action: Action,
  important: boolean,
): void {
  if (config.dryRun) return;
  const plan = labelsFor(action, config, important);
  if (plan.names.length === 0) return;
  try {
    const ids = plan.names.map((n) => ports.gmail.ensureLabel(n));
    ports.gmail.addThreadLabels(threadId, ids);
  } catch (e) {
    ports.logger.warn('ラベル付与に失敗', { threadId, error: String(e).slice(0, 200) });
  }
}

function safeGetThread(ports: Ports, threadId: string): MailThread | null {
  try {
    return ports.gmail.getThread(threadId);
  } catch (e) {
    ports.logger.warn('スレッド取得に失敗（単体メールとして処理）', {
      threadId,
      error: String(e).slice(0, 200),
    });
    return null;
  }
}

/** 履歴を見て、この message を再処理すべきか。 */
export function shouldProcess(
  messageId: string,
  processed: ReadonlyMap<string, ProcessingRecord>,
  config: Config,
): boolean {
  const record = processed.get(messageId);
  if (record === undefined) return true;
  // エラーで終わったものは retryMax まで再挑戦する
  if (record.error !== '') return config.retryMax > 0;
  return false;
}

/** 実行本体。 */
export function runAssistant(ports: Ports, config: Config): RunSummary {
  const startedMs = ports.clock.nowMs();
  const startedAt = new Date(startedMs).toISOString();
  const empty: RunSummary = {
    startedAt,
    skippedReason: '',
    examined: 0,
    drafted: 0,
    review: 0,
    noReply: 0,
    errors: 0,
    dryRun: config.dryRun,
    previews: [],
  };

  const gate = evaluateRunGate(startedMs, config);
  if (!gate.ok) {
    ports.logger.info('稼働条件外のため何もしない', { reason: gate.reason });
    return { ...empty, skippedReason: gate.reason };
  }

  const window = computeSearchWindow(startedMs, ports.state.getLastRunAt(), config);
  const query = buildInboxQuery(config, window.afterEpochSeconds);
  ports.logger.info('検索開始', {
    query,
    dryRun: config.dryRun,
    testMode: config.testMode,
    from: new Date(window.fromMs).toISOString(),
  });

  let ids: readonly string[];
  try {
    ids = ports.gmail.searchMessageIds(query, config.maxMessagesPerRun);
  } catch (e) {
    // Gmail 障害時はカーソルを進めない（次回に再試行できるようにする）
    ports.logger.error('Gmail 検索に失敗。カーソルを進めずに終了', {
      error: String(e).slice(0, 200),
    });
    return { ...empty, skippedReason: 'gmail-search-failed', errors: 1 };
  }

  const processed = ports.history.loadProcessed();
  let examined = 0;
  let drafted = 0;
  let review = 0;
  let noReply = 0;
  let errors = 0;
  const previews: DecisionPreview[] = [];

  for (const id of ids) {
    if (examined >= config.maxMessagesPerRun) break;
    if (!shouldProcess(id, processed, config)) continue;

    let message: MailMessage;
    try {
      message = ports.gmail.getMessage(id);
    } catch (e) {
      errors += 1;
      ports.logger.warn('メール取得に失敗', { messageId: id, error: String(e).slice(0, 200) });
      continue;
    }

    if (!isReceivedInScope(message.receivedAt, config)) continue;

    examined += 1;
    let outcome: MessageOutcome;
    try {
      outcome = processMessage(ports, config, message, startedMs);
    } catch (e) {
      errors += 1;
      ports.logger.error('処理中に想定外のエラー', {
        messageId: id,
        error: String(e).slice(0, 200),
      });
      recordSafely(ports, {
        messageId: message.id,
        threadId: message.threadId,
        receivedAt: new Date(message.receivedAt).toISOString(),
        processedAt: new Date(ports.clock.nowMs()).toISOString(),
        classification: 'REVIEW_REQUIRED',
        confidence: 0,
        action: 'error',
        draftId: '',
        error: `unexpected:${String(e).slice(0, 80)}`,
        model: ports.ai.modelId,
        important: false,
        injectionSuspected: false,
        senderDomain: domainOf(message.from.email),
        reasonCode: 'unexpected-error',
      });
      continue;
    }

    switch (outcome.decision.classification) {
      case 'REPLY_REQUIRED':
        drafted += 1;
        break;
      case 'REVIEW_REQUIRED':
        review += 1;
        break;
      case 'NO_REPLY_REQUIRED':
        noReply += 1;
        break;
    }
    if (outcome.error !== '') errors += 1;
    previews.push(outcome.preview);

    recordSafely(ports, {
      messageId: message.id,
      threadId: message.threadId,
      receivedAt: new Date(message.receivedAt).toISOString(),
      processedAt: new Date(ports.clock.nowMs()).toISOString(),
      classification: outcome.decision.classification,
      confidence: outcome.decision.confidence,
      action: outcome.decision.action,
      draftId: outcome.draftId,
      error: outcome.error,
      model: ports.ai.modelId,
      important: outcome.decision.riskFlags.includes('重要メール'),
      injectionSuspected: outcome.decision.injectionSuspected,
      senderDomain: domainOf(message.from.email),
      reasonCode: reasonCode(outcome.decision.reason),
    });

    ports.logger.info('判定', {
      messageId: message.id,
      classification: outcome.decision.classification,
      confidence: outcome.decision.confidence,
      action: outcome.decision.action,
      draftCreated: outcome.draftId !== '',
    });
  }

  // カーソル前進は「検索が成功した」場合のみ。個別メールの失敗は履歴側で再試行される。
  ports.state.setLastRunAt(startedMs);

  const summary: RunSummary = {
    startedAt,
    skippedReason: '',
    examined,
    drafted,
    review,
    noReply,
    errors,
    dryRun: config.dryRun,
    previews,
  };
  ports.logger.info('実行完了', {
    examined,
    drafted,
    review,
    noReply,
    errors,
    dryRun: config.dryRun,
  });
  return summary;
}

function recordSafely(ports: Ports, record: ProcessingRecord): void {
  try {
    ports.history.append(record);
  } catch (e) {
    ports.logger.warn('履歴の書き込みに失敗', { error: String(e).slice(0, 200) });
  }
}

/** 現地時刻の日付文字列（YYYY-MM-DD）。 */
export function localIsoDate(epochMs: number, config: Config): string {
  return toIsoDate(toZoned(epochMs, config.timezoneOffsetMinutes));
}
