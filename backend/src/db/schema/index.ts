import * as applications from './applications.js';
import * as availability from './availability.js';
import * as auth from './auth.js';
import * as calendar from './calendar.js';
import * as demo from './demo.js';
import * as catalog from './catalog.js';
import * as events from './events.js';
import * as games from './games.js';
import * as jobs from './jobs.js';
import * as moderation from './moderation.js';
import * as notes from './notes.js';
import * as notifications from './notifications.js';
import * as polls from './polls.js';
import * as profiles from './profiles.js';
import * as ratings from './ratings.js';
import * as sessions from './sessions.js';
import * as users from './users.js';
import * as views from './views.js';

export * from './applications.js';
export * from './auth.js';
export * from './availability.js';
export * from './calendar.js';
export * from './demo.js';
export * from './catalog.js';
export * from './events.js';
export * from './games.js';
export * from './jobs.js';
export * from './moderation.js';
export * from './notes.js';
export * from './notifications.js';
export * from './polls.js';
export * from './profiles.js';
export * from './ratings.js';
export * from './sessions.js';
export * from './users.js';
export * from './views.js';

export const schema = {
  ...users,
  ...auth,
  ...events,
  ...catalog,
  ...profiles,
  ...availability,
  ...games,
  ...applications,
  ...sessions,
  ...notes,
  ...calendar,
  ...jobs,
  ...notifications,
  ...views,
  ...ratings,
  ...moderation,
  ...demo,
  ...polls,
};
