// Run the suite locally the same way CI does, without Docker:
// start a throwaway PostgreSQL 16 on 127.0.0.1 (embedded-postgres binaries),
// apply migrations, run Jest, then stop the server and delete its data dir.
//
//   npm run test:local                 # whole suite
//   npm run test:local -- --shard=1/2  # same sharding as CI
//
// If you already have a disposable local Postgres, skip this and run
// `DATABASE_URL=postgres://... npm run db:migrate && npm test` instead.

import EmbeddedPostgres from 'embedded-postgres';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// On Windows the server's child processes release the data dir a moment
// after stop() resolves, so retry the delete for a few seconds.
async function removeWhenReleased(dir) {
  for (let i = 0; i < 60; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  console.warn(`could not delete ${dir}; remove it by hand`);
}

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { stdio: 'inherit', env });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

const port = await freePort();
const dataDir = mkdtempSync(join(tmpdir(), 'pour-ledger-pg-'));
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'pour',
  password: 'pour',
  port,
  persistent: true, // we delete the data dir ourselves (Windows needs retries)
  postgresFlags: ['-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=off'],
  onLog: () => {},
});

let code = 1;
try {
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pour_ledger_test');

  const env = {
    ...process.env,
    DATABASE_URL: `postgres://pour:pour@127.0.0.1:${port}/pour_ledger_test`,
  };
  console.log(`throwaway PostgreSQL 16 on 127.0.0.1:${port}`);

  code = await run([join('scripts', 'migrate.js')], env);
  if (code === 0) {
    code = await run([require.resolve('jest/bin/jest'), '--ci', ...process.argv.slice(2)], env);
  }
} finally {
  await pg.stop();
  await removeWhenReleased(dataDir);
}
process.exit(code);
