import * as availability from './availability.js';
import * as auth from './auth.js';
import * as catalog from './catalog.js';
import * as events from './events.js';
import * as games from './games.js';
import * as profiles from './profiles.js';
import * as users from './users.js';

export * from './auth.js';
export * from './availability.js';
export * from './catalog.js';
export * from './events.js';
export * from './games.js';
export * from './profiles.js';
export * from './users.js';

export const schema = {
  ...users,
  ...auth,
  ...events,
  ...catalog,
  ...profiles,
  ...availability,
  ...games,
};
