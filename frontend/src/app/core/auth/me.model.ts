export type UserStatus = 'pending' | 'active' | 'deleted';
export type UserRole = 'owner' | 'admin' | 'moderator' | 'user';
export type IdentityProvider = 'telegram' | 'google' | 'discord' | 'dev';

export interface IdentityDto {
  provider: IdentityProvider;
  displayName: string | null;
}

/** Відповідь `GET /api/me`. */
export interface MeDto {
  id: number;
  nickname: string | null;
  avatarUrl: string | null;
  birthDate: string | null;
  role: UserRole;
  status: UserStatus;
  timezone: string;
  locale: string;
  identities: IdentityDto[];
}
