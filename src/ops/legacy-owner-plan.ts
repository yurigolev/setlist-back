import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { LIBRARY_ID } from '../db/schema.js';

const ownerSchema = z.strictObject({
  id: z.uuid(),
  issuer: z.literal('https://login.yandex.ru'),
  subject: z.string().min(1),
  displayName: z.string(),
});
const planSchema = z.strictObject({
  version: z.literal(1),
  target: z.strictObject({
    endpointHash: z.string().regex(/^[a-f0-9]{64}$/),
    database: z.string(),
    oid: z.string(),
    systemId: z.string(),
  }),
  owner: ownerSchema,
  library: z.strictObject({
    id: z.literal(LIBRARY_ID),
    title: z.string(),
    revision: z.string().regex(/^\d+$/),
  }),
  memberships: z.array(
    z.strictObject({ userId: z.uuid(), role: z.enum(['owner', 'editor', 'viewer']) }),
  ),
  adoptedBy: z.uuid().nullable(),
});
export type LegacyOwnerPlan = z.infer<typeof planSchema>;

async function state(
  client: PoolClient,
  databaseUrl: string,
  userId: string,
  lock: boolean,
): Promise<LegacyOwnerPlan> {
  z.uuid().parse(userId);
  const url = new URL(databaseUrl);
  const endpoint = JSON.stringify([url.hostname, url.port || '5432', url.pathname, url.username]);
  const target = (
    await client.query(
      'SELECT current_database() AS database, oid::text, (SELECT system_identifier::text FROM pg_control_system()) AS "systemId" FROM pg_database WHERE datname=current_database()',
    )
  ).rows[0];
  const library = (
    await client.query(
      `SELECT id,title,revision::text FROM libraries WHERE id=$1 AND deleted_at IS NULL${lock ? ' FOR UPDATE' : ''}`,
      [LIBRARY_ID],
    )
  ).rows[0];
  if (!library) throw new Error('Legacy setlist is absent or deleted');
  const user = (
    await client.query(
      `SELECT id,issuer,subject,display_name FROM auth_users WHERE id=$1${lock ? ' FOR SHARE' : ''}`,
      [userId],
    )
  ).rows[0];
  if (!user)
    throw new Error('Selected owner has not completed verified authentication in this database');
  const owner = ownerSchema.parse({
    id: user.id,
    issuer: user.issuer,
    subject: user.subject,
    displayName: user.display_name,
  });
  const memberships = (
    await client.query(
      'SELECT user_id AS "userId",role FROM setlist_memberships WHERE setlist_id=$1 ORDER BY user_id',
      [LIBRARY_ID],
    )
  ).rows;
  const adoptedBy =
    (await client.query('SELECT user_id FROM legacy_adoptions WHERE setlist_id=$1', [LIBRARY_ID]))
      .rows[0]?.user_id ?? null;
  if (adoptedBy && adoptedBy !== owner.id)
    throw new Error('Legacy setlist was already adopted by another identity');
  if (!adoptedBy && memberships.length)
    throw new Error('Unmarked legacy membership requires manual review');
  return planSchema.parse({
    version: 1,
    target: { ...target, endpointHash: createHash('sha256').update(endpoint).digest('hex') },
    owner,
    library,
    memberships,
    adoptedBy,
  });
}

async function transaction<T>(
  pool: Pool,
  readOnly: boolean,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
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

/** No account is created here. Only a previously authenticated, explicitly selected user is eligible. */
export function prepareLegacyOwner(
  pool: Pool,
  databaseUrl: string,
  userId: string,
): Promise<LegacyOwnerPlan> {
  return transaction(pool, true, (client) => state(client, databaseUrl, userId, false));
}

export async function applyLegacyOwner(
  pool: Pool,
  databaseUrl: string,
  input: unknown,
): Promise<'adopted' | 'already-adopted'> {
  const plan = planSchema.parse(input);
  return transaction(pool, false, async (client) => {
    const current = await state(client, databaseUrl, plan.owner.id, true);
    if (
      !isDeepStrictEqual(current.target, plan.target) ||
      !isDeepStrictEqual(current.owner, plan.owner)
    )
      throw new Error(
        'Owner plan targets another database or changed identity; prepare a new plan',
      );
    // A replay must never undo a later deliberate demotion or removal.
    if (current.adoptedBy === plan.owner.id) return 'already-adopted';
    if (!isDeepStrictEqual(current, plan))
      throw new Error('Legacy state changed after planning; prepare a new plan');
    await client.query(
      "INSERT INTO setlist_memberships (setlist_id,user_id,role) VALUES ($1,$2,'owner')",
      [LIBRARY_ID, plan.owner.id],
    );
    await client.query('INSERT INTO legacy_adoptions (setlist_id,user_id) VALUES ($1,$2)', [
      LIBRARY_ID,
      plan.owner.id,
    ]);
    return 'adopted';
  });
}
