import { describe, expect, it } from 'vitest';
import { ConfigError, describeConfig, loadConfig } from '../src/config.js';

describe('config', () => {
  it('既定値は安全側（ドライラン有効）', () => {
    const c = loadConfig({});
    expect(c.dryRun).toBe(true);
    expect(c.testMode).toBe(false);
    expect(c.reviewCreatesDraft).toBe(false);
    expect(c.ccMode).toBe('none');
    expect(c.summaryChannel).toBe('log');
    expect(c.targetEmail).toBe('sato@sanrikutech.jp');
    expect(c.timezone).toBe('Asia/Tokyo');
    expect(c.timezoneOffsetMinutes).toBe(540);
    expect(c.workStartHour).toBe(8);
    expect(c.workEndHour).toBe(18);
    expect(c.runIntervalMinutes).toBe(10);
    expect(c.weekdaysOnly).toBe(true);
    expect(c.skipJapaneseHolidays).toBe(true);
    expect(c.historyLookbackMonths).toBe(12);
    expect(c.confidenceReplyThreshold).toBe(0.85);
    expect(c.confidenceReviewThreshold).toBe(0.6);
    expect(c.geminiModel).toBe('gemini-2.5-flash');
    expect(c.geminiThinkingBudget).toBe(0);
  });

  it('DRY_RUN は明示的に false と書いたときだけ解除される', () => {
    expect(loadConfig({ DRY_RUN: 'false' }).dryRun).toBe(false);
    expect(loadConfig({ DRY_RUN: '' }).dryRun).toBe(true);
    expect(loadConfig({}).dryRun).toBe(true);
  });

  it('真偽値の表記ゆれを受け付ける', () => {
    expect(loadConfig({ TEST_MODE: 'TRUE' }).testMode).toBe(true);
    expect(loadConfig({ TEST_MODE: '1' }).testMode).toBe(true);
    expect(loadConfig({ TEST_MODE: 'on' }).testMode).toBe(true);
    expect(loadConfig({ TEST_MODE: 'no' }).testMode).toBe(false);
  });

  it('不正な真偽値は例外', () => {
    expect(() => loadConfig({ DRY_RUN: 'maybe' })).toThrow(ConfigError);
  });

  it('未対応のタイムゾーンは例外', () => {
    expect(() => loadConfig({ TIMEZONE: 'America/New_York' })).toThrow(ConfigError);
    expect(loadConfig({ TIMEZONE: 'UTC' }).timezoneOffsetMinutes).toBe(0);
  });

  it('稼働時刻の前後関係を検証する', () => {
    expect(() => loadConfig({ WORK_START_HOUR: '18', WORK_END_HOUR: '8' })).toThrow(ConfigError);
    expect(() => loadConfig({ WORK_START_HOUR: '9', WORK_END_HOUR: '9' })).toThrow(ConfigError);
  });

  it('GAS が受け付けない実行間隔は例外', () => {
    expect(() => loadConfig({ RUN_INTERVAL_MINUTES: '7' })).toThrow(ConfigError);
    expect(loadConfig({ RUN_INTERVAL_MINUTES: '15' }).runIntervalMinutes).toBe(15);
    expect(loadConfig({ RUN_INTERVAL_MINUTES: '30' }).runIntervalMinutes).toBe(30);
  });

  it('閾値の前後関係を検証する', () => {
    expect(() =>
      loadConfig({ CONFIDENCE_REPLY_THRESHOLD: '0.5', CONFIDENCE_REVIEW_THRESHOLD: '0.9' }),
    ).toThrow(ConfigError);
  });

  it('閾値の値域を検証する', () => {
    expect(() => loadConfig({ CONFIDENCE_REPLY_THRESHOLD: '1.5' })).toThrow(ConfigError);
    expect(() => loadConfig({ CONFIDENCE_REPLY_THRESHOLD: 'abc' })).toThrow(ConfigError);
  });

  it('EXTRA_HOLIDAYS の形式を検証する', () => {
    expect(loadConfig({ EXTRA_HOLIDAYS: '2026-12-29, 2026-12-30' }).extraHolidays).toEqual([
      '2026-12-29',
      '2026-12-30',
    ]);
    expect(() => loadConfig({ EXTRA_HOLIDAYS: '12/29' })).toThrow(ConfigError);
  });

  it('CC_MODE を検証する', () => {
    expect(loadConfig({ CC_MODE: 'mirror-previous' }).ccMode).toBe('mirror-previous');
    expect(() => loadConfig({ CC_MODE: 'all' })).toThrow(ConfigError);
  });

  it('SUMMARY_CHANNEL を検証する（メール送信は選べない）', () => {
    expect(loadConfig({ SUMMARY_CHANNEL: 'chat' }).summaryChannel).toBe('chat');
    expect(() => loadConfig({ SUMMARY_CHANNEL: 'email' })).toThrow(ConfigError);
  });

  it('TARGET_EMAIL を検証し小文字化する', () => {
    expect(loadConfig({ TARGET_EMAIL: 'Sato@Sanrikutech.JP' }).targetEmail).toBe(
      'sato@sanrikutech.jp',
    );
    expect(() => loadConfig({ TARGET_EMAIL: 'invalid' })).toThrow(ConfigError);
  });

  it('カンマ区切りリストを解釈し空要素を落とす', () => {
    expect(loadConfig({ TEST_SENDERS: 'A@b.com, ,c@d.com,' }).testSenders).toEqual([
      'a@b.com',
      'c@d.com',
    ]);
  });

  it('ラベル名を上書きできる', () => {
    const c = loadConfig({ LABEL_DRAFT: '独自ラベル', LABEL_IMPORTANT: '重要' });
    expect(c.labelDraft).toBe('独自ラベル');
    expect(c.labelImportant).toBe('重要');
    expect(c.labelReview).toBe('AI要確認');
  });

  it('describeConfig は秘密を伏せる', () => {
    const described = describeConfig(loadConfig({ GEMINI_API_KEY: 'secret-key', CHAT_WEBHOOK_URL: 'https://x' }));
    expect(described['geminiApiKey']).toBe('***set***');
    expect(described['chatWebhookUrl']).toBe('***set***');
    expect(JSON.stringify(described)).not.toContain('secret-key');
  });

  it('describeConfig は未設定の秘密も区別して示す', () => {
    const described = describeConfig(loadConfig({}));
    expect(described['geminiApiKey']).toBe('(未設定)');
  });
});
