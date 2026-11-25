import {
  DEAD_GAMES_AT_UTC,
  DEAD_GAMES_JOB,
  runDeadGamesDetector,
} from '../games/dead-games/detector.js';
import { DIGEST_EVERY_MS, DIGEST_JOB, sendModerationDigest } from '../moderation/digest.js';
import {
  EXPIRE_EVERY_MS,
  EXPIRE_JOB,
  expireSanctions,
  expireSlot,
} from '../moderation/sanctions.jobs.js';
import { DISPATCH_EVERY_MS, DISPATCH_JOB, runDispatch } from '../notifications/dispatcher.js';
import { REMINDERS_EVERY_MS, REMINDERS_JOB, sendReminders } from '../notifications/reminders.js';
import {
  RATING_DEADLINE_EVERY_MS,
  RATING_DEADLINE_JOB,
  sendRatingDeadlines,
} from '../ratings/ratings.reminders.js';
import { DAILY_AT_UTC, DAILY_JOB, runDaily } from './daily.js';
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

  // Вікно нагадувань рахується від запланованого слоту (job.runAt), не від «зараз».
  registerHandler(REMINDERS_JOB, async (deps, _payload, job) => {
    await sendReminders(deps, job.runAt);
  });
  registerRecurring(REMINDERS_JOB, { everyMs: REMINDERS_EVERY_MS });

  // Нагадування «вікно оцінювання закривається»: вікно — від запланованого слоту (job.runAt).
  registerHandler(RATING_DEADLINE_JOB, async (deps, _payload, job) => {
    await sendRatingDeadlines(deps, job.runAt);
  });
  registerRecurring(RATING_DEADLINE_JOB, { everyMs: RATING_DEADLINE_EVERY_MS });

  // Зведення скарг: щогодини, але надсилається лише в слоті 09:00 за Києвом (job.runAt).
  registerHandler(DIGEST_JOB, async (deps, _payload, job) => {
    await sendModerationDigest(deps, job.runAt);
  });
  registerRecurring(DIGEST_JOB, { everyMs: DIGEST_EVERY_MS });

  // Строки санкцій: прострочені знімає система (слот — job.runAt, не раніше за «зараз»).
  registerHandler(EXPIRE_JOB, async (deps, _payload, job) => {
    await expireSanctions(deps, expireSlot(job.runAt));
  });
  registerRecurring(EXPIRE_JOB, { everyMs: EXPIRE_EVERY_MS });

  registerHandler(DAILY_JOB, async (deps) => {
    await runDaily(deps);
  });
  registerRecurring(DAILY_JOB, { dailyAtUtc: DAILY_AT_UTC });

  // Детектор «мертвих» ігор: щодня, «зараз» — запланований слот (job.runAt); ідемпотентно.
  registerHandler(DEAD_GAMES_JOB, async (deps, _payload, job) => {
    await runDeadGamesDetector(deps, job.runAt);
  });
  registerRecurring(DEAD_GAMES_JOB, { dailyAtUtc: DEAD_GAMES_AT_UTC });
}
