export type Provider = 'telegram' | 'google' | 'discord' | 'dev';

export interface VerifiedIdentity {
  provider: Provider;
  subject: string;
  displayName?: string;
  /** `undefined` — аватар невідомий (не змінюємо збережений); `null` — у провайдера аватара немає/прибрано. */
  avatarUrl?: string | null;
}
