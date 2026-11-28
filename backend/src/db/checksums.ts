import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));
export const CHECKSUMS_FILE = join(MIGRATIONS_DIR, 'checksums.json');

/** SHA-256 вмісту файлу; CRLF → LF, щоб checkout на Windows не міняв суму. */
export function fileChecksum(path: string): string {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  return createHash('sha256').update(text).digest('hex');
}

/** Суми всіх `*.sql` у каталозі міграцій, відсортовані за назвою. */
export function computeChecksums(dir = MIGRATIONS_DIR): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    result[name] = fileChecksum(join(dir, name));
  }
  return result;
}

export function readManifest(): Record<string, string> {
  return JSON.parse(readFileSync(CHECKSUMS_FILE, 'utf8')) as Record<string, string>;
}

/**
 * `npm run db:checksums -w backend` — дописує до маніфесту нові міграції. Уже зафіксовані суми
 * не перезаписуються: змінений застосований файл — помилка, а не привід оновити маніфест.
 */
function main(): void {
  let manifest: Record<string, string> = {};
  try {
    manifest = readManifest();
  } catch {
    // маніфесту ще немає — створюємо
  }
  const current = computeChecksums();
  const next: Record<string, string> = { ...manifest };
  const added: string[] = [];
  for (const [name, sum] of Object.entries(current)) {
    if (!(name in manifest)) {
      next[name] = sum;
      added.push(name);
    } else if (manifest[name] !== sum) {
      console.error(`Міграція ${name} змінена після фіксації — відкотіть зміни й додайте нову.`);
      process.exitCode = 1;
      return;
    }
  }
  const sorted = Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(CHECKSUMS_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(added.length ? `Додано: ${added.join(', ')}` : 'Маніфест актуальний');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
