/** Подія сокета: сесію(ї) відкликано, сервер зараз розірве з'єднання. */
export const SESSION_REVOKED_EVENT = 'session.revoked';

/**
 * Пінг «дані гри змінилися — перезапитайте API». Рівно `{gameId, scope}`, без даних гри
 * (видимість лишається на сервері). Кімнати:
 * - `details` — у `game:<id>` (усі, хто дивиться видиму гру);
 * - `sessions`, `members` — у `game-members:<id>` (майстер і активні учасники);
 * - `applications` — лише в особисті кімнати майстра й заявника.
 */
export const GAME_CHANGED_EVENT = 'game.changed';
export const GAME_CHANGE_SCOPES = ['details', 'sessions', 'members', 'applications'] as const;
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
