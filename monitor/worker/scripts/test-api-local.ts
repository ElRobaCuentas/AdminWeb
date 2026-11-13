import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reutilizar las reglas versionadas; ninguna regla ni dato sale del emulador.
const root = fileURLToPath(new URL('../', import.meta.url));
const laboratory = path.resolve(root, '../../../FirebaseLab');
const rules = path.join(laboratory, 'rules/i03-i04.rules.json');
await access(rules);
for (const port of [19000, 19099, 14400, 14500]) {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once('error', () => reject(new Error(`Puerto ${port} ocupado; no se reutiliza un emulador ajeno.`)));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve()));
  });
}
const parent = path.join(tmpdir(), 'opencode');
await mkdir(parent, { recursive: true });
const scratch = await mkdtemp(path.join(parent, 'pulso-api-emulators-'));
try {
  const config = path.join(scratch, 'firebase.json');
  await writeFile(config, JSON.stringify({
    database: [{ instance: 'demo-pulso-api', rules }],
    emulators: {
      auth: { host: '127.0.0.1', port: 19099 }, database: { host: '127.0.0.1', port: 19000 },
      hub: { host: '127.0.0.1', port: 14400 }, logging: { host: '127.0.0.1', port: 14500 },
      ui: { enabled: false }, singleProjectMode: true,
    },
  }));
  const env = { ...process.env, FIREBASE_CLI_DISABLE_MOTD: '1' };
  delete env.FIREBASE_TOKEN;
  delete env.GOOGLE_APPLICATION_CREDENTIALS;
  const windows = process.platform === 'win32';
  if (windows) {
    // Igual que FirebaseLab: usar Java 21 de Android Studio, no el Java 8 global.
    env.JAVA_HOME = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Android/Android Studio/jbr');
    for (const key of Object.keys(env)) if (key.toLowerCase() === 'path') delete env[key];
    env.PATH = `${path.join(env.JAVA_HOME, 'bin')}${path.delimiter}${process.env.PATH ?? ''}`;
  }
  // Aprovechar el JAR del laboratorio si ya está descargado, sin instalar dependencias.
  const cache = path.join(laboratory, '.cache/emulators');
  try { await access(cache); env.FIREBASE_EMULATORS_PATH = cache; } catch { /* La CLI usa su caché habitual. */ }
  const cli = windows ? process.execPath : 'firebase';
  const prefix = windows ? [path.join(process.env.APPDATA!, 'npm/node_modules/firebase-tools/lib/bin/firebase.js')] : [];
  const test = fileURLToPath(new URL('../tests/pulsoApi.integration.test.ts', import.meta.url));
  const args = [...prefix, 'emulators:exec', '--only', 'auth,database', '--project', 'demo-pulso-api',
    '--config', config, '--non-interactive', `"${process.execPath}" --test "${test}"`];
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(cli, args, { cwd: scratch, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0, 'Las pruebas locales de la API fallaron.');
} finally { await rm(scratch, { recursive: true, force: true }); }
