import { describe, expect, it } from 'vitest';
import {
  base64Encode,
  base64EncodeUtf8,
  base64UrlEncodeUtf8,
  encodeWord,
  isAscii,
  utf8Bytes,
  wrapBase64,
} from '../src/mail/encoding.js';
import {
  buildReferences,
  buildReplyMime,
  formatAddress,
  formatAddressList,
  replySubject,
} from '../src/mail/mime.js';
import { hasDeliverableRecipient, resolveReplyRecipients } from '../src/mail/recipients.js';
import {
  buildDomainHistoryQuery,
  buildInboxQuery,
  buildSenderHistoryQuery,
  buildSentSimilarQuery,
  subjectKeywords,
} from '../src/mail/query.js';
import { buildStyleProfile, detectSignature, removeSignature, resolveSignature } from '../src/mail/style.js';
import { addr, makeConfig, makeMessage, makeThread, TARGET } from './fakes.js';

/** 参照実装（Node の Buffer）と突き合わせる。 */
function nodeBase64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

describe('encoding', () => {
  it('UTF-8 バイト列が Buffer と一致する', () => {
    for (const s of ['abc', 'こんにちは', '𝕏 絵文字😀', 'ü', '']) {
      expect(utf8Bytes(s)).toEqual(Array.from(Buffer.from(s, 'utf8')));
    }
  });

  it('Base64 が Buffer と一致する', () => {
    for (const s of ['a', 'ab', 'abc', 'abcd', 'お世話になっております。', '😀😀']) {
      expect(base64EncodeUtf8(s)).toBe(nodeBase64(s));
    }
  });

  it('空文字は空 Base64', () => {
    expect(base64Encode([])).toBe('');
  });

  it('URL セーフ Base64 はパディングを落とす', () => {
    const encoded = base64UrlEncodeUtf8('こんにちは世界');
    expect(encoded).not.toContain('=');
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    // 復元できることを確認
    const restored = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8',
    );
    expect(restored).toBe('こんにちは世界');
  });

  it('76桁で折り返す', () => {
    const wrapped = wrapBase64('x'.repeat(200));
    for (const line of wrapped.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('ASCII 判定', () => {
    expect(isAscii('Hello World')).toBe(true);
    expect(isAscii('こんにちは')).toBe(false);
  });

  it('ASCII はそのまま、日本語は encoded-word にする', () => {
    expect(encodeWord('Meeting request')).toBe('Meeting request');
    const encoded = encodeWord('打ち合わせのご相談');
    expect(encoded.startsWith('=?UTF-8?B?')).toBe(true);
    expect(encoded.endsWith('?=')).toBe(true);
  });

  it('長い日本語の encoded-word は 75 バイト以内に分割する', () => {
    const encoded = encodeWord('非常に長い日本語の件名'.repeat(10));
    for (const chunk of encoded.split('\r\n ')) {
      expect(chunk.length).toBeLessThanOrEqual(75);
      expect(chunk.startsWith('=?UTF-8?B?')).toBe(true);
    }
    // 分割しても全体を復元できる
    const decoded = encoded
      .split('\r\n ')
      .map((c) => {
        const payload = c.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, '');
        return Buffer.from(payload, 'base64');
      });
    expect(Buffer.concat(decoded).toString('utf8')).toBe('非常に長い日本語の件名'.repeat(10));
  });
});

describe('mime', () => {
  it('Re: を1つだけ付ける', () => {
    expect(replySubject('お問い合わせ')).toBe('Re: お問い合わせ');
    expect(replySubject('Re: お問い合わせ')).toBe('Re: お問い合わせ');
    expect(replySubject('RE: お問い合わせ')).toBe('RE: お問い合わせ');
    expect(replySubject('Re[2]: お問い合わせ')).toBe('Re[2]: お問い合わせ');
    expect(replySubject('   ')).toBe('Re:');
  });

  it('アドレスを整形する', () => {
    expect(formatAddress(addr('a@b.com'))).toBe('a@b.com');
    expect(formatAddress(addr('a@b.com', 'Taro'))).toBe('Taro <a@b.com>');
    expect(formatAddress(addr('a@b.com', 'Yamada, Taro'))).toBe('"Yamada, Taro" <a@b.com>');
    expect(formatAddress(addr('a@b.com', '山田太郎'))).toContain('=?UTF-8?B?');
    expect(formatAddressList([addr('a@b.com'), addr('c@d.com')])).toBe('a@b.com, c@d.com');
  });

  it('References を組み立てて重複を除く', () => {
    expect(buildReferences('<a@x> <b@x>', '<c@x>')).toBe('<a@x> <b@x> <c@x>');
    expect(buildReferences('<a@x>', '<a@x>')).toBe('<a@x>');
    expect(buildReferences('', '<c@x>')).toBe('<c@x>');
    expect(buildReferences('ゴミ', '<c@x>')).toBe('<c@x>');
  });

  it('References が長すぎる場合は先頭と直近を残す', () => {
    const many = Array.from({ length: 40 }, (_, i) => `<m${i}@x>`).join(' ');
    const result = buildReferences(many, '<last@x>');
    const parts = result.split(' ');
    expect(parts.length).toBe(20);
    expect(parts[0]).toBe('<m0@x>');
    expect(parts[parts.length - 1]).toBe('<last@x>');
  });

  it('返信 MIME を組み立てる', () => {
    const raw = buildReplyMime({
      to: [addr('taro@example.com', '山田太郎')],
      cc: [],
      originalSubject: '見積のご相談',
      body: 'お世話になっております。\n承知しました。',
      inReplyTo: '<orig@example.com>',
      references: '<older@example.com>',
      signature: '三陸テック 佐藤光彦',
      notice: '',
    });

    expect(raw).toContain('To: =?UTF-8?B?');
    expect(raw).toContain('<taro@example.com>');
    expect(raw).toContain('In-Reply-To: <orig@example.com>');
    expect(raw).toContain('References: <older@example.com> <orig@example.com>');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Transfer-Encoding: base64');
    // From は付けない（Gmail の既定 sendAs を尊重する）
    expect(raw).not.toContain('\r\nFrom:');
    // Cc は空なので出さない
    expect(raw).not.toContain('Cc:');

    const [headerPart, bodyPart] = raw.split('\r\n\r\n');
    expect(headerPart).toBeDefined();
    const decoded = Buffer.from((bodyPart ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(decoded).toContain('承知しました。');
    expect(decoded).toContain('三陸テック 佐藤光彦');
  });

  it('Cc があれば Cc ヘッダを出す', () => {
    const raw = buildReplyMime({
      to: [addr('a@b.com')],
      cc: [addr('c@d.com')],
      originalSubject: 'test',
      body: 'body',
      inReplyTo: '',
      references: '',
      signature: '',
      notice: '',
    });
    expect(raw).toContain('Cc: c@d.com');
    // In-Reply-To が空なら References も出さない
    expect(raw).not.toContain('In-Reply-To');
    expect(raw).not.toContain('References');
  });

  it('確認用の注記を先頭に入れる', () => {
    const raw = buildReplyMime({
      to: [addr('a@b.com')],
      cc: [],
      originalSubject: 'test',
      body: '本文です。',
      inReplyTo: '',
      references: '',
      signature: '',
      notice: '【AI判定：要確認】理由はこちら',
    });
    const bodyPart = raw.split('\r\n\r\n')[1] ?? '';
    const decoded = Buffer.from(bodyPart.replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(decoded.startsWith('【AI判定：要確認】')).toBe(true);
    expect(decoded).toContain('本文です。');
  });

  it('本文の改行を CRLF にする', () => {
    const raw = buildReplyMime({
      to: [addr('a@b.com')],
      cc: [],
      originalSubject: 't',
      body: 'line1\nline2',
      inReplyTo: '',
      references: '',
      signature: '',
      notice: '',
    });
    const bodyPart = raw.split('\r\n\r\n')[1] ?? '';
    const decoded = Buffer.from(bodyPart.replace(/\r\n/g, ''), 'base64').toString('utf8');
    expect(decoded).toBe('line1\r\nline2');
  });
});

describe('recipients', () => {
  const config = makeConfig();

  it('既定では From へ返し Cc は付けない', () => {
    const message = makeMessage({
      from: addr('taro@example.com', '山田'),
      cc: [addr('colleague@example.com'), addr('boss@sanrikutech.jp')],
    });
    const r = resolveReplyRecipients(message, null, config);
    expect(r.to.map((a) => a.email)).toEqual(['taro@example.com']);
    expect(r.cc).toEqual([]);
    expect(hasDeliverableRecipient(r)).toBe(true);
  });

  it('Reply-To があればそちらを優先する', () => {
    const message = makeMessage({
      from: addr('noreply-sender@example.com'),
      replyTo: [addr('support@example.com')],
    });
    const r = resolveReplyRecipients(message, null, config);
    expect(r.to.map((a) => a.email)).toEqual(['support@example.com']);
    expect(r.notes).toContain('to=reply-to');
  });

  it('Reply-To が複数でも先頭1件に絞る', () => {
    const message = makeMessage({
      replyTo: [addr('a@example.com'), addr('b@example.com')],
    });
    const r = resolveReplyRecipients(message, null, config);
    expect(r.to.length).toBe(1);
    expect(r.notes).toContain('reply-to-truncated');
  });

  it('自分自身は宛先にしない', () => {
    const message = makeMessage({ from: addr(TARGET) });
    const r = resolveReplyRecipients(message, null, config);
    expect(r.to).toEqual([]);
    expect(hasDeliverableRecipient(r)).toBe(false);
  });

  it('no-reply アドレスは宛先にしない', () => {
    const message = makeMessage({ from: addr('no-reply@example.com') });
    const r = resolveReplyRecipients(message, null, config);
    expect(r.to).toEqual([]);
  });

  it('壊れたアドレスは宛先にしない（To が空の下書きを作らない）', () => {
    for (const broken of ['', 'noatsign', '@example.com', 'user@']) {
      const r = resolveReplyRecipients(makeMessage({ from: addr(broken) }), null, config);
      expect(r.to, broken).toEqual([]);
      expect(hasDeliverableRecipient(r), broken).toBe(false);
    }
  });

  it('mirror-previous でも前例が無ければ Cc は空', () => {
    const mirror = makeConfig({ CC_MODE: 'mirror-previous' });
    const message = makeMessage({ cc: [addr('x@example.com')] });
    const r = resolveReplyRecipients(message, null, mirror);
    expect(r.cc).toEqual([]);
    expect(r.notes).toContain('cc=none(no-precedent)');
  });

  it('mirror-previous は佐藤が過去に Cc した相手だけ引き継ぐ', () => {
    const mirror = makeConfig({ CC_MODE: 'mirror-previous' });
    const past = makeMessage({
      id: 'past',
      from: addr(TARGET),
      labelIds: ['SENT'],
      cc: [addr('known@example.com')],
      receivedAt: Date.UTC(2026, 6, 29, 1, 0),
    });
    const incoming = makeMessage({
      id: 'now',
      threadId: 'thread-x',
      cc: [addr('known@example.com'), addr('stranger@example.com')],
    });
    const thread = makeThread([past, incoming], 'thread-x');
    const r = resolveReplyRecipients(incoming, thread, mirror);
    expect(r.cc.map((a) => a.email)).toEqual(['known@example.com']);
  });

  it('メーリングリストのアドレスは宛先にしない', () => {
    const message = makeMessage({
      from: addr('list@groups.example.com'),
      headers: { 'list-post': '<mailto:list@groups.example.com>' },
    });
    const thread = makeThread([message], message.threadId);
    const r = resolveReplyRecipients(message, thread, config);
    expect(r.to).toEqual([]);
  });
});

describe('query', () => {
  it('受信トレイのクエリに安全な除外条件が入る', () => {
    const q = buildInboxQuery(makeConfig(), 1_700_000_000);
    expect(q).toContain('in:inbox');
    expect(q).toContain('-from:me');
    expect(q).toContain('-in:trash');
    expect(q).toContain('-in:spam');
    expect(q).toContain('after:1700000000');
    expect(q).toContain('-label:"AI処理済み"');
    expect(q).toContain('-label:"AI処理エラー"');
  });

  it('テストモードではラベルと送信者で絞る', () => {
    const q = buildInboxQuery(
      makeConfig({ TEST_MODE: 'true', TEST_SENDERS: 'a@example.com,b@example.com' }),
      0,
    );
    expect(q).toContain('label:"AIテスト対象"');
    expect(q).toContain('(from:a@example.com OR from:b@example.com)');
  });

  it('過去メール検索クエリ', () => {
    expect(buildSenderHistoryQuery('a@b.com', 100)).toContain('(from:a@b.com OR to:a@b.com)');
    expect(buildDomainHistoryQuery('b.com', 100)).toContain('(from:@b.com OR to:@b.com)');
    expect(buildSentSimilarQuery(['見積'], 100)).toContain('in:sent');
    expect(buildSentSimilarQuery(['見積'], 100)).toContain('subject:"見積"');
    // キーワードが無ければ subject 条件を付けない
    expect(buildSentSimilarQuery([], 100)).not.toContain('subject:');
  });

  it('件名からキーワードを抽出する', () => {
    expect(subjectKeywords('Re: 【重要】見積書の送付について')).toEqual([
      '重要',
      '見積書の送付について',
    ]);
    expect(subjectKeywords('Re: Fwd: 返信')).toEqual([]);
    // 重複を除き、上限件数で打ち切る（1文字語はノイズとして捨てる）
    expect(subjectKeywords('aa bb aa bb cc dd', 3)).toEqual(['aa', 'bb', 'cc']);
    expect(subjectKeywords('a b c')).toEqual([]);
  });
});

describe('style', () => {
  const sent = [
    '山田様\n\nお世話になっております。三陸テックの佐藤です。\n承知しました。\nよろしくお願いします。\n\n--\n三陸テック株式会社\n佐藤光彦\nsato@sanrikutech.jp',
    '鈴木様\n\nお世話になっております。三陸テックの佐藤です。\n下記の通り対応します。\nよろしくお願いします。\n\n--\n三陸テック株式会社\n佐藤光彦\nsato@sanrikutech.jp',
  ];

  it('共通末尾から署名を検出する', () => {
    const signature = detectSignature(sent);
    expect(signature).toContain('三陸テック株式会社');
    expect(signature).toContain('佐藤光彦');
  });

  it('1通だけでは署名を推定しない', () => {
    expect(detectSignature([sent[0] as string])).toBe('');
  });

  it('共通末尾が1行だけなら署名としない', () => {
    const bodies = ['本文A\nよろしくお願いします。', '本文B\nよろしくお願いします。'];
    expect(detectSignature(bodies)).toBe('');
  });

  it('署名を本文から取り除く', () => {
    expect(removeSignature('本文\n\n署名です', '署名です')).toBe('本文');
    expect(removeSignature('本文', '')).toBe('本文');
  });

  it('文体プロファイルを作る', () => {
    const profile = buildStyleProfile(sent);
    expect(profile.sampleCount).toBe(2);
    expect(profile.salutations).toContain('〇〇様');
    expect(profile.greetings.some((g) => g.includes('お世話になっております'))).toBe(true);
    expect(profile.closings.some((c) => c.includes('よろしくお願いします'))).toBe(true);
    expect(profile.signature).toContain('三陸テック');
    expect(profile.averageBodyLength).toBeGreaterThan(0);
  });

  it('相手の実名は文体プロファイルに残さない', () => {
    const profile = buildStyleProfile(sent);
    expect(profile.salutations.join()).not.toContain('山田');
    expect(profile.salutations.join()).not.toContain('鈴木');
  });

  it('送信メールが無ければ空のプロファイル', () => {
    const profile = buildStyleProfile([]);
    expect(profile.sampleCount).toBe(0);
    expect(profile.signature).toBe('');
    expect(profile.politeness).toBe('standard');
  });

  it('敬語レベルを推定する', () => {
    const formal = buildStyleProfile([
      '何卒よろしくお願い申し上げます。恐れ入りますがご確認賜りますようお願い申し上げます。',
      '恐れ入ります。何卒よろしくお願い申し上げます。存じております。',
    ]);
    expect(formal.politeness).toBe('formal');
  });

  it('署名は設定値を優先する', () => {
    const profile = buildStyleProfile(sent);
    expect(resolveSignature('設定した署名', profile)).toBe('設定した署名');
    expect(resolveSignature('', profile)).toContain('三陸テック');
  });
});
