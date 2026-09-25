/**
 * Applies supabase/migrations/*.sql to DATABASE_URL.
 * For Supabase you can use this or `supabase db push`; the SQL is idempotent.
 */
import { migrate, openDatabase } from '../apps/api/src/db.ts';

const url = process.env.DATABASE_URL ?? 'pglite://.data/firefinder';
const db = await openDatabase(url, { poolMax: 1 });
try {
  const applied = await migrate(db, (message) => console.log(message));
  console.log(applied.length ? `Applied ${applied.length} migration(s).` : 'Database schema is up to date.');
} finally {
  await db.close();
}
