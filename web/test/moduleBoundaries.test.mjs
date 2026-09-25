import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// web/src 按功能分目录（docs/ARCHITECTURE.md §4）。依赖只能沿下表方向，表必须无环；
// platform 是 API 客户端与通用件，任何功能都可以用；App.tsx / main.tsx 是组合根，
// 只有它们能把功能拼起来，功能目录不能 import 组合根。styles/ 是全局 CSS，不参与。
// 新增一条依赖：先确认不成环，再改这张表和 ARCHITECTURE.md。
const ALLOWED = {
  platform: [],
  ops: [],
  settings: ['ops'],
  jobs: [],
  workflow: ['jobs'],
  roomTasks: [],
  contacts: ['workflow'],
  chat: ['contacts', 'jobs', 'roomTasks', 'settings', 'workflow'],
  app: ['ops'],
};
const COMPOSITION_ROOT = new Set(['App.tsx', 'main.tsx']);

const root = fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'src');
const violations = [];

const modules = fs.readdirSync(src, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'styles')
  .map((entry) => entry.name);
for (const mod of modules) if (!(mod in ALLOWED)) violations.push(`unregistered feature directory: src/${mod}/`);
for (const mod of Object.keys(ALLOWED)) if (!modules.includes(mod)) violations.push(`registered feature missing: ${mod}`);

const state = new Map();
const visit = (mod, trail) => {
  if (state.get(mod) === 'done') return;
  if (state.get(mod) === 'visiting') {
    violations.push(`dependency cycle: ${[...trail.slice(trail.indexOf(mod)), mod].join(' -> ')}`);
    return;
  }
  state.set(mod, 'visiting');
  for (const dep of ALLOWED[mod] ?? []) visit(dep, [...trail, mod]);
  state.set(mod, 'done');
};
for (const mod of Object.keys(ALLOWED)) visit(mod, []);

const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
};
walk(src);

const featureOf = (file) => {
  const rel = path.relative(src, file).split(path.sep);
  return rel.length > 1 ? rel[0] : null;
};
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;
let crossFeature = 0;
for (const file of files) {
  const from = path.relative(src, file).split(path.sep).join('/');
  const fromFeature = featureOf(file);
  if (!fromFeature && !COMPOSITION_ROOT.has(path.basename(file)) && !file.endsWith('vite-env.d.ts')) {
    violations.push(`unexpected root file: src/${from}`);
  }
  for (const match of fs.readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
    const target = path.resolve(path.dirname(file), match[3]);
    if (target.endsWith('.css')) continue;
    const rel = path.relative(src, target);
    if (rel.startsWith('..')) continue;
    const toFeature = featureOf(target);
    if (!toFeature) {
      if (fromFeature) violations.push(`${from}: imports the composition root (${rel})`);
      continue;
    }
    if (toFeature === fromFeature || !fromFeature) continue;
    crossFeature += 1;
    if (toFeature !== 'platform' && !(ALLOWED[fromFeature] ?? []).includes(toFeature)) {
      violations.push(`${from}: ${fromFeature} -> ${toFeature} is not an allowed dependency`);
    }
  }
}

assert.ok(crossFeature > 40, `expected to scan the cross-feature imports, saw ${crossFeature}`);
assert.deepEqual(violations, [], `web feature boundary violations:\n- ${violations.join('\n- ')}`);
console.log(`web feature boundaries passed (${modules.length} features, ${crossFeature} cross-feature imports, acyclic)`);
