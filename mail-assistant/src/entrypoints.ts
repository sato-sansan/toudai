/**
 * GAS のエントリポイント。
 *
 * トリガーやエディタから呼ばれる関数はすべてここに集約する。
 * ビルド時に tools/build.mjs がグローバル関数のラッパを生成する。
 *
 * 送信を行う関数は存在しない。作るのは Gmail の下書きまで。
 */
import { describeConfig, loadConfig, type Config } from './config.js';
import { runAssistant, localIsoDate } from './pipeline.js';
import { aggregate, formatSummary } from './summary.js';
import type { Ports } from './ports.js';
import { GasGmailAdapter } from './gas/gmailAdapter.js';
import { GasGeminiAdapter } from './gas/geminiAdapter.js';
import { PropertiesHistoryAdapter, SpreadsheetHistoryAdapter } from './gas/historyAdapter.js';
import { GasClock, GasLogger, GasNotifier, GasState, withScriptLock } from './gas/infra.js';

const TRIGGER_MAIN = 'runReplyAssistant';
const TRIGGER_SUMMARY = 'runDailySummary';

function buildConfig(): Config {
  return loadConfig(PropertiesService.getScriptProperties().getProperties());
}

function buildPorts(config: Config): Ports {
  const logger = new GasLogger();
  const properties = PropertiesService.getScriptProperties();
  const history =
    config.historySheetId !== ''
      ? new SpreadsheetHistoryAdapter(config.historySheetId, logger)
      : new PropertiesHistoryAdapter(properties, logger);
  return {
    gmail: new GasGmailAdapter(),
    ai: new GasGeminiAdapter(config, logger),
    history,
    state: new GasState(properties),
    clock: new GasClock(),
    logger,
    notifier: new GasNotifier(config, logger),
  };
}

/**
 * 本番の定期実行エントリ。時間主導トリガーから呼ばれる。
 * 稼働時間・営業日の判定は pipeline 側で行うので、トリガーは 24 時間動いていてよい。
 */
export function runReplyAssistant(): void {
  const logger = new GasLogger();
  const result = withScriptLock(() => {
    let config: Config;
    try {
      config = buildConfig();
    } catch (e) {
      logger.error('設定の読み込みに失敗。処理を中止する', { error: String(e).slice(0, 300) });
      return null;
    }
    const ports = buildPorts(config);
    return runAssistant(ports, config);
  });

  if (result === null) {
    logger.info('別の実行が進行中のためスキップ（多重起動防止）');
  }
}

/**
 * ドライラン強制のプレビュー実行。
 * Script Properties の DRY_RUN が false でも、この関数からは書き込みを行わない。
 */
export function runDryRunPreview(): void {
  const logger = new GasLogger();
  let config: Config;
  try {
    config = { ...buildConfig(), dryRun: true };
  } catch (e) {
    logger.error('設定の読み込みに失敗', { error: String(e).slice(0, 300) });
    return;
  }
  const ports = buildPorts(config);
  const summary = runAssistant(ports, config);

  logger.info('=== ドライラン結果 ===', {
    examined: summary.examined,
    drafted: summary.drafted,
    review: summary.review,
    noReply: summary.noReply,
    errors: summary.errors,
    skippedReason: summary.skippedReason,
  });
  for (const p of summary.previews) {
    logger.info(
      [
        '--- 判定プレビュー ---',
        `messageId: ${p.messageId}`,
        `送信元ドメイン: ${p.senderDomain}`,
        `件名(抜粋): ${p.subjectExcerpt}`,
        `判定: ${p.classification} (確信度 ${p.confidence.toFixed(2)})`,
        `動作: ${p.action}`,
        `理由: ${p.reason}`,
        `不明情報: ${p.missingInformation.join(' / ') || 'なし'}`,
        `リスク: ${p.riskFlags.join(' / ') || 'なし'}`,
        p.draftBody !== '' ? `返信案:\n${p.draftBody}` : '返信案: (非表示設定)',
      ].join('\n'),
    );
  }
}

/** 日次集計。18:05 のトリガーから呼ばれる。メール送信は行わない。 */
export function runDailySummary(): void {
  const logger = new GasLogger();
  let config: Config;
  try {
    config = buildConfig();
  } catch (e) {
    logger.error('設定の読み込みに失敗', { error: String(e).slice(0, 300) });
    return;
  }
  if (!config.summaryEnabled) {
    logger.info('日次集計は無効（SUMMARY_ENABLED=false）');
    return;
  }
  const ports = buildPorts(config);
  const date = localIsoDate(ports.clock.nowMs(), config);
  const stats = aggregate(date, ports.history.recordsForDate(date));
  ports.notifier.notify(formatSummary(stats, config));
}

/** 設定の確認用。秘密は伏せて出力する。 */
export function showEffectiveConfig(): void {
  const logger = new GasLogger();
  try {
    const described = describeConfig(buildConfig());
    const lines = Object.keys(described)
      .sort()
      .map((k) => `${k} = ${described[k] ?? ''}`);
    logger.info(`=== 有効な設定 ===\n${lines.join('\n')}`);
  } catch (e) {
    logger.error('設定が不正です', { error: String(e).slice(0, 300) });
  }
}

/** ラベルを事前に作る（Gmail 上で先に見えるようにしたいとき用）。 */
export function setupLabels(): void {
  const logger = new GasLogger();
  const config = buildConfig();
  const gmail = new GasGmailAdapter();
  const names = [
    config.labelDraft,
    config.labelReview,
    config.labelNoReply,
    config.labelDone,
    config.labelError,
    config.labelImportant,
    config.testLabel,
  ].filter((n) => n !== '');
  for (const name of names) {
    gmail.ensureLabel(name);
  }
  logger.info('ラベルを作成した', { names });
}

/**
 * トリガーを設置する。
 *
 * **人間が明示的に実行すること。** このスクリプトが自動で呼ぶことはない。
 * 既存の同名トリガーは一度削除してから作り直す（重複設置を防ぐ）。
 */
export function installTriggers(): void {
  const logger = new GasLogger();
  const config = buildConfig();
  removeTriggers();

  ScriptApp.newTrigger(TRIGGER_MAIN).timeBased().everyMinutes(config.runIntervalMinutes).create();
  if (config.summaryEnabled) {
    ScriptApp.newTrigger(TRIGGER_SUMMARY)
      .timeBased()
      .atHour(config.workEndHour)
      .nearMinute(5)
      .everyDays(1)
      .inTimezone(config.timezone)
      .create();
  }
  logger.info('トリガーを設置した', {
    intervalMinutes: config.runIntervalMinutes,
    summaryHour: config.workEndHour,
    dryRun: config.dryRun,
  });
  if (config.dryRun) {
    logger.warn('DRY_RUN=true のままです。実際の下書きは作成されません。');
  }
}

/** トリガーを全削除する（ロールバック用）。 */
export function removeTriggers(): void {
  const logger = new GasLogger();
  let removed = 0;
  for (const trigger of ScriptApp.getProjectTriggers()) {
    const handler = trigger.getHandlerFunction();
    if (handler === TRIGGER_MAIN || handler === TRIGGER_SUMMARY) {
      ScriptApp.deleteTrigger(trigger);
      removed += 1;
    }
  }
  logger.info('トリガーを削除した', { removed });
}
