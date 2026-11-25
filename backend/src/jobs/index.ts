import { DISPATCH_EVERY_MS, DISPATCH_JOB, runDispatch } from '../notifications/dispatcher.js';
import { purgeFinishedJobs } from './queue.js';
import { registerHandler, registerRecurring } from './registry.js';

/** Реєструє всі обробники й розклади фонових задач (викликається при старті сервера). */
export function registerJobs(): void {
  registerHandler('jobs.purge', async (deps) => {
    await purgeFinishedJobs(deps);
  });
  registerRecurring('jobs.purge', { dailyAtUtc: '03:30' });

  registerHandler(DISPATCH_JOB, async (deps) => {
    await runDispatch(deps);
  });
  registerRecurring(DISPATCH_JOB, { everyMs: DISPATCH_EVERY_MS });
}
