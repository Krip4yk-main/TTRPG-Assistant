import { Worker } from 'node:worker_threads';
import type { CalendarImportErrorCode } from '@nri/shared';
import { CalendarImportError } from './errors.js';
import type { IcsParseInput, IcsParseResult } from './ics-parse.js';

export type IcsParser = (input: IcsParseInput) => Promise<IcsParseResult>;

type WorkerReply =
  { ok: true; result: IcsParseResult } | { ok: false; reason: CalendarImportErrorCode };

/** Жорсткий ліміт на потік розбору: час (включно зі стартом потоку) і пам'ять. */
const WORKER_TIMEOUT_MS = 8_000;
const WORKER_HEAP_MB = 192;

/**
 * Розбір ICS в окремому `worker_thread`: навіть якщо бібліотека зациклиться на зловмисному
 * правилі всередині одного кроку (де внутрішні ліміти `parseIcsBusy` не діють), потік
 * зупиняється за `WORKER_TIMEOUT_MS` (`too_complex`), а переповнення купи (`resourceLimits`)
 * не зачіпає сервер. Потік — TypeScript, тож запускається з `--import tsx` (як і сервер).
 */
export const parseIcsInWorker: IcsParser = (input) =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ics-worker.ts', import.meta.url), {
      workerData: input,
      execArgv: ['--import', 'tsx'],
      resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB },
      stdout: true,
      stderr: true,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
      void worker.terminate();
    };
    const timer = setTimeout(
      () => finish(() => reject(new CalendarImportError('too_complex'))),
      WORKER_TIMEOUT_MS,
    );
    worker.once('message', (msg: WorkerReply) =>
      finish(() => (msg.ok ? resolve(msg.result) : reject(new CalendarImportError(msg.reason)))),
    );
    // Переповнення пам'яті тощо — без подробиць (в повідомленні може бути вміст файлу).
    worker.once('error', () => finish(() => reject(new CalendarImportError('too_complex'))));
    worker.once('exit', () => finish(() => reject(new CalendarImportError('parse_failed'))));
  });
