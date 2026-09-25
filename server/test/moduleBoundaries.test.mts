import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 网关按功能模块分目录（docs/ARCHITECTURE.md §4）。这里把模块边界变成机械红灯：
// 1. 跨模块只能 import 对方的 index.ts（公开面），不能伸进对方的内部文件；
// 2. 模块依赖只能沿下表的方向，表本身必须无环；platform 是内核，所有模块都可以用；
// 3. 只有组合根（src/index.ts、src/server.ts）能装配任意模块，任何模块都不能 import 组合根；
// 4. 每个 index.ts 只转出本模块的文件。
// 新增一条依赖：先确认不成环，再改这张表和 ARCHITECTURE.md §4 的依赖表。
const ALLOWED: Record<string, string[]> = {
  platform: [],
  memory: [],
  messages: [],
  contacts: ['messages'],
  rooms: ['memory'],
  tasks: ['memory'],
  ops: ['messages'],
  companion: ['contacts', 'memory', 'messages'],
  workflow: ['contacts', 'memory', 'rooms'],
  devices: ['contacts'],
  jobs: ['contacts', 'devices', 'workflow'],
  roomTasks: ['jobs', 'workflow'],
  prompt: ['companion', 'contacts', 'jobs', 'memory', 'messages', 'rooms'],
  backends: ['contacts', 'memory', 'messages', 'prompt', 'rooms'],
  quota: ['backends'],
  tools: ['contacts', 'devices', 'jobs', 'roomTasks', 'workflow'],
  runtime: [
    'backends', 'companion', 'contacts', 'devices', 'jobs', 'memory', 'messages',
    'prompt', 'roomTasks', 'rooms', 'tasks', 'workflow',
  ],
  heartbeat: ['companion', 'contacts', 'devices', 'messages', 'runtime'],
  wechat: ['messages', 'runtime'],
};
const COMPOSITION_ROOT = new Set(['index.ts', 'server.ts']);

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
const rel = (file: string) => path.relative(srcDir, file).split(path.sep).join('/');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.m?ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"]+)\2/g;
const violations: string[] = [];
const modules = new Set(
  fs.readdirSync(srcDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name),
);

// Every module directory must be registered, and every registered module must exist.
for (const mod of modules) if (!(mod in ALLOWED)) violations.push(`unregistered module directory: src/${mod}/`);
for (const mod of Object.keys(ALLOWED)) if (!modules.has(mod)) violations.push(`registered module missing on disk: ${mod}`);
for (const [mod, deps] of Object.entries(ALLOWED)) {
  for (const dep of deps) if (!(dep in ALLOWED)) violations.push(`${mod} allows unknown module ${dep}`);
}

// The allowed graph must be acyclic.
const state = new Map<string, 'visiting' | 'done'>();
const visit = (mod: string, trail: string[]): void => {
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

let crossModuleImports = 0;
for (const file of walk(srcDir)) {
  const from = rel(file);
  const fromModule = from.includes('/') ? from.split('/')[0]! : null;
  if (!fromModule && !COMPOSITION_ROOT.has(from)) violations.push(`unexpected root file: src/${from}`);
  const text = fs.readFileSync(file, 'utf8');
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[3]!;
    const target = resolveImport(file, spec);
    if (!target) {
      violations.push(`${from}: cannot resolve ${spec}`);
      continue;
    }
    const to = rel(target);
    if (to.startsWith('..')) continue; // repo-level shared code (shared/coordination-keys)
    const toModule = to.includes('/') ? to.split('/')[0]! : null;
    if (!toModule) {
      if (fromModule) violations.push(`${from}: imports the composition root (${to})`);
      continue;
    }
    if (toModule === fromModule) {
      if (to === `${fromModule}/index.ts`) violations.push(`${from}: imports its own module's index.ts`);
      continue;
    }
    crossModuleImports += 1;
    if (to !== `${toModule}/index.ts`) {
      violations.push(`${from}: reaches into ${to} (import ${toModule}/index.ts instead)`);
    }
    if (fromModule && toModule !== 'platform' && !(ALLOWED[fromModule] ?? []).includes(toModule)) {
      violations.push(`${from}: ${fromModule} -> ${toModule} is not an allowed dependency`);
    }
    if (fromModule && path.basename(file) === 'index.ts') {
      violations.push(`${from}: index.ts must only re-export files of its own module`);
    }
  }
}

assert.ok(crossModuleImports > 100, `expected the cross-module imports to be scanned, saw ${crossModuleImports}`);
assert.deepEqual(violations, [], `module boundary violations:\n- ${violations.join('\n- ')}`);
console.log(`module boundaries passed (${modules.size} modules, ${crossModuleImports} cross-module imports, acyclic)`);
