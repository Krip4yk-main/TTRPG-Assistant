// Лінт стилів: компоненти й глобальні стилі не містять hex-кольорів — лише токени
// var(--nri-…) / var(--mat-sys-…). Кольори задають лише файли дизайнів.
export default {
  customSyntax: 'postcss-less',
  ignoreFiles: [
    '**/node_modules/**',
    'frontend/src/styles/themes/**',
    'frontend/src/app/theming/themes/**',
  ],
  rules: {
    'color-no-hex': true,
  },
};
