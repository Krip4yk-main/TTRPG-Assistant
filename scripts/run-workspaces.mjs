// Запускає npm-скрипт у всіх воркспейсах; без воркспейсів — успішно нічого не робить.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const script = process.argv[2];
const { workspaces = [] } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
if (workspaces.length === 0) {
  console.log(`No workspaces yet; skipping "${script}".`);
  process.exit(0);
}
const r = spawnSync('npm', ['run', script, '--workspaces', '--if-present'], {
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
