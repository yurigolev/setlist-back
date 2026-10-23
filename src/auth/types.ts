export interface AuthConfig {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  pwaOrigin: string;
  secureCookies: boolean;
  sessionTtlSeconds: number;
  refreshTtlSeconds?: number;
  legacyOwnerIssuer?: string;
  legacyOwnerSub?: string;
}
export interface AuthUser {
  id: string;
  issuer: string;
  subject: string;
  displayName: string;
  username?: string;
  picture?: string;
}
export interface LoginAttempt {
  stateHash: string;
  browserHash: string;
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: Date;
}
export interface AuthSession {
  user: AuthUser;
  csrfToken: string;
  expiresAt: Date;
  familyId?: string;
}
export interface RefreshGrant {
  hash: string;
  expiresAt: Date;
}
export interface TokenPair {
  accessHash: string;
  accessExpiresAt: Date;
  refreshHash: string;
  refreshExpiresAt: Date;
}
export type RotationResult =
  { status: 'rotated'; session: AuthSession } | { status: 'conflict' | 'invalid' };
export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  displayName: string;
  username?: string;
  picture?: string;
}
export interface AuthStore {
  createLogin(attempt: LoginAttempt): Promise<void>;
  consumeLogin(stateHash: string, browserHash: string): Promise<LoginAttempt | undefined>;
  createSession(
    identity: VerifiedIdentity,
    tokenHash: string,
    csrfToken: string,
    expiresAt: Date,
    previousTokenHash?: string,
    refresh?: RefreshGrant,
    previousRefreshHash?: string,
  ): Promise<AuthUser>;
  getSession(tokenHash: string): Promise<AuthSession | undefined>;
  deleteSession(tokenHash: string): Promise<void>;
  getRefresh(hash: string): Promise<AuthSession | undefined>;
  rotateRefresh(hash: string, pair: TokenPair): Promise<RotationResult>;
  bootstrapSession(hash: string, pair: TokenPair): Promise<RotationResult>;
  revokeRefresh(hash: string): Promise<void>;
}
export interface YandexOAuth {
  authorizationUrl(state: string, verifier: string): string;
  authenticate(code: string, verifier: string): Promise<VerifiedIdentity>;
}
