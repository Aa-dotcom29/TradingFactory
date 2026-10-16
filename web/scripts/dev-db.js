import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

// Local development / verification Postgres, with no admin rights and no Windows
// service. It reuses the real Postgres binaries bundled by embedded-postgres and
// keeps its data outside the repo (and outside OneDrive) on purpose.
//
//   npm run dev:db          (repo root)
//   npm --prefix web run dev-db
//
// Override with TF_PG_PORT / TF_PG_USER / TF_PG_PASSWORD / TF_PG_DATABASE / TF_PG_DATA.

const port = Number(process.env.TF_PG_PORT || 5432);
const user = process.env.TF_PG_USER || 'tf';
const password = process.env.TF_PG_PASSWORD || 'tf_local_password';
const database = process.env.TF_PG_DATABASE || 'tradingfactory';

const baseDir =
  process.env.TF_PG_DATA ||
  (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'tf-postgres')
    : path.join(os.homedir(), '.local', 'share', 'tf-postgres'));
const databaseDir = path.join(baseDir, 'data');

const alreadyInitialised = fs.existsSync(path.join(databaseDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir,
  port,
  user,
  password,
  persistent: true,
  // Windows defaults to a WIN1252 cluster, which cannot store all Unicode (a news
  // headline with a curly quote or a rupee sign would fail to insert). Force UTF-8.
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  onLog: (m) => process.stdout.write(`[pg] ${m}\n`),
  onError: (m) => process.stderr.write(`[pg] ${m}\n`),
});

async function main() {
  if (!alreadyInitialised) {
    console.log(`Initialising a new Postgres cluster at ${databaseDir}`);
    await pg.initialise();
  } else {
    console.log(`Reusing the existing Postgres cluster at ${databaseDir}`);
  }

  await pg.start();

  try {
    await pg.createDatabase(database);
    console.log(`Created database "${database}".`);
  } catch {
    console.log(`Database "${database}" already exists.`);
  }

  console.log('');
  console.log(`Postgres is listening on 127.0.0.1:${port}`);
  console.log(`DATABASE_URL=postgres://${user}:${password}@localhost:${port}/${database}`);
  console.log('');
  console.log('Press Ctrl+C to stop.');

  const shutdown = async () => {
    console.log('\nStopping Postgres...');
    try {
      await pg.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep the process (and therefore the cluster) alive until interrupted.
  setInterval(() => {}, 1 << 30);
}

main().catch((error) => {
  console.error(`dev-db failed: ${error && error.message ? error.message : error}`);
  process.exit(1);
});
