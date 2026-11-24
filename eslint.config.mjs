import tseslint from 'typescript-eslint';
import angular from 'angular-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.angular/**',
      '**/coverage/**',
      // Згенерований перед збіркою файл (scripts/gen-runtime-config.mjs).
      'frontend/src/environments/runtime-config.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Angular: правила для компонентів/директив і обробка inline-шаблонів.
    files: ['frontend/src/**/*.ts'],
    extends: [...angular.configs.tsRecommended],
    processor: angular.processInlineTemplates,
    rules: {
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'nri', style: 'kebab-case' },
      ],
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'nri', style: 'camelCase' },
      ],
    },
  },
  {
    // Angular-шаблони: базові правила + доступність.
    files: ['frontend/src/**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
  },
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
