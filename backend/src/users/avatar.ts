import { asc, eq } from 'drizzle-orm';
import type { AvatarOptionDto, AvatarProvider } from '@nri/shared';
import type { Db } from '../db/client.js';
import type { Tx } from '../applications/applications.rules.js';
import { authIdentities, users } from '../db/schema/index.js';

type Source = typeof users.$inferSelect.avatarSource;
export interface AvatarIdentity {
  provider: typeof authIdentities.$inferSelect.provider;
  avatarUrl: string | null;
}

const AVATAR_PROVIDERS: readonly string[] = ['google', 'discord', 'telegram'];

/** Прив'язані провайдери з аватаром (порядок прив'язки) — доступні джерела вибору. */
export function avatarOptions(identities: readonly AvatarIdentity[]): AvatarOptionDto[] {
  return identities.flatMap((i) =>
    i.avatarUrl && AVATAR_PROVIDERS.includes(i.provider)
      ? [{ source: i.provider as AvatarProvider, previewUrl: i.avatarUrl }]
      : [],
  );
}

/**
 * Ефективний аватар. `identities` — у порядку прив'язки (за `id`).
 * - `none` — без аватара; `custom` — власне посилання;
 * - `google`/`discord`/`telegram` — аватар цього провайдера; якщо ідентичність уже без аватара
 *   (провайдер його прибрав) — поводимось як `auto`;
 * - `auto` — аватар провайдера, з яким створено акаунт (найраніша прив'язка), а якщо в нього
 *   аватара немає — аватар будь-якого іншого прив'язаного провайдера (у порядку прив'язки).
 */
export function effectiveAvatar(
  source: Source,
  customUrl: string | null,
  identities: readonly AvatarIdentity[],
): string | null {
  if (source === 'none') return null;
  if (source === 'custom' && customUrl) return customUrl;
  if (source !== 'auto' && source !== 'custom') {
    const own = identities.find((i) => i.provider === source)?.avatarUrl;
    if (own) return own;
  }
  const first = identities[0]?.avatarUrl;
  if (first) return first;
  return avatarOptions(identities)[0]?.previewUrl ?? null;
}

/**
 * Перераховує `users.avatar_url` з обраного джерела й ідентичностей. Викликати після зміни вибору,
 * входу/прив'язки (оновився аватар ідентичності) та відв'язування провайдера.
 */
export async function recomputeAvatar(db: Db | Tx, userId: number): Promise<void> {
  const [u] = await db
    .select({
      source: users.avatarSource,
      customUrl: users.customAvatarUrl,
      avatarUrl: users.avatarUrl,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || u.status === 'deleted') return;
  const identities = await db
    .select({ provider: authIdentities.provider, avatarUrl: authIdentities.avatarUrl })
    .from(authIdentities)
    .where(eq(authIdentities.userId, userId))
    .orderBy(asc(authIdentities.id));
  const next = effectiveAvatar(u.source, u.customUrl, identities);
  if (next !== u.avatarUrl)
    await db.update(users).set({ avatarUrl: next }).where(eq(users.id, userId));
}
