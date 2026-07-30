import { describe, expect, it } from 'vitest';
import { decodeEntities, htmlToText, looksLikeHtml, toPlainText } from '../src/text/html.js';
import {
  sanitizeBody,
  sanitizeSentBody,
  stripDisclaimers,
  stripQuotedHistory,
  stripSignatureBlock,
} from '../src/text/sanitize.js';
import { domainOf, maskEmail, reasonCode, redactPii, subjectExcerpt } from '../src/text/redact.js';

describe('html', () => {
  it('エンティティを復号する', () => {
    expect(decodeEntities('a&amp;b&lt;c&gt;d&nbsp;e')).toBe('a&b<c>d e');
    expect(decodeEntities('&#x3053;&#12435;')).toBe('こん');
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  it('HTML を判定する', () => {
    expect(looksLikeHtml('<div>hello</div>')).toBe(true);
    expect(looksLikeHtml('普通のテキストです。')).toBe(false);
  });

  it('HTML メールをテキスト化する', () => {
    const html = `<html><head><style>.x{color:red}</style></head><body>
      <div>お世話になっております。</div><br/>
      <p>ご確認をお願いします。</p>
      <script>alert(1)</script>
      <table><tr><td>項目</td><td>値</td></tr></table>
    </body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('お世話になっております。');
    expect(text).toContain('ご確認をお願いします。');
    expect(text).not.toContain('color:red');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('<');
  });

  it('URL は落とす（自動アクセスしない方針）', () => {
    expect(toPlainText('詳細は https://example.com/a?b=c を見てください')).toContain('[リンク]');
    expect(toPlainText('詳細は https://example.com/a?b=c を見てください')).not.toContain('example.com');
  });

  it('過剰な空行を畳む', () => {
    expect(toPlainText('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('sanitize', () => {
  it('引用マーカー以降を落とす', () => {
    const body = [
      'ご確認ありがとうございます。',
      '',
      '2026年7月29日(水) 15:00 山田太郎 のメッセージ:',
      '> 先日の件ですが',
      '> いかがでしょうか',
    ].join('\n');
    const r = stripQuotedHistory(body);
    expect(r.stripped).toBe(true);
    expect(r.text).toBe('ご確認ありがとうございます。');
  });

  it('Original Message 形式の引用を落とす', () => {
    const body = 'まずは結論です。\n\n-----Original Message-----\nFrom: someone\n本文';
    expect(stripQuotedHistory(body).text).toBe('まずは結論です。');
  });

  it('> が3行以上続く塊を引用と見なす', () => {
    const body = 'ご返信します。\n> a\n> b\n> c\n> d';
    expect(stripQuotedHistory(body).text).toBe('ご返信します。');
  });

  it('単発の > 行は行単位で除去する', () => {
    const r = stripQuotedHistory('本文です。\n> 引用1行だけ\n続きます。');
    expect(r.text).toBe('本文です。\n続きます。');
    expect(r.stripped).toBe(true);
  });

  it('免責文以降を落とす', () => {
    const body = '本題です。\n\n本メールに含まれる情報は機密です。転載を禁じます。';
    expect(stripDisclaimers(body)).toBe('本題です。');
  });

  it('英語の免責文も落とす', () => {
    const body = 'Please confirm.\n\nThis email and any files transmitted are confidential.';
    expect(stripDisclaimers(body)).toBe('Please confirm.');
  });

  it('署名区切り以降を落とす', () => {
    const body = 'ご確認ください。\nよろしくお願いします。\n\n--\n株式会社サンプル\n山田太郎';
    expect(stripSignatureBlock(body)).toBe('ご確認ください。\nよろしくお願いします。');
  });

  it('冒頭すぎる区切りは本文の飾りとして残す', () => {
    const body = '---\n重要なお知らせ\n本文が続きます。';
    expect(stripSignatureBlock(body)).toContain('重要なお知らせ');
  });

  it('長い引用履歴付きメールを圧縮する', () => {
    const quoted = Array.from({ length: 200 }, (_, i) => `> 過去のやり取り ${i}`).join('\n');
    const body = `結論から申し上げます。可能です。\n\n${quoted}`;
    const r = sanitizeBody(body, { maxChars: 4000 });
    expect(r.quotesStripped).toBe(true);
    expect(r.text).toBe('結論から申し上げます。可能です。');
  });

  it('最大文字数で切り捨てる', () => {
    const r = sanitizeBody('あ'.repeat(500), { maxChars: 100 });
    expect(r.truncated).toBe(true);
    expect(r.text).toContain('（以下省略）');
    expect(r.text.length).toBeLessThan(150);
  });

  it('HTML メールも整形できる', () => {
    const r = sanitizeBody('<div>ご確認ください。</div><div>よろしくお願いします。</div>', {
      maxChars: 1000,
    });
    expect(r.text).toContain('ご確認ください。');
    expect(r.text).not.toContain('<div>');
  });

  it('送信メールは署名を残したまま引用だけ落とす', () => {
    const body = '承知しました。\n\n--\n三陸テック 佐藤\n\n> 元のメール';
    const r = sanitizeSentBody(body, 1000);
    expect(r).toContain('三陸テック 佐藤');
    expect(r).not.toContain('元のメール');
  });
});

describe('redact', () => {
  it('ドメインを取り出す', () => {
    expect(domainOf('Taro@Example.CO.JP')).toBe('example.co.jp');
    expect(domainOf('broken')).toBe('');
  });

  it('メールアドレスを伏せる', () => {
    expect(maskEmail('sato@sanrikutech.jp')).toBe('s***@sanrikutech.jp');
  });

  it('本文中の個人情報を伏せる', () => {
    const r = redactPii('連絡先は taro.yamada@example.com、電話は 090-1234-5678 です');
    expect(r).not.toContain('taro.yamada');
    expect(r).toContain('t***@example.com');
    expect(r).toContain('[電話番号]');
  });

  it('件名を抜粋する', () => {
    expect(subjectExcerpt('短い件名')).toBe('短い件名');
    expect(subjectExcerpt('あ'.repeat(100)).endsWith('…')).toBe(true);
    expect(subjectExcerpt('あ'.repeat(100)).length).toBe(41);
  });

  it('理由コードから個人情報を除く', () => {
    expect(reasonCode('taro@example.com からの依頼')).toContain('t***@example.com');
  });
});
