import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Reutilizar las reglas versionadas; ninguna regla ni dato sale del emulador.
const root = fileURLToPath(new URL('../', import.meta.url));
const laboratory = path.resolve(root, '../../../FirebaseLab');
const rules = path.join(laboratory, 'rules/i03-i04.rules.json');
await access(rules);
const template = path.resolve(root, '../firebase.local.json');
await access(template);
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
  const settings = JSON.parse(await readFile(template, 'utf8'));
  // La CLI no acepta una ruta relativa fuera de su proyecto; conservar las reglas
  // del laboratorio sin copiarlas ni cambiarlas, resolviendo la ruta absoluta.
  settings.database[0].rules = rules;
  const config = path.join(scratch, 'firebase.json');
  await writeFile(config, JSON.stringify(settings));
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
  const entry = process.argv[2] ?? 'pulsoApi.integration.test.ts';
  const serve = entry === '--serve';
  assert.ok(serve || ['pulsoApi.integration.test.ts', 'pulsoScreen.integration.test.ts'].includes(entry));
  const test = fileURLToPath(new URL(`../tests/${entry}`, import.meta.url));
  const args = [...prefix, serve ? 'emulators:start' : 'emulators:exec', '--only', 'auth,database', '--project', 'demo-pulso-api',
    '--config', config, '--non-interactive', ...(serve ? [] : [`"${process.execPath}" --test "${test}"`])];
  // Ctrl+C llega también a la CLI; dejar que cierre sus emuladores y después limpiar.
  const interrupted = () => {};
  if (serve) process.on('SIGINT', interrupted);
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(cli, args, { cwd: scratch, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (serve) process.off('SIGINT', interrupted);
  assert.equal(code, 0, 'La ejecución local de Firebase falló.');
} finally { await rm(scratch, { recursive: true, force: true }); }
