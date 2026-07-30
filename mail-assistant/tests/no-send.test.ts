/**
 * 「自動送信を実装していない」ことをソース走査で機械的に検証する。
 *
 * OAuth スコープには「下書きは作れるが送信はできない」という組み合わせが存在しない
 * （gmail.compose / gmail.modify / mail.google.com はいずれも送信を含む）。
 * したがって送信しない保証はコードレベルで担保する必要があり、
 * その担保をこのテストで固定する。
 *
 * ここが落ちたら、送信 API がコードに入り込んだということ。安易に許可リストへ追加しないこと。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const srcDir = path.join(import.meta.dirname, '..', 'src');

function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** 実装してはならない API のパターン。 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bMailApp\b/, label: 'MailApp（メール送信）' },
  { pattern: /\bGmailApp\b/, label: 'GmailApp（全権スコープを要求）' },
  { pattern: /Messages\s*[.!]*\s*\.?\s*send\b/, label: 'Gmail.Users.Messages.send' },
  { pattern: /Drafts\s*[.!]*\s*\.?\s*send\b/, label: 'Gmail.Users.Drafts.send' },
  { pattern: /\.sendEmail\s*\(/, label: 'sendEmail()' },
  { pattern: /\.send\s*\(/, label: '.send()' },
  { pattern: /sendAsAlias/, label: 'sendAsAlias' },
  // 受信箱を壊す操作
  { pattern: /\.moveToTrash\s*\(/, label: 'moveToTrash()' },
  { pattern: /\.moveToArchive\s*\(/, label: 'moveToArchive()' },
  { pattern: /\.markRead\s*\(/, label: 'markRead()' },
  { pattern: /Messages\s*[.!]*\s*\.?\s*trash\b/, label: 'Gmail.Users.Messages.trash' },
  { pattern: /removeLabelIds/, label: 'removeLabelIds（ラベル剥がし）' },
];

describe('自動送信・破壊的操作を実装していない', () => {
  const files = collectSourceFiles(srcDir);

  it('src/ 配下にソースがある（走査が空振りしていない）', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const { pattern, label } of FORBIDDEN) {
    it(`${label} を参照していない`, () => {
      const offenders: string[] = [];
      for (const file of files) {
        const content = readFileSync(file, 'utf8');
        // コメント行は対象外（方針の説明で API 名に触れているため）
        const codeOnly = content
          .split('\n')
          .filter((line) => {
            const t = line.trim();
            return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
          })
          .join('\n');
        if (pattern.test(codeOnly)) {
          offenders.push(path.relative(srcDir, file));
        }
      }
      expect(offenders, `${label} が ${offenders.join(', ')} に出現した`).toEqual([]);
    });
  }

  it('ポート定義に送信メソッドが無い', () => {
    const ports = readFileSync(path.join(srcDir, 'ports.ts'), 'utf8');
    expect(ports).not.toMatch(/^\s*send/m);
    expect(ports).toContain('createDraft');
  });

  it('OAuth スコープに gmail.send を含まない', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(srcDir, '..', 'appsscript.json'), 'utf8'),
    ) as { oauthScopes: string[] };
    expect(manifest.oauthScopes).not.toContain('https://www.googleapis.com/auth/gmail.send');
    expect(manifest.oauthScopes).not.toContain('https://mail.google.com/');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/gmail.modify');
  });

  it('マニフェストは最小限のスコープのみ', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(srcDir, '..', 'appsscript.json'), 'utf8'),
    ) as { oauthScopes: string[] };
    const allowed = new Set([
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/script.external_request',
      'https://www.googleapis.com/auth/script.scriptapp',
      'https://www.googleapis.com/auth/spreadsheets',
    ]);
    for (const scope of manifest.oauthScopes) {
      expect(allowed.has(scope), `想定外のスコープ: ${scope}`).toBe(true);
    }
  });
});

describe('秘密情報をコミットしていない', () => {
  it('.env.example に実際のキーらしき値が無い', () => {
    const example = readFileSync(path.join(srcDir, '..', '.env.example'), 'utf8');
    // Google API キーの典型的な形（AIza...）が書かれていないこと
    expect(example).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
    expect(example).toMatch(/^GEMINI_API_KEY=$/m);
    expect(example).toMatch(/^CHAT_WEBHOOK_URL=$/m);
  });

  it('ソースに API キーをハードコードしていない', () => {
    for (const file of collectSourceFiles(srcDir)) {
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/);
      expect(content, file).not.toMatch(/github_pat_[0-9A-Za-z_]{10,}/);
    }
  });
});
