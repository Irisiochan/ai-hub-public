import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// worker/ 装着两个互不相干的常驻进程。入口留在根目录（部署路径契约：systemd 跑
// worker/triage-worker.mjs，发布副本跑 <release>/worker/worker.mjs，launcher 从检出跑
// state-store.mjs），内部代码各占一个目录：triage/ 与 runner/ 互不 import，
// 两边共用的只有 lib/，lib/ 不认识任何一边。docs/ARCHITECTURE.md W1/W2。
const workerDir = path.dirname(fileURLToPath(import.meta.url));
const SPACES = {
  triage: ['lib'],
  runner: ['lib'],
  lib: [],
};
const ENTRY_IMPORTS = {
  'triage-worker.mjs': ['triage', 'lib'],
  'diary-backfill.mjs': ['triage', 'lib'],
  'worker.mjs': ['runner', 'lib'],
  'state-store.mjs': [],
};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walk(full, out);
    } else if (entry.name.endsWith('.mjs') && !entry.name.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;
const spaceOf = (file) => {
  const rel = path.relative(workerDir, file).split(path.sep);
  return rel.length > 1 ? rel[0] : '.';
};

test('triage/ and runner/ never import each other; lib/ is shared by both', () => {
  const violations = [];
  let checked = 0;
  for (const file of walk(workerDir)) {
    const from = path.relative(workerDir, file).split(path.sep).join('/');
    const fromSpace = spaceOf(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const target = path.resolve(path.dirname(file), match[3]);
      const rel = path.relative(workerDir, target);
      if (rel.startsWith('..')) continue; // repo-level shared/ code
      checked += 1;
      const toSpace = spaceOf(target);
      if (toSpace === fromSpace) continue;
      const allowed = fromSpace === '.'
        ? (ENTRY_IMPORTS[path.basename(file)] ?? [])
        : SPACES[fromSpace] ?? [];
      if (toSpace === '.') {
        if (fromSpace !== '.') violations.push(`${from}: imports root entry file ${rel}`);
        continue;
      }
      if (!allowed.includes(toSpace)) violations.push(`${from}: ${fromSpace} -> ${toSpace} is not allowed`);
    }
  }
  assert.ok(checked > 40, `expected to scan the worker imports, saw ${checked}`);
  assert.deepEqual(violations, []);
});

test('deploy entry files stay at the worker root', () => {
  for (const entry of Object.keys(ENTRY_IMPORTS)) {
    assert.ok(fs.existsSync(path.join(workerDir, entry)), `${entry} must stay at worker/ (systemd, release and launcher paths)`);
  }
  for (const space of Object.keys(SPACES)) {
    assert.ok(fs.statSync(path.join(workerDir, space)).isDirectory(), `worker/${space}/ missing`);
  }
});
