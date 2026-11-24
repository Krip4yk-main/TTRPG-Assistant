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
            "Decorator[expression.callee.name='Component'] > CallExpression > ObjectExpression > Property[key.name=/^(template|styles)$/], Decorator[expression.callee.name='Component'] > CallExpression > ObjectExpression > Property[key.value=/^(template|styles)$/]",
          message: 'Шаблони й стилі — лише в окремих .html/.less',
        },
      ],
    },
  },
);
