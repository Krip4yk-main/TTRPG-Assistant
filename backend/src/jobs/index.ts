import { purgeFinishedJobs } from './queue.js';
import { registerHandler, registerRecurring } from './registry.js';

/** Реєструє всі обробники й розклади фонових задач (викликається при старті сервера). */
export function registerJobs(): void {
  registerHandler('jobs.purge', async (deps) => {
    await purgeFinishedJobs(deps);
  });
  registerRecurring('jobs.purge', { dailyAtUtc: '03:30' });
}
