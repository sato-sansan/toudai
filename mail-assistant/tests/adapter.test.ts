/**
 * GAS アダプタのうち、純粋なパース処理のテスト。
 *
 * Utilities（GAS グローバル）は最小限のスタブで差し替える。
 * MIME のパースは壊れると「本文が空のまま AI に渡る」「宛先を取り違える」に直結するため、
 * GAS を使わずに固定しておく価値が高い。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  extractParts,
  headersToRecord,
  parseAddressList,
  toMailMessage,
} from '../src/gas/gmailAdapter.js';
import { extractText } from '../src/gas/geminiAdapter.js';

/** base64url 文字列を Gmail API のペイロード形式で作る。 */
function b64url(text: string): string {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Utilities は @types/google-apps-script がグローバル宣言しているので、
 * 型を上書き宣言せず、必要なメソッドだけを持つスタブを差し込む。
 */
const utilitiesStub = {
  base64DecodeWebSafe(data: string): number[] {
    return Array.from(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  },
  newBlob(bytes: number[] | string) {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
    return {
      getDataAsString: () => buf.toString('utf8'),
      getBytes: () => Array.from(buf),
    };
  },
};

type GlobalWithUtilities = { Utilities?: unknown };

beforeAll(() => {
  (globalThis as GlobalWithUtilities).Utilities = utilitiesStub;
});

afterAll(() => {
  delete (globalThis as GlobalWithUtilities).Utilities;
});

describe('parseAddressList', () => {
  it('単一アドレス', () => {
    expect(parseAddressList('taro@example.com')).toEqual([{ name: '', email: 'taro@example.com' }]);
  });

  it('表示名付き', () => {
    expect(parseAddressList('Taro Yamada <taro@example.com>')).toEqual([
      { name: 'Taro Yamada', email: 'taro@example.com' },
    ]);
  });

  it('複数アドレス', () => {
    expect(parseAddressList('a@x.com, B <b@x.com>')).toEqual([
      { name: '', email: 'a@x.com' },
      { name: 'B', email: 'b@x.com' },
    ]);
  });

  it('引用符内のカンマで分割しない', () => {
    expect(parseAddressList('"Yamada, Taro" <taro@example.com>, b@x.com')).toEqual([
      { name: 'Yamada, Taro', email: 'taro@example.com' },
      { name: '', email: 'b@x.com' },
    ]);
  });

  it('アドレスを小文字化する', () => {
    expect(parseAddressList('Taro@Example.COM')[0]?.email).toBe('taro@example.com');
  });

  it('@ を含まない要素は捨てる', () => {
    expect(parseAddressList('undisclosed-recipients:;')).toEqual([]);
  });

  it('未定義・空文字は空配列', () => {
    expect(parseAddressList(undefined)).toEqual([]);
    expect(parseAddressList('   ')).toEqual([]);
  });
});

describe('headersToRecord', () => {
  it('小文字キーの辞書にする', () => {
    expect(
      headersToRecord([
        { name: 'From', value: 'a@x.com' },
        { name: 'SUBJECT', value: 'テスト' },
      ]),
    ).toEqual({ from: 'a@x.com', subject: 'テスト' });
  });

  it('同名ヘッダは最初の値を採る', () => {
    expect(
      headersToRecord([
        { name: 'Received', value: 'first' },
        { name: 'Received', value: 'second' },
      ]),
    ).toEqual({ received: 'first' });
  });

  it('未定義は空辞書', () => {
    expect(headersToRecord(undefined)).toEqual({});
  });
});

describe('extractParts', () => {
  it('単一の text/plain を取り出す', () => {
    const result = extractParts({
      mimeType: 'text/plain',
      body: { data: b64url('本文です') },
    });
    expect(result.plain).toBe('本文です');
    expect(result.attachmentNames).toEqual([]);
  });

  it('multipart/alternative から text/plain を優先して取れる', () => {
    const result = extractParts({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('プレーン本文') } },
        { mimeType: 'text/html', body: { data: b64url('<div>HTML本文</div>') } },
      ],
    });
    expect(result.plain).toBe('プレーン本文');
    expect(result.html).toBe('<div>HTML本文</div>');
  });

  it('入れ子の multipart を再帰的に辿る', () => {
    const result = extractParts({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: b64url('深い本文') } }],
        },
        { mimeType: 'application/pdf', filename: '見積書.pdf', body: { attachmentId: 'a1' } },
      ],
    });
    expect(result.plain).toBe('深い本文');
    expect(result.attachmentNames).toEqual(['見積書.pdf']);
  });

  it('添付ファイル名を集める（中身は取らない）', () => {
    const result = extractParts({
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: b64url('本文') } },
        { mimeType: 'application/pdf', filename: 'a.pdf' },
        { mimeType: 'application/vnd.ms-excel', filename: 'b.xlsx' },
      ],
    });
    expect(result.attachmentNames).toEqual(['a.pdf', 'b.xlsx']);
  });

  it('undefined でも落ちない', () => {
    expect(extractParts(undefined).plain).toBe('');
  });

  it('壊れた base64 でも落ちない', () => {
    const result = extractParts({ mimeType: 'text/plain', body: { data: '!!!not-base64!!!' } });
    expect(typeof result.plain).toBe('string');
  });
});

describe('toMailMessage', () => {
  it('Gmail API のメッセージを正規化する', () => {
    const message = toMailMessage({
      id: 'm1',
      threadId: 't1',
      internalDate: '1785000000000',
      labelIds: ['INBOX', 'UNREAD'],
      payload: {
        headers: [
          { name: 'From', value: '山田太郎 <taro@example.com>' },
          { name: 'To', value: 'sato@sanrikutech.jp' },
          { name: 'Cc', value: 'boss@sanrikutech.jp' },
          { name: 'Reply-To', value: 'support@example.com' },
          { name: 'Subject', value: 'お問い合わせ' },
          { name: 'Message-ID', value: '<abc@example.com>' },
          { name: 'List-Id', value: '<list.example.com>' },
        ],
        mimeType: 'text/plain',
        body: { data: b64url('本文テキスト') },
      },
    });

    expect(message.id).toBe('m1');
    expect(message.threadId).toBe('t1');
    expect(message.from).toEqual({ name: '山田太郎', email: 'taro@example.com' });
    expect(message.to.map((a) => a.email)).toEqual(['sato@sanrikutech.jp']);
    expect(message.cc.map((a) => a.email)).toEqual(['boss@sanrikutech.jp']);
    expect(message.replyTo.map((a) => a.email)).toEqual(['support@example.com']);
    expect(message.subject).toBe('お問い合わせ');
    expect(message.receivedAt).toBe(1785000000000);
    expect(message.body).toBe('本文テキスト');
    expect(message.labelIds).toEqual(['INBOX', 'UNREAD']);
    expect(message.headers['message-id']).toBe('<abc@example.com>');
    expect(message.headers['list-id']).toBe('<list.example.com>');
  });

  it('HTML のみのメールはテキスト化する', () => {
    const message = toMailMessage({
      id: 'm2',
      threadId: 't2',
      internalDate: '1785000000000',
      payload: {
        mimeType: 'text/html',
        body: { data: b64url('<div>HTMLだけの本文</div>') },
        headers: [{ name: 'Subject', value: 'html' }],
      },
    });
    expect(message.body).toBe('HTMLだけの本文');
  });

  it('欠損フィールドがあっても落ちない', () => {
    const message = toMailMessage({});
    expect(message.id).toBe('');
    expect(message.from).toEqual({ name: '', email: '' });
    expect(message.subject).toBe('');
    expect(message.body).toBe('');
    expect(typeof message.receivedAt).toBe('number');
  });
});

describe('gemini extractText', () => {
  it('候補からテキストを連結する', () => {
    const body = JSON.stringify({
      candidates: [{ content: { parts: [{ text: '{"a":' }, { text: '1}' }] } }],
    });
    expect(extractText(body)).toBe('{"a":1}');
  });

  it('候補が無ければ空文字', () => {
    expect(extractText(JSON.stringify({}))).toBe('');
    expect(extractText(JSON.stringify({ candidates: [] }))).toBe('');
    expect(extractText(JSON.stringify({ candidates: [{}] }))).toBe('');
  });
});
