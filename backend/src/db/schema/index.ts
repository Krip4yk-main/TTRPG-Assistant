import * as appeals from './appeals.js';
import * as applications from './applications.js';
import * as availability from './availability.js';
import * as auth from './auth.js';
import * as calendar from './calendar.js';
import * as catalog from './catalog.js';
import * as events from './events.js';
import * as games from './games.js';
import * as notes from './notes.js';
import * as profiles from './profiles.js';
import * as sessions from './sessions.js';
import * as users from './users.js';

export * from './appeals.js';
export * from './applications.js';
export * from './auth.js';
export * from './availability.js';
export * from './calendar.js';
export * from './catalog.js';
export * from './events.js';
export * from './games.js';
export * from './notes.js';
export * from './profiles.js';
export * from './sessions.js';
export * from './users.js';

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
  ...appeals,
};
