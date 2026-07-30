/**
 * UTF-8 / Base64 の自前実装（純関数）。
 *
 * GAS V8 には TextEncoder / Buffer が無く、Utilities.* は GAS 専用で Node のテストから
 * 呼べない。MIME 組み立ては誤ると宛先が壊れる（＝誤送信リスク）ため、
 * 依存ゼロ・両環境で同一挙動・テスト可能な実装をここに置く。
 */

/** 文字列を UTF-8 バイト列へ。 */
export function utf8Bytes(input: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    // サロゲートペアを1つのコードポイントへ
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000;
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return out;
}

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** バイト列を標準 Base64 へ。 */
export function base64Encode(bytes: readonly number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += B64_CHARS[(triple >> 18) & 0x3f];
    out += B64_CHARS[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? B64_CHARS[(triple >> 6) & 0x3f] : '=';
    out += i + 2 < bytes.length ? B64_CHARS[triple & 0x3f] : '=';
  }
  return out;
}

/** 文字列を UTF-8 Base64 へ。 */
export function base64EncodeUtf8(input: string): string {
  return base64Encode(utf8Bytes(input));
}

/** Gmail API の raw フィールド用（URL セーフ・パディングなし）。 */
export function base64UrlEncodeUtf8(input: string): string {
  return base64EncodeUtf8(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64 を指定桁で折り返す（MIME 本文は 76 桁）。 */
export function wrapBase64(b64: string, width = 76): string {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += width) {
    lines.push(b64.slice(i, i + width));
  }
  return lines.join('\r\n');
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

export function isAscii(input: string): boolean {
  return ASCII_PRINTABLE.test(input);
}

/**
 * RFC 2047 encoded-word。非 ASCII のヘッダ値（日本語の件名・表示名）に使う。
 * 1つの encoded-word は 75 バイト以内という制約があるため分割する。
 */
export function encodeWord(input: string): string {
  if (isAscii(input)) return input;
  // "=?UTF-8?B?" + payload + "?=" が 75 文字以内。payload は base64 なので
  // 元バイト数の 4/3。余裕を見て 1 チャンク 36 バイトに収める。
  const bytes = utf8Bytes(input);
  const chunks: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 36, bytes.length);
    // UTF-8 の途中で切らない（後続バイト 0b10xxxxxx を跨がない）
    while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
    if (end <= start) end = Math.min(start + 36, bytes.length);
    chunks.push(`=?UTF-8?B?${base64Encode(bytes.slice(start, end))}?=`);
    start = end;
  }
  // 複数 encoded-word は FWS（改行＋空白）で連結する
  return chunks.join('\r\n ');
}
