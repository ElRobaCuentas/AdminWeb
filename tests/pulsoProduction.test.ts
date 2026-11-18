import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

it('el build de producción no incorpora el sandbox ni sus endpoints, incluso con mode pulso-local', async () => {
  const result = await build({ root: fileURLToPath(new URL('../', import.meta.url)),
    mode: 'pulso-local', envDir: false, logLevel: 'error', build: { write: false } });
  const outputs = Array.isArray(result) ? result : [result];
  const code = outputs.flatMap(output => 'output' in output ? output.output : [])
    .filter(output => output.type === 'chunk').map(output => output.code).join('\n');
  assert.ok(code.length > 0);
  for (const marker of ['demo-pulso-api', 'local-pulso-central', '127.0.0.1:19099']) {
    assert.ok(!code.includes(marker), `El build contiene configuración de emulador: ${marker}`);
  }
});

it('el build conecta VITE_PULSO_API_ORIGIN al cliente y exige su configuración en producción', async () => {
  const result = await build({ root: fileURLToPath(new URL('../', import.meta.url)), envDir: false, logLevel: 'error',
    define: { 'import.meta.env.VITE_PULSO_API_ORIGIN': JSON.stringify('https://pulso.test.invalid') },
    build: { write: false, lib: { entry: fileURLToPath(new URL('../src/shared/config/env.ts', import.meta.url)), formats: ['es'] } } });
  const outputs = Array.isArray(result) ? result : [result];
  const code = outputs.flatMap(output => 'output' in output ? output.output : [])
    .filter(output => output.type === 'chunk').map(output => output.code).join('\n');
  const config = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  assert.equal(config.readPulsoApiUrl(), 'https://pulso.test.invalid/api/pulso');
  assert.throws(() => config.readPulsoApiUrl(''), /VITE_PULSO_API_ORIGIN/);
});
