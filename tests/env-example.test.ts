import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

test('.env.example documents every environment variable the app and scripts read', () => {
  const documented = new Set([...fs.readFileSync('.env.example', 'utf8').matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(m => m[1]));
  const used = new Set<string>();
  for (const file of ['server.ts', ...sources('src'), ...sources('scripts')]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[['"]([A-Z][A-Z0-9_]+)['"]\]/g)) used.add(m[1] || m[2]);
  }
  const missing = [...used].filter(k => !documented.has(k)).sort();
  assert.deepEqual(missing, [], `add these to .env.example: ${missing.join(', ')}`);
});
