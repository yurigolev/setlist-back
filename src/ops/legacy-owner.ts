import { readFile, writeFile } from 'node:fs/promises';
import { config } from '../config.js';
import { pool } from '../db/client.js';
import { applyLegacyOwner, prepareLegacyOwner } from './legacy-owner-plan.js';

const [action, argument, output, ...extra] = process.argv.slice(2);
try {
  if (extra.length || !argument || (action === 'plan' ? !output : action !== 'apply' || output))
    throw new Error(
      'Usage: legacy-owner.js plan <verified-auth-user-uuid> <new-plan.json> | apply <reviewed-plan.json>',
    );
  if (action === 'plan') {
    const plan = await prepareLegacyOwner(pool, config.databaseUrl, argument);
    await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(
      `Read-only owner plan saved: ${output}. Review database, owner issuer/subject, setlist and revision before apply.`,
    );
  } else {
    const result = await applyLegacyOwner(
      pool,
      config.databaseUrl,
      JSON.parse(await readFile(argument, 'utf8')),
    );
    console.log(`Legacy owner: ${result}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Legacy owner operation failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
