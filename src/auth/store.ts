import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  AuthSession,
  AuthStore,
  AuthUser,
  LoginAttempt,
  VerifiedIdentity,
  RefreshGrant,
  TokenPair,
  RotationResult,
} from './types.js';

function userDto(row: Record<string, any>): AuthUser {
  return {
    id: row.id,
    issuer: row.issuer,
    subject: row.subject,
    displayName: row.display_name,
    ...(row.username ? { username: row.username } : {}),
    ...(row.picture ? { picture: row.picture } : {}),
  };
}
function sessionDto(row: Record<string, any>): AuthSession {
  return {
    user: userDto(row),
    csrfToken: row.csrf_token,
    expiresAt: row.expires_at,
    ...(row.family_id ? { familyId: row.family_id } : {}),
  };
}
async function revokeFamily(client: PoolClient, familyId: string): Promise<void> {
  await client.query('UPDATE auth_refresh_families SET revoked_at=clock_timestamp() WHERE id=$1', [
    familyId,
  ]);
  await client.query('DELETE FROM auth_sessions WHERE family_id=$1', [familyId]);
}
export class PgAuthStore implements AuthStore {
  constructor(private readonly pool: Pool) {}
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async createLogin(attempt: LoginAttempt) {
    await this.pool.query(
      'DELETE FROM auth_login_attempts WHERE state_hash IN (SELECT state_hash FROM auth_login_attempts WHERE expires_at<=now() LIMIT 1000)',
    );
    await this.pool.query(
      'INSERT INTO auth_login_attempts (state_hash,browser_hash,verifier,nonce,return_to,expires_at) VALUES ($1,$2,$3,$4,$5,$6)',
      [
        attempt.stateHash,
        attempt.browserHash,
        attempt.verifier,
        attempt.nonce,
        attempt.returnTo,
        attempt.expiresAt,
      ],
    );
  }
  async consumeLogin(stateHash: string, browserHash: string) {
    const { rows } = await this.pool.query(
      'DELETE FROM auth_login_attempts WHERE state_hash=$1 AND browser_hash=$2 AND expires_at>now() RETURNING *',
      [stateHash, browserHash],
    );
    const row = rows[0];
    return row
      ? ({
          stateHash: row.state_hash,
          browserHash: row.browser_hash,
          verifier: row.verifier,
          nonce: row.nonce,
          returnTo: row.return_to,
          expiresAt: row.expires_at,
        } satisfies LoginAttempt)
      : undefined;
  }
  async createSession(
    identity: VerifiedIdentity,
    hash: string,
    csrfToken: string,
    expiresAt: Date,
    previousHash?: string,
    refresh?: RefreshGrant,
    previousRefreshHash?: string,
  ) {
    return this.transaction(async (client) => {
      await client.query(
        'DELETE FROM auth_sessions WHERE token_hash IN (SELECT token_hash FROM auth_sessions WHERE expires_at<=now() LIMIT 1000)',
      );
      // Expired families and their hash history can be removed after the grace window.
      await client.query(
        "DELETE FROM auth_refresh_families WHERE id IN (SELECT id FROM auth_refresh_families WHERE expires_at < now()-interval '10 seconds' LIMIT 1000)",
      );
      const { rows } = await client.query(
        'INSERT INTO auth_users (id,issuer,subject,display_name,username,picture) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (issuer,subject) DO UPDATE SET display_name=EXCLUDED.display_name,username=EXCLUDED.username,picture=EXCLUDED.picture RETURNING *',
        [
          randomUUID(),
          identity.issuer,
          identity.subject,
          identity.displayName,
          identity.username ?? null,
          identity.picture ?? null,
        ],
      );
      if (previousHash || previousRefreshHash) {
        const previous = await client.query(
          'SELECT family_id FROM auth_sessions WHERE token_hash=$1 UNION SELECT family_id FROM auth_refresh_tokens WHERE token_hash=$2',
          [previousHash ?? null, previousRefreshHash ?? null],
        );
        for (const row of previous.rows)
          if (row.family_id) await revokeFamily(client, row.family_id);
        if (previousHash)
          await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [previousHash]);
      }
      const familyId = refresh
        ? await this.createFamily(client, rows[0].id, csrfToken, refresh)
        : null;
      await client.query(
        'INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at,family_id) VALUES ($1,$2,$3,$4,$5)',
        [hash, rows[0].id, csrfToken, expiresAt, familyId],
      );
      return userDto(rows[0]);
    });
  }
  private async createFamily(
    client: PoolClient,
    userId: string,
    csrf: string,
    grant: RefreshGrant,
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      'INSERT INTO auth_refresh_families (id,user_id,csrf_token,expires_at) VALUES ($1,$2,$3,$4)',
      [id, userId, csrf, grant.expiresAt],
    );
    await client.query('INSERT INTO auth_refresh_tokens (token_hash,family_id) VALUES ($1,$2)', [
      grant.hash,
      id,
    ]);
    return id;
  }
  async getSession(hash: string): Promise<AuthSession | undefined> {
    const { rows } = await this.pool.query(
      'SELECT u.*,s.csrf_token,s.expires_at,s.family_id FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id LEFT JOIN auth_refresh_families f ON f.id=s.family_id WHERE s.token_hash=$1 AND s.expires_at>clock_timestamp() AND (s.family_id IS NULL OR (f.revoked_at IS NULL AND f.expires_at>clock_timestamp()))',
      [hash],
    );
    return rows[0] ? sessionDto(rows[0]) : undefined;
  }
  async getRefresh(hash: string): Promise<AuthSession | undefined> {
    const { rows } = await this.pool.query(
      'SELECT u.*,f.csrf_token,f.expires_at,f.id AS family_id FROM auth_refresh_tokens t JOIN auth_refresh_families f ON f.id=t.family_id JOIN auth_users u ON u.id=f.user_id WHERE t.token_hash=$1 AND f.revoked_at IS NULL AND f.expires_at>clock_timestamp()',
      [hash],
    );
    return rows[0] ? sessionDto(rows[0]) : undefined;
  }
  async rotateRefresh(hash: string, pair: TokenPair): Promise<RotationResult> {
    return this.transaction(async (client) => {
      // Lock the family, not the token: every generation and logout share the same lock.
      const { rows } = await client.query(
        'SELECT f.* FROM auth_refresh_families f JOIN auth_refresh_tokens t ON t.family_id=f.id WHERE t.token_hash=$1 FOR UPDATE OF f',
        [hash],
      );
      const family = rows[0];
      if (!family || family.revoked_at) return { status: 'invalid' };
      const state = (
        await client.query(
          "SELECT used_at, used_at > clock_timestamp()-interval '10 seconds' AS grace FROM auth_refresh_tokens WHERE token_hash=$1",
          [hash],
        )
      ).rows[0];
      if (state.used_at) {
        if (state.grace) return { status: 'conflict' };
        await revokeFamily(client, family.id);
        return { status: 'invalid' };
      }
      const active = await client.query(
        'SELECT id FROM auth_refresh_families WHERE id=$1 AND expires_at>clock_timestamp()',
        [family.id],
      );
      if (!active.rows[0]) return { status: 'invalid' };
      await client.query(
        'UPDATE auth_refresh_tokens SET used_at=clock_timestamp() WHERE token_hash=$1',
        [hash],
      );
      await client.query('INSERT INTO auth_refresh_tokens (token_hash,family_id) VALUES ($1,$2)', [
        pair.refreshHash,
        family.id,
      ]);
      await client.query('UPDATE auth_refresh_families SET expires_at=$2 WHERE id=$1', [
        family.id,
        pair.refreshExpiresAt,
      ]);
      await client.query(
        'INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at,family_id) VALUES ($1,$2,$3,$4,$5)',
        [pair.accessHash, family.user_id, family.csrf_token, pair.accessExpiresAt, family.id],
      );
      const user = (await client.query('SELECT * FROM auth_users WHERE id=$1', [family.user_id]))
        .rows[0];
      return {
        status: 'rotated',
        session: {
          user: userDto(user),
          csrfToken: family.csrf_token,
          expiresAt: pair.accessExpiresAt,
          familyId: family.id,
        },
      };
    });
  }
  async bootstrapSession(hash: string, pair: TokenPair): Promise<RotationResult> {
    return this.transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT s.*,u.issuer,u.subject,u.display_name,u.username,u.picture FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 FOR UPDATE OF s',
        [hash],
      );
      const row = rows[0];
      if (!row || row.family_id) return { status: row?.family_id ? 'conflict' : 'invalid' };
      if (
        !(
          await client.query(
            'SELECT 1 FROM auth_sessions WHERE token_hash=$1 AND expires_at>clock_timestamp()',
            [hash],
          )
        ).rows[0]
      )
        return { status: 'invalid' };
      const familyId = await this.createFamily(client, row.user_id, row.csrf_token, {
        hash: pair.refreshHash,
        expiresAt: pair.refreshExpiresAt,
      });
      // Keep the legacy token until its original expiry; another tab may still be using it.
      await client.query('UPDATE auth_sessions SET family_id=$2 WHERE token_hash=$1', [
        hash,
        familyId,
      ]);
      await client.query(
        'INSERT INTO auth_sessions (token_hash,user_id,csrf_token,expires_at,family_id) VALUES ($1,$2,$3,$4,$5)',
        [pair.accessHash, row.user_id, row.csrf_token, pair.accessExpiresAt, familyId],
      );
      return {
        status: 'rotated',
        session: {
          user: userDto({ ...row, id: row.user_id }),
          csrfToken: row.csrf_token,
          expiresAt: pair.accessExpiresAt,
          familyId,
        },
      };
    });
  }
  async revokeRefresh(hash: string): Promise<void> {
    await this.transaction(async (client) => {
      const { rows } = await client.query(
        'SELECT f.id FROM auth_refresh_families f JOIN auth_refresh_tokens t ON t.family_id=f.id WHERE t.token_hash=$1 FOR UPDATE OF f',
        [hash],
      );
      if (rows[0]) await revokeFamily(client, rows[0].id);
    });
  }
  async deleteSession(hash: string): Promise<void> {
    await this.transaction(async (client) => {
      const family = (
        await client.query('SELECT family_id FROM auth_sessions WHERE token_hash=$1', [hash])
      ).rows[0]?.family_id;
      if (family) {
        await client.query('SELECT id FROM auth_refresh_families WHERE id=$1 FOR UPDATE', [family]);
        await revokeFamily(client, family);
      } else await client.query('DELETE FROM auth_sessions WHERE token_hash=$1', [hash]);
    });
  }
}
