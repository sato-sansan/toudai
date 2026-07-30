import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**'],
  },
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // 自動送信を作らないことを lint でも縛る。
      // これらの API を書いた時点でビルド前に落とす。
      'no-restricted-globals': [
        'error',
        { name: 'MailApp', message: 'メール送信は実装しない。下書き作成のみ。' },
        { name: 'GmailApp', message: 'GmailApp は全権スコープを要求する。Gmail 高度サービスを使う。' },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "MemberExpression[property.name='send'], MemberExpression[property.name='sendEmail'], MemberExpression[property.name='sendDraft']",
          message: '送信 API は実装しない。作るのは Gmail の下書きまで。',
        },
        {
          selector: "MemberExpression[property.name='moveToTrash']",
          message: 'メールの削除は行わない。',
        },
        {
          selector:
            "MemberExpression[property.name='markRead'], MemberExpression[property.name='moveToArchive']",
          message: '既読化・アーカイブは行わない。',
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['tools/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
);
