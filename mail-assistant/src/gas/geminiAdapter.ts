/**
 * Gemini API アダプタ（UrlFetchApp）。
 *
 * 灯台（scripts/summarize.py）で得た知見をそのまま踏襲する:
 *   - thinkingBudget: 0 を必ず入れる（2.5 系は既定で思考にトークンを使い JSON が途中で切れる）
 *   - responseMimeType: application/json で JSON を強制する
 *   - 429 は指数バックオフで再試行し、それ以外の HTTP エラーは即座に投げる
 */
import type { Config } from '../config.js';
import type { AiPort, LoggerPort } from '../ports.js';

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const RETRY_DELAYS_MS = [8000, 16000];

export class GeminiApiError extends Error {}

export class GasGeminiAdapter implements AiPort {
  readonly modelId: string;

  constructor(
    private readonly config: Config,
    private readonly logger: LoggerPort,
  ) {
    this.modelId = config.geminiModel;
  }

  generate(system: string, user: string): string {
    if (this.config.geminiApiKey === '') {
      // フォールバックで適当な返信を作るのは危険なので、明確に失敗させる。
      throw new GeminiApiError('GEMINI_API_KEY が未設定です');
    }

    const url = `${ENDPOINT_BASE}/${encodeURIComponent(this.config.geminiModel)}:generateContent?key=${encodeURIComponent(
      this.config.geminiApiKey,
    )}`;

    const payload = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: this.config.geminiThinkingBudget },
      },
      // 業務メールが安全フィルタで落ちると判定できなくなるため、閾値は緩める
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    };

    let lastError = '';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      const response = UrlFetchApp.fetch(url, {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true,
      });
      const code = response.getResponseCode();
      const text = response.getContentText();

      if (code === 200) {
        return extractText(text);
      }
      if (code === 429 || code >= 500) {
        lastError = `HTTP ${code}`;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined) {
          this.logger.warn('Gemini 一時エラー。再試行する', { code, attempt: attempt + 1 });
          Utilities.sleep(delay);
          continue;
        }
      } else {
        // 本文にはプロンプトが echo される可能性があるため、ログには載せない
        throw new GeminiApiError(`Gemini 呼び出し失敗: HTTP ${code}`);
      }
    }
    throw new GeminiApiError(`Gemini 呼び出し失敗（再試行後）: ${lastError}`);
  }
}

/** Gemini のレスポンスから本文テキストを取り出す。 */
export function extractText(responseBody: string): string {
  const parsed = JSON.parse(responseBody) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts = parsed.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}
