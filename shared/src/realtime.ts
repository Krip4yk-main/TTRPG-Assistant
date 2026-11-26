/** Подія сокета: сесію(ї) відкликано, сервер зараз розірве з'єднання. */
export const SESSION_REVOKED_EVENT = 'session.revoked';

/**
 * Пінг «дані гри змінилися — перезапитайте API». Рівно `{gameId, scope}`, без даних гри
 * (видимість лишається на сервері). Кімнати:
 * - `details` — у `game:<id>` (усі, хто дивиться видиму гру);
 * - `sessions`, `members`, `polls` (голосування за час) — у `game-members:<id>` (майстер і
 *   активні учасники);
 * - `applications` — лише в особисті кімнати майстра й заявника.
 */
export const GAME_CHANGED_EVENT = 'game.changed';
export const GAME_CHANGE_SCOPES = [
  'details',
  'sessions',
  'members',
  'applications',
  'polls',
] as const;
export type GameChangeScope = (typeof GAME_CHANGE_SCOPES)[number];
export interface GameChangedPing {
  gameId: number;
  scope: GameChangeScope;
}

/**
 * Клієнт → сервер: підписка на пінги гри (`ack(GameWatchAck)`). Сервер перевіряє видимість
 * (опублікована, вікова позначка) і членство (майстер/активний учасник — ще й
 * `game-members:<id>`). Після зміни стосунку до гри (вступ, вихід) варто підписатися знову.
 */
export const GAME_WATCH_EVENT = 'game.watch';
export const GAME_UNWATCH_EVENT = 'game.unwatch';
export interface GameWatchInput {
  gameId: number;
}
/** `members: true` — підписано й на приватні пінги (`sessions`, `members`). */
export type GameWatchAck = { ok: true; members: boolean } | { ok: false };

/**
 * Пінг «ваш профіль змінився — перезапитайте `/api/me`». Рівно `{scope}`, без даних
 * профілю; лише в особисту кімнату `user:<id>` (усі сесії/вкладки/пристрої користувача,
 * зокрема й ту, що ініціювала зміну, — там це no-op). Гостям не надсилається.
 * - `appearance` — дизайн (`PATCH /api/me/theme`) або налаштування вигляду
 *   (`PATCH /api/me/ui-prefs`).
 */
export const ME_CHANGED_EVENT = 'me.changed';
export const ME_CHANGE_SCOPES = ['appearance'] as const;
export type MeChangeScope = (typeof ME_CHANGE_SCOPES)[number];
export interface MeChangedPing {
  scope: MeChangeScope;
}
