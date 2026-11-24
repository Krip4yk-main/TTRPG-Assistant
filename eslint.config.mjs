import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/.angular/**', '**/coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    // Frontend: шаблони й стилі компонентів — лише в окремих файлах.
    files: ['frontend/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "Decorator[expression.callee.name='Component'] Property[key.name=/^(template|styles)$/]",
          message: 'Шаблони й стилі — лише в окремих .html/.less',
        },
      ],
    },
  },
);
