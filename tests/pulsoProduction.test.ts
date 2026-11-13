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
