/**
 * dist/ を作るビルドスクリプト。
 *
 * src/ は ES モジュールで書き、esbuild で1ファイルへバンドルする。
 * GAS はモジュールを解さないので IIFE 形式にし、トリガーから呼べるよう
 * トップレベルのグローバル関数ラッパを footer で生成する。
 *
 * 生成物:
 *   dist/Code.js         … バンドル + グローバル関数
 *   dist/appsscript.json … マニフェスト（そのままコピー）
 *
 * clasp は .clasp.json の rootDir が dist/ を指す前提。
 */
import { build } from 'esbuild';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(root, 'dist');
const globalName = '__MAIL_ASSISTANT__';

/**
 * GAS 側へ露出する関数。トリガーのハンドラ名およびエディタから実行する関数。
 * src/entrypoints.ts の export と一致させること。
 */
const ENTRYPOINTS = [
  'runReplyAssistant',
  'runDryRunPreview',
  'runDailySummary',
  'showEffectiveConfig',
  'setupLabels',
  'installTriggers',
  'removeTriggers',
];

const footer = [
  '',
  '// --- GAS から呼び出すためのグローバル関数（tools/build.mjs が生成） ---',
  ...ENTRYPOINTS.map(
    (name) => `function ${name}() { return ${globalName}.${name}.apply(null, arguments); }`,
  ),
  '',
].join('\n');

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

await build({
  entryPoints: [path.join(root, 'src', 'entrypoints.ts')],
  outfile: path.join(distDir, 'Code.js'),
  bundle: true,
  format: 'iife',
  globalName,
  // GAS V8 は概ね ES2019 相当。?. / ?? は変換させる。
  target: 'es2019',
  platform: 'neutral',
  charset: 'utf8',
  legalComments: 'none',
  logLevel: 'info',
  footer: { js: footer },
});

await copyFile(path.join(root, 'appsscript.json'), path.join(distDir, 'appsscript.json'));

console.log(`ビルド完了: ${path.relative(root, distDir)}/Code.js (+ appsscript.json)`);
console.log(`公開する関数: ${ENTRYPOINTS.join(', ')}`);
