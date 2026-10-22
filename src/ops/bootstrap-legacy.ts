import { and, eq, sql } from 'drizzle-orm';
import { config } from '../config.js';
import { db, pool } from '../db/client.js';
import { authUsers, legacyAdoptions, LIBRARY_ID, memberships } from '../db/schema.js';
export async function bootstrapLegacy() {
  // Explicit local action only. This command never manufactures an auth identity.
  const target = new URL(config.databaseUrl);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
    throw new Error('Legacy bootstrap is restricted to a local database');
  const issuer = config.auth.legacyOwnerIssuer,
    subject = config.auth.legacyOwnerSub;
  if (!issuer || !subject)
    throw new Error('Explicit verified legacy owner issuer and subject required');
  await db.transaction(async (tx) => {
    const scope = await tx.execute(
      sql`SELECT id FROM libraries WHERE id=${LIBRARY_ID} AND deleted_at IS NULL FOR UPDATE`,
    );
    if (!scope.rows[0]) throw new Error('Legacy setlist is absent or deleted');
    const [user] = await tx
      .select()
      .from(authUsers)
      .where(and(eq(authUsers.issuer, issuer), eq(authUsers.subject, subject)));
    if (!user) throw new Error('Configured identity has not completed verified authentication');
    const [adopted] = await tx
      .select()
      .from(legacyAdoptions)
      .where(eq(legacyAdoptions.setlistId, LIBRARY_ID));
    if (adopted) {
      if (adopted.userId !== user.id)
        throw new Error('Legacy setlist was already adopted by another identity');
      return; // Deliberate later demotion/removal must never be reversed.
    }
    const existing = await tx
      .select()
      .from(memberships)
      .where(eq(memberships.setlistId, LIBRARY_ID));
    if (existing.length) throw new Error('Unmarked legacy membership requires manual review');
    await tx.insert(memberships).values({ setlistId: LIBRARY_ID, userId: user.id, role: 'owner' });
    await tx.insert(legacyAdoptions).values({ setlistId: LIBRARY_ID, userId: user.id });
  });
}
try {
  await bootstrapLegacy();
  console.log('Legacy adoption complete (idempotent)');
} finally {
  await pool.end();
}
