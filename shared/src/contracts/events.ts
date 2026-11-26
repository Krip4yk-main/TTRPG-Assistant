/**
 * Фіксовані типи доменних подій (`events.type`). План 4 перетворює їх на сповіщення,
 * тож новий тип — лише через цей список.
 */
export const EVENT_TYPES = [
  // акаунт
  'user.registered',
  'user.activated',
  'user.nickname_changed',
  'user.timezone_changed',
  'user.birth_date_changed',
  'user.deleted',
  'identity.linked',
  'identity.unlinked',
  'profile.updated',
  'availability.updated',
  // ігри
  'game.created',
  'game.updated',
  'game.published',
  'game.started',
  'game.finished',
  'game.cancelled',
  'game.converted_to_campaign',
  'game.rule_changed',
  'game.paused',
  'game.resumed',
  // заявки
  'application.created',
  'application.approved',
  'application.rejected',
  'application.withdrawn',
  'application.cancelled_age',
  'application.cancelled_game',
  // учасники
  'member.left',
  'member.kicked',
  'member.banned',
  'gm.blacklisted',
  'gm.unblacklisted',
  // сесії
  'session.rescheduled',
  'session.cancelled',
  'session.done',
  // голосування за час (Plan 12)
  'poll.created',
  'poll.closed',
  // апеляції
  'appeal.created',
  // рейтинги (без оцінювача й оцінок у payload)
  'rating.created',
  'rating.published',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];
