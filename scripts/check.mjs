/* Build check for Iron Dominion 3D — there is no bundler, so this is the build.
 *
 *   npm run check
 *
 * Syntax-checks every inline script in index.html the way the browser will
 * parse it (module scripts as modules), validates the import map, and confirms
 * every file the import map and modulepreload links point at actually exists —
 * a Three upgrade that misses one of those paths fails here, not in production.
 */
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const problems = [];
const scratch = mkdtempSync(join(tmpdir(), 'id3-check-'));

const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)];
scripts.forEach(([, attrs, body], i) => {
  const type = (attrs.match(/type="([^"]*)"/) || [])[1] || 'classic';
  if (type === 'importmap') {
    let map;
    try { map = JSON.parse(body); } catch (e) { problems.push(`import map is not valid JSON: ${e.message}`); return; }
    for (const [spec, target] of Object.entries(map.imports || {}))
      if (!existsSync(resolve(root, target))) problems.push(`import map "${spec}" -> ${target} does not exist`);
    return;
  }
  const file = join(scratch, `script${i}.${type === 'module' ? 'mjs' : 'cjs'}`);
  writeFileSync(file, body);
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (r.status !== 0) problems.push(`inline ${type} script #${i}:\n${r.stderr.trim()}`);
});

for (const [, href] of html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g))
  if (!existsSync(resolve(root, href))) problems.push(`modulepreload ${href} does not exist`);

rmSync(scratch, { recursive: true, force: true });
if (problems.length) { console.log('FAIL\n' + problems.join('\n')); process.exit(1); }
console.log(`OK — ${scripts.length} inline scripts, import map resolved`);
