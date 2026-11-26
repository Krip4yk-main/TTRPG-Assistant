import {
  DEAD_GAMES_AT_UTC,
  DEAD_GAMES_JOB,
  runDeadGamesDetector,
} from '../games/dead-games/detector.js';
import {
  LONG_PAUSE_AT_UTC,
  LONG_PAUSE_JOB,
  runLongPauseReminders,
} from '../games/dead-games/long-pause.js';
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
import {
  POLLS_CLOSE_EVERY_MS,
  POLLS_CLOSE_JOB,
  runPollsClose,
} from '../scheduling/polls.service.js';
import {
  CALENDAR_REMINDERS_EVERY_MS,
  CALENDAR_REMINDERS_JOB,
  runCalendarReminders,
} from '../scheduling/calendar-reminder.service.js';
import {
  RSVP_DECLINED_EVERY_MS,
  RSVP_DECLINED_JOB,
  runRsvpDeclineNotices,
} from '../scheduling/reschedule.service.js';
import {
  CALENDAR_IMPORT_EVERY_MS,
  CALENDAR_IMPORT_JOB,
  runCalendarImportSync,
} from '../scheduling/ical/calendar-import.service.js';
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

  // Довга пауза кампейну: щодня нагадування майстру (раз на 30 днів після 90 днів паузи).
  registerHandler(LONG_PAUSE_JOB, async (deps, _payload, job) => {
    await runLongPauseReminders(deps, job.runAt);
  });
  registerRecurring(LONG_PAUSE_JOB, { dailyAtUtc: LONG_PAUSE_AT_UTC });

  // Голосування за час: закриття за дедлайном / «всі проголосували»; ідемпотентно (умовний UPDATE).
  registerHandler(POLLS_CLOSE_JOB, async (deps, _payload, job) => {
    await runPollsClose(deps, new Date(Math.max(Date.now(), job.runAt.getTime())));
  });
  registerRecurring(POLLS_CLOSE_JOB, { everyMs: POLLS_CLOSE_EVERY_MS });

  // «Не буду» → сповіщення майстру із затримкою (збирає кілька в одне); ідемпотентно.
  registerHandler(RSVP_DECLINED_JOB, async (deps, _payload, job) => {
    await runRsvpDeclineNotices(deps, new Date(Math.max(Date.now(), job.runAt.getTime())));
  });
  registerRecurring(RSVP_DECLINED_JOB, { everyMs: RSVP_DECLINED_EVERY_MS });

  // Нагадування про порожній календар: раз назавжди (рядок `calendar_reminders`).
  registerHandler(CALENDAR_REMINDERS_JOB, async (deps, _payload, job) => {
    await runCalendarReminders(deps, new Date(Math.max(Date.now(), job.runAt.getTime())));
  });
  registerRecurring(CALENDAR_REMINDERS_JOB, { everyMs: CALENDAR_REMINDERS_EVERY_MS });

  // Імпорт iCal: кожні 15 хв оновлює посилання, яким минуло 3 год від останньої спроби.
  registerHandler(CALENDAR_IMPORT_JOB, async (deps, _payload, job) => {
    await runCalendarImportSync(deps, new Date(Math.max(Date.now(), job.runAt.getTime())));
  });
  registerRecurring(CALENDAR_IMPORT_JOB, { everyMs: CALENDAR_IMPORT_EVERY_MS });
}
