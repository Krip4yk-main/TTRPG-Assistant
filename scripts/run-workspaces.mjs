// Запускає npm-скрипт у всіх воркспейсах; без воркспейсів — успішно нічого не робить.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = process.argv[2];
const { workspaces = [] } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
if (workspaces.length === 0) {
  console.log(`No workspaces yet; skipping "${script}".`);
  process.exit(0);
}
// Контракти з shared потрібні іншим воркспейсам зібраними (dist) — будуємо перед test/typecheck.
if (workspaces.includes('shared')) {
  const b = spawnSync('npm', ['run', 'build', '-w', 'shared'], { stdio: 'inherit', shell: true });
  if (b.status !== 0) process.exit(b.status ?? 1);
}
const r = spawnSync('npm', ['run', script, '--workspaces', '--if-present'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
