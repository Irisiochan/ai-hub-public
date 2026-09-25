import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// docs/ARCHITECTURE.md 是 living doc：它承诺覆盖每个路由文件、每种后端、最新 migration 号和
// 每篇专题文档。这里不校验文字质量，只把「加了东西却没回来改文档」变成机械红灯。
const repo = fileURLToPath(new URL('../..', import.meta.url));
const docPath = path.join(repo, 'docs', 'ARCHITECTURE.md');
const doc = fs.readFileSync(docPath, 'utf8');

const missing: string[] = [];

// 1. 每个路由文件（各模块的 *Routes.ts）都要在文档里点名。
const srcDir = path.join(repo, 'server', 'src');
const routeFiles = fs.readdirSync(srcDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .flatMap((entry) => fs.readdirSync(path.join(srcDir, entry.name))
    .filter((file) => file.endsWith('Routes.ts'))
    .map((file) => `${entry.name}/${file}`));
assert.ok(routeFiles.length >= 10, `expected the module route files, found ${routeFiles.length}`);
for (const file of routeFiles) {
  if (!doc.includes(file)) missing.push(`routes file not documented: server/src/${file}`);
}

// 2. 联系人 backend 枚举值都要出现（types.ts 里的字面量联合）。
const types = fs.readFileSync(path.join(repo, 'server', 'src', 'backends', 'types.ts'), 'utf8');
const backendLine = types.split('\n').find((line) => /'claude-cli'/.test(line) && /'api'/.test(line));
assert.ok(backendLine, 'expected the backend literal union in agents/types.ts');
for (const kind of backendLine!.match(/'([a-z-]+)'/g) ?? []) {
  const bare = kind.replace(/'/g, '');
  if (!doc.includes(`\`${bare}\``)) missing.push(`backend kind not documented: ${bare}`);
}

// 3. 最新 migration 号必须出现（schema 演进范围随之更新）。
const migrations = fs
  .readdirSync(path.join(repo, 'server', 'migrations'))
  .filter((f) => /^\d{4}_.*\.sql$/.test(f))
  .sort();
const latest = migrations[migrations.length - 1]!.slice(0, 4);
if (!doc.includes(latest)) missing.push(`latest migration ${latest} not mentioned in docs/ARCHITECTURE.md`);

// 4. docs/ 下每篇专题文档都要被链接。
for (const file of fs.readdirSync(path.join(repo, 'docs'))) {
  if (!file.endsWith('.md') || file === 'ARCHITECTURE.md') continue;
  if (!doc.includes(`(${file})`)) missing.push(`doc not linked from ARCHITECTURE.md: docs/${file}`);
}

// 5. triage worker 的领域模块（worker/triage/domains/*.mjs）名要出现在文档里（新领域必须登记）。
const domainFiles = fs.readdirSync(path.join(repo, 'worker', 'triage', 'domains'))
  .filter((file) => file.endsWith('.mjs') && !/\.test\./.test(file));
assert.ok(domainFiles.length >= 7, `expected the triage domain modules, found ${domainFiles.length}`);
for (const file of domainFiles) {
  const domain = file.replace(/\.mjs$/, '');
  const key = domain === 'route-triage' ? 'routeTriage' : domain === 'idea-diary' ? 'diary' : domain;
  if (!doc.includes(key)) missing.push(`triage domain not documented: worker/triage/domains/${file} (expected "${key}")`);
}

// 6. 每个网关模块目录、每个 Web 功能目录都要在文档里以完整路径出现（§2 / §4.5）。
for (const [base, prefix] of [
  [path.join(repo, 'server', 'src'), 'server/src'],
  [path.join(repo, 'web', 'src'), 'web/src'],
] as const) {
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'styles') continue;
    const dir = `${prefix}/${entry.name}/`;
    if (!doc.includes(`\`${dir}\``)) missing.push(`module directory not documented: ${dir}`);
  }
}

assert.deepEqual(missing, [], `ARCHITECTURE.md drift:\n- ${missing.join('\n- ')}`);
console.log(`architecture doc check passed (routes, backends, migration ${latest}, docs links, triage domains, module directories)`);
