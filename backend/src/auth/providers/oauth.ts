import type { VerifiedIdentity } from './provider.js';

/** Модульний OAuth2-провайдер (Google зараз, Discord — у Плані 5). */
export interface OAuthProvider {
  id: 'google' | 'discord';
  createAuthorizationUrl(state: string, codeVerifier: string): URL;
  exchange(code: string, codeVerifier: string): Promise<VerifiedIdentity>;
}
