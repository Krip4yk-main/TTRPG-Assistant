import * as auth from './auth.js';
import * as events from './events.js';
import * as users from './users.js';

export * from './auth.js';
export * from './events.js';
export * from './users.js';

export const schema = { ...users, ...auth, ...events };
