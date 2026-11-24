export type Provider = 'telegram' | 'google' | 'discord' | 'dev';

export interface VerifiedIdentity {
  provider: Provider;
  subject: string;
  displayName?: string;
  avatarUrl?: string;
}
