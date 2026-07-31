import { createPostgresDatabase, migrate } from '../apps/shared/db.js';

const db = createPostgresDatabase(process.env.DATABASE_URL);
try {
  await migrate(db, process.cwd());
  console.log('migrations: PASS');
} finally {
  await db.close();
}
