import { parentPort, workerData } from 'node:worker_threads';
import { CalendarImportError } from './errors.js';
import { parseIcsBusy, type IcsParseInput } from './ics-parse.js';

// Окремий потік для розбору ICS (див. `parse-runner.ts`): зловмисний файл не може заблокувати
// основний цикл подій чи з'їсти його пам'ять.
try {
  parentPort!.postMessage({ ok: true, result: parseIcsBusy(workerData as IcsParseInput) });
} catch (err) {
  parentPort!.postMessage({
    ok: false,
    reason: err instanceof CalendarImportError ? err.reason : 'parse_failed',
  });
}
