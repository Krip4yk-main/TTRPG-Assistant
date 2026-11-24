import { existsSync } from 'node:fs';

// Локальні значення з backend/.env (gitignored); у CI змінні приходять із середовища.
if (existsSync('.env')) process.loadEnvFile('.env');
