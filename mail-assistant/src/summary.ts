/**
 * 日次集計（純関数 + 通知）。
 *
 * 18:05 頃にその日の処理結果を集計する。
 * メール送信は実装しない（自動送信を作らない方針）。出力先はログか Google Chat のみ。
 */
import type { Config } from './config.js';
import type { ProcessingRecord } from './types.js';

export interface DailyStats {
  readonly date: string;
  readonly examined: number;
  readonly drafted: number;
  readonly review: number;
  readonly noReply: number;
  readonly errors: number;
  readonly important: number;
  readonly injectionSuspected: number;
  readonly dryRunOnly: boolean;
}

/** 履歴レコードから当日の集計を作る。 */
export function aggregate(date: string, records: readonly ProcessingRecord[]): DailyStats {
  let drafted = 0;
  let review = 0;
  let noReply = 0;
  let errors = 0;
  let important = 0;
  let injectionSuspected = 0;
  let anyDraftId = false;

  for (const r of records) {
    switch (r.classification) {
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
    if (r.error !== '') errors += 1;
    if (r.important) important += 1;
    if (r.injectionSuspected) injectionSuspected += 1;
    if (r.draftId !== '') anyDraftId = true;
  }

  return {
    date,
    examined: records.length,
    drafted,
    review,
    noReply,
    errors,
    important,
    injectionSuspected,
    // 下書き ID が1つも無ければドライラン（または該当なし）だったと見なす
    dryRunOnly: !anyDraftId,
  };
}

/** 通知用テキスト。個人情報は含めない（件数のみ）。 */
export function formatSummary(stats: DailyStats, config: Config): string {
  const lines = [
    `🗂 メール返信下書きアシスタント 日次集計 ${stats.date}`,
    `対象アカウント: ${config.targetEmail}`,
    '',
    `確認したメール数: ${stats.examined}`,
    `返信下書きを作成: ${stats.drafted}`,
    `要確認: ${stats.review}`,
    `返信不要: ${stats.noReply}`,
    `エラー: ${stats.errors}`,
  ];
  if (stats.important > 0) lines.push(`重要メール（請求・契約・セキュリティ等）: ${stats.important}`);
  if (stats.injectionSuspected > 0) {
    lines.push(`プロンプトインジェクションの疑い: ${stats.injectionSuspected}`);
  }
  if (config.dryRun) {
    lines.push('', '※ ドライラン中です。Gmail への下書き作成・ラベル付与は行っていません。');
  } else if (stats.dryRunOnly && stats.drafted > 0) {
    lines.push('', '※ 下書き作成が0件でした。ラベル・権限設定を確認してください。');
  }
  return lines.join('\n');
}
