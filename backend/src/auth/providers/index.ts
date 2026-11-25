import type { Env } from '../../config/env.js';
import { createDiscordProvider } from './discord.js';
import { createGoogleProvider } from './google.js';
import type { OAuthProvider } from './oauth.js';

/** Провайдери за замовчуванням з env: Google / Discord — лише коли задано обидва ключі. */
export function defaultOAuthProviders(env: Env): Record<string, OAuthProvider> {
  const out: Record<string, OAuthProvider> = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    out.google = createGoogleProvider({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
  }
  if (env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET) {
    out.discord = createDiscordProvider({
      clientId: env.DISCORD_CLIENT_ID,
      clientSecret: env.DISCORD_CLIENT_SECRET,
      publicBaseUrl: env.PUBLIC_BASE_URL,
    });
  }
  return out;
}
