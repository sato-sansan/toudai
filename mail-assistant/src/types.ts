/**
 * ドメイン型定義。
 *
 * ここに GAS 依存を持ち込まないこと（テストは Node で走る）。
 * Gmail API のレスポンス形状はアダプタ層（src/gas/）でこの型に正規化する。
 */

/** 返信要否の3区分。 */
export const CLASSIFICATIONS = ['REPLY_REQUIRED', 'NO_REPLY_REQUIRED', 'REVIEW_REQUIRED'] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

/** パイプラインが最終的に実行する副作用。 */
export type Action =
  | 'draft' // 返信下書きを作成する
  | 'review-draft' // 【AI判定：要確認】付きの確認用下書きを作成する
  | 'label-review' // ラベルのみ（要確認）
  | 'label-no-reply' // ラベルのみ（返信不要）
  | 'log-only' // 何も書き込まない（ログのみ）
  | 'error'; // 処理中エラー

export interface EmailAddress {
  /** 表示名。無ければ空文字。 */
  readonly name: string;
  /** 小文字化済みのメールアドレス。 */
  readonly email: string;
}

/** Gmail の1メッセージ。本文はプレーンテキストへ正規化済み。 */
export interface MailMessage {
  readonly id: string;
  readonly threadId: string;
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly cc: readonly EmailAddress[];
  readonly replyTo: readonly EmailAddress[];
  readonly subject: string;
  /** 受信日時（epoch ミリ秒, UTC）。 */
  readonly receivedAt: number;
  /** 本文（text/plain 優先、無ければ HTML から抽出）。未整形。 */
  readonly body: string;
  /** Gmail のラベル ID 一覧（DRAFT / SENT / INBOX など）。 */
  readonly labelIds: readonly string[];
  readonly attachmentNames: readonly string[];
  /** 判定に使う生ヘッダ（小文字キー）。本文は含めない。 */
  readonly headers: Readonly<Record<string, string>>;
}

/** スレッド1本。messages は古い順。 */
export interface MailThread {
  readonly id: string;
  readonly messages: readonly MailMessage[];
}

/** AI が返す構造化結果（プロンプト契約）。 */
export interface AiResult {
  readonly classification: Classification;
  readonly confidence: number;
  readonly reason: string;
  readonly language: string;
  readonly draftSubject: string;
  readonly draftBody: string;
  readonly missingInformation: readonly string[];
  readonly riskFlags: readonly string[];
}

/** 佐藤の文体プロファイル（過去の送信メールから推定）。 */
export interface StyleProfile {
  /** 冒頭の挨拶の実例（最大数件）。 */
  readonly greetings: readonly string[];
  /** 相手の呼び方の実例（例: "〇〇様"）。 */
  readonly salutations: readonly string[];
  /** 締めの表現の実例。 */
  readonly closings: readonly string[];
  /** 署名ブロック（送信メールの共通末尾から推定）。 */
  readonly signature: string;
  /** 本文の平均文字数（署名・引用除去後）。 */
  readonly averageBodyLength: number;
  /** 推定した敬語レベル。 */
  readonly politeness: 'formal' | 'standard' | 'casual';
  /** 参考にした送信メール件数。 */
  readonly sampleCount: number;
}

/** 1メッセージの処理結果（履歴に保存する形。本文・氏名・アドレス局所部は含めない）。 */
export interface ProcessingRecord {
  readonly messageId: string;
  readonly threadId: string;
  /** ISO8601 文字列。 */
  readonly receivedAt: string;
  readonly processedAt: string;
  readonly classification: Classification;
  readonly confidence: number;
  readonly action: Action;
  /** 作成した下書きの ID。作成しなかった場合は空文字。 */
  readonly draftId: string;
  /** エラー種別（無ければ空文字）。メッセージ本文は入れない。 */
  readonly error: string;
  readonly model: string;
  /** 請求・契約・セキュリティ等の重要メールか（見落とし防止の記録用）。 */
  readonly important: boolean;
  /** プロンプトインジェクションの疑いを検知したか。 */
  readonly injectionSuspected: boolean;
  /** 送信者のドメインのみ（局所部は保存しない）。 */
  readonly senderDomain: string;
  /** ヒューリスティクス/AI の判定理由（短縮済み・PII 除去済み）。 */
  readonly reasonCode: string;
}

/** 1回の実行結果サマリ。 */
export interface RunSummary {
  readonly startedAt: string;
  readonly skippedReason: string;
  readonly examined: number;
  readonly drafted: number;
  readonly review: number;
  readonly noReply: number;
  readonly errors: number;
  readonly dryRun: boolean;
  readonly previews: readonly DecisionPreview[];
}

/** ドライラン時に安全な形で確認するためのプレビュー。 */
export interface DecisionPreview {
  readonly messageId: string;
  readonly threadId: string;
  readonly senderDomain: string;
  /** 件名は先頭のみ。 */
  readonly subjectExcerpt: string;
  readonly classification: Classification;
  readonly confidence: number;
  readonly action: Action;
  readonly reason: string;
  readonly missingInformation: readonly string[];
  readonly riskFlags: readonly string[];
  /** 生成した返信案（受信本文は含めない）。 */
  readonly draftBody: string;
}
