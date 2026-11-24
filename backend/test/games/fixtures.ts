import request from 'supertest';
import type { Express } from 'express';
import type { AppDeps } from '../../src/app.js';
import { createSession } from '../../src/auth/session.service.js';
import { gameSystems, genres } from '../../src/db/schema/index.js';
import { createUser } from '../helpers.js';

/** Дата народження людини, якій зараз рівно `n` повних років (день народження був ~місяць тому). */
export function bornYearsAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.toISOString().slice(0, 10);
}

/** Понеділок 19:00 за Києвом приблизно через рік — гарантовано в майбутньому. */
export function futureMondayKyiv(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7)); // найближчий понеділок (UTC)
  d.setUTCHours(16, 0, 0, 0); // 18:00/19:00 Kyiv — той самий день
  return d.toISOString();
}

export function harness(deps: AppDeps, app: Express) {
  const { db } = deps;

  async function login(userId: number): Promise<string> {
    const { token } = await createSession(deps, userId, {});
    return `nri_sid=${token}; nri_csrf=t`;
  }

  async function userWithAge(age: number, nickname?: string) {
    const u = await createUser(db, { birthDate: bornYearsAgo(age), nickname: nickname ?? null });
    return { ...u, cookie: await login(u.id) };
  }

  async function catalogIds() {
    const [s] = await db.select({ id: gameSystems.id }).from(gameSystems).limit(1);
    const [g] = await db.select({ id: genres.id }).from(genres).limit(1);
    return { systemId: s!.id, genreId: g!.id };
  }

  async function validGame(patch: Record<string, unknown> = {}) {
    const { systemId, genreId } = await catalogIds();
    return {
      title: 'Прокляття Страда',
      description: 'Готичний жах',
      systemId,
      genreId,
      format: 'online',
      platform: 'Foundry',
      kind: 'campaign',
      startsAt: futureMondayKyiv(),
      durationMinutes: 240,
      recurrence: 'weekly',
      weekdays: [0],
      minPlayers: 2,
      maxPlayers: 5,
      address: 'вул. Таємна, 1',
      channelLinks: [{ label: 'Discord', url: 'https://discord.gg/abc' }],
      ...patch,
    };
  }

  const call = (
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    cookie?: string,
    body?: object,
  ) => {
    const r = request(app)[method](path).set('X-CSRF-Token', 't');
    if (cookie) r.set('Cookie', cookie);
    else r.set('Cookie', 'nri_csrf=t');
    return r.send(body);
  };

  /** Створює гру й (за потреби) публікує. Повертає id. */
  async function createGame(
    cookie: string,
    patch: Record<string, unknown> = {},
    publish = false,
  ): Promise<number> {
    const res = await call('post', '/api/games', cookie, await validGame(patch));
    if (res.status !== 201)
      throw new Error(`create failed ${res.status} ${JSON.stringify(res.body)}`);
    const id = res.body.id as number;
    if (publish) {
      const p = await call('post', `/api/games/${id}/publish`, cookie);
      if (p.status !== 200) throw new Error(`publish failed ${p.status} ${JSON.stringify(p.body)}`);
    }
    return id;
  }

  return { login, userWithAge, catalogIds, validGame, call, createGame };
}
