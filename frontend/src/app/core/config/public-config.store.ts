import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { PublicConfigDto } from '@nri/shared';
import { firstValueFrom } from 'rxjs';

/** Поки конфіг не завантажено (або запит не вдався) — усе вимкнено. */
const EMPTY: PublicConfigDto = {
  telegramBotUsername: null,
  providers: { telegram: false, google: false, discord: false },
};

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/**
 * Перевірка форми відповіді вручну: рантайм-імпорт схеми з `@nri/shared` затягнув би zod і весь
 * спільний код у початковий бандл (удвічі більший), а тут потрібні лише типи.
 */
function parsePublicConfig(raw: unknown): PublicConfigDto {
  const r = raw as Partial<PublicConfigDto> | null;
  const p = r?.providers;
  const name = r?.telegramBotUsername;
  if (
    !p ||
    !isBool(p.telegram) ||
    !isBool(p.google) ||
    !isBool(p.discord) ||
    !(name === null || (typeof name === 'string' && name !== ''))
  ) {
    throw new Error('bad public config');
  }
  return {
    telegramBotUsername: name,
    providers: { telegram: p.telegram, google: p.google, discord: p.discord },
  };
}

/**
 * Публічні налаштування з бекенду (`GET /api/public-config`): ім'я Telegram-бота й увімкнені
 * способи входу. Завантажуються на старті без блокування першого рендера; сторінка входу
 * чекає на них через `publicConfigGuard`. Невдалий запит нічого не ламає — способи входу
 * лишаються вимкненими, наступний `ensureLoaded()` пробує знову.
 */
@Injectable({ providedIn: 'root' })
export class PublicConfigStore {
  private readonly http = inject(HttpClient);
  private readonly state = signal<PublicConfigDto>(EMPTY);
  private readonly loadedFlag = signal(false);
  private readonly failedFlag = signal(false);
  private loading: Promise<void> | null = null;

  readonly loaded = this.loadedFlag.asReadonly();
  /** Остання спроба завантаження не вдалась (бекенд недоступний чи відповів не так). */
  readonly failed = this.failedFlag.asReadonly();
  /** Ім'я бота для Login Widget; порожній рядок — Telegram вимкнено. */
  readonly telegramBotUsername = computed(() => this.state().telegramBotUsername ?? '');
  readonly telegramLogin = computed(() => this.state().providers.telegram);
  readonly googleLogin = computed(() => this.state().providers.google);
  readonly discordLogin = computed(() => this.state().providers.discord);

  /** Дочікується успішного завантаження (повторює спробу, якщо попередня не вдалась). */
  ensureLoaded(): Promise<void> {
    if (this.loadedFlag()) return Promise.resolve();
    this.loading ??= this.fetch().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async fetch(): Promise<void> {
    try {
      const raw = await firstValueFrom(this.http.get<unknown>('/api/public-config'));
      this.state.set(parsePublicConfig(raw));
      this.loadedFlag.set(true);
      this.failedFlag.set(false);
    } catch {
      // Бекенд недоступний чи відповів не так: способи входу лишаються вимкненими.
      this.failedFlag.set(true);
    }
  }
}
