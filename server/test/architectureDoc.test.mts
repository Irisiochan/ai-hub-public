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

// 1. 每个路由文件都要在文档里点名。
for (const file of fs.readdirSync(path.join(repo, 'server', 'src', 'routes'))) {
  if (!file.endsWith('.ts')) continue;
  if (!doc.includes(file)) missing.push(`routes file not documented: server/src/routes/${file}`);
}

// 2. 联系人 backend 枚举值都要出现（types.ts 里的字面量联合）。
const types = fs.readFileSync(path.join(repo, 'server', 'src', 'agents', 'types.ts'), 'utf8');
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

// 5. triage worker 的领域模块名要出现在 §9（新领域必须登记）。
for (const file of fs.readdirSync(path.join(repo, 'worker'))) {
  const m = /^worker-([a-z-]+)\.mjs$/.exec(file);
  if (!m || /\.test\./.test(file)) continue;
  const domain = m[1]!;
  if (['shared', 'pipeline'].includes(domain)) continue; // 基础设施模块，不是领域
  const key = domain === 'route-triage' ? 'routeTriage' : domain === 'idea-diary' ? 'idea/diary' : domain;
  if (!doc.includes(key)) missing.push(`triage domain not documented: worker/${file} (expected "${key}")`);
}

assert.deepEqual(missing, [], `ARCHITECTURE.md drift:\n- ${missing.join('\n- ')}`);
console.log(`architecture doc check passed (routes, backends, migration ${latest}, docs links, triage domains)`);
