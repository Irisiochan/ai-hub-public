// check-shared-packages.mjs against real git: a temp repo whose app/ installs
// shared/pkg as a copy, next to a package.json-less shared/plain (the shape of
// shared/coordination-keys, which is imported by path and never versioned).
// - content that changed after the commit setting the version fails, committed,
//   uncommitted or untracked, until a bump lands in every consumer lock;
// - the lock must keep the copy shape and the consumer install-links=true;
// - without full history the drift check is skipped, or fails under --require-history.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./check-shared-packages.mjs', import.meta.url));
const SPEC = 'file:../shared/pkg';

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}${r.stdout}`);
  return r.stdout.trim();
}

function identity(cwd) {
  git(cwd, 'config', 'user.email', 'drill@example.com');
  git(cwd, 'config', 'user.name', 'drill');
  git(cwd, 'config', 'commit.gpgsign', 'false');
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-m', message);
}

function check(root, ...flags) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', root, ...flags], { encoding: 'utf8' });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function editJson(file, update) {
  writeJson(file, update(JSON.parse(fs.readFileSync(file, 'utf8'))));
}

function setVersion(root, version) {
  editJson(path.join(root, 'shared/pkg/package.json'), (pkg) => ({ ...pkg, version }));
}

function setLockEntry(root, update) {
  editJson(path.join(root, 'app/package-lock.json'), (lock) => {
    lock.packages['node_modules/@drill/pkg'] = update(lock.packages['node_modules/@drill/pkg']);
    return lock;
  });
}

function changeContent(root) {
  fs.writeFileSync(path.join(root, 'shared/pkg/index.js'), 'export const backends = ["a", "b"];\n');
}

function fixture(t, { repo = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-shared-pkg-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); });
  writeJson(path.join(root, 'shared/pkg/package.json'), { name: '@drill/pkg', version: '1.0.0', type: 'module' });
  fs.writeFileSync(path.join(root, 'shared/pkg/index.js'), 'export const backends = ["a"];\n');
  fs.mkdirSync(path.join(root, 'shared/plain'));
  fs.writeFileSync(path.join(root, 'shared/plain/index.mjs'), 'export {};\n');
  writeJson(path.join(root, 'app/package.json'), { name: 'app', dependencies: { '@drill/pkg': SPEC } });
  fs.writeFileSync(path.join(root, 'app/.npmrc'), 'install-links=true\n');
  writeJson(path.join(root, 'app/package-lock.json'), {
    name: 'app',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'app', dependencies: { '@drill/pkg': SPEC } },
      'node_modules/@drill/pkg': { version: '1.0.0', resolved: SPEC },
    },
  });
  if (repo) {
    git(root, 'init', '-b', 'master');
    identity(root);
    commit(root, 'base');
  }
  return root;
}

test('versions, locks and content that agree pass', (t) => {
  const root = fixture(t);
  const r = check(root, '--require-history');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /ok {3}shared\/pkg 1\.0\.0 \(app; unchanged since [0-9a-f]{7}\)/);
  assert.doesNotMatch(r.output, /shared\/plain/);
});

test('a content change without a bump fails, committed or not', (t) => {
  const root = fixture(t);
  changeContent(root);
  let r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /shared\/pkg changed since 1\.0\.0 was set in [0-9a-f]{7,} base:\n +shared\/pkg\/index\.js/);
  assert.match(r.output, /npm pkg set version=<next> --prefix shared\/pkg/);
  assert.match(r.output, /npm install --package-lock-only --prefix app @drill\/pkg@file:\.\.\/shared\/pkg/);

  commit(root, 'change without bump');
  r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /was set in [0-9a-f]{7,} base:\n +shared\/pkg\/index\.js/);
});

test('an untracked file in the package counts as a change', (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'shared/pkg/extra.js'), 'export {};\n');
  const r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /shared\/pkg\/extra\.js/);
});

test('a bump passes once every lock records it, before and after commit', (t) => {
  const root = fixture(t);
  changeContent(root);
  commit(root, 'change without bump');
  setVersion(root, '1.0.1');
  let r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /app\/package-lock\.json records @drill\/pkg@1\.0\.0, shared\/pkg is 1\.0\.1/);
  assert.match(r.output, /Bump the version/);

  setLockEntry(root, (entry) => ({ ...entry, version: '1.0.1' }));
  r = check(root, '--require-history');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /1\.0\.1 not committed yet/);

  commit(root, 'bump');
  r = check(root, '--require-history');
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /unchanged since [0-9a-f]{7}/);
});

test('the copy shape and install-links are enforced', (t) => {
  const root = fixture(t);
  setLockEntry(root, () => ({ resolved: '../shared/pkg', link: true }));
  let r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /installs @drill\/pkg as a link, expected a copy resolved file:\.\.\/shared\/pkg/);
  assert.doesNotMatch(r.output, /Bump the version/);

  setLockEntry(root, () => ({ version: '1.0.0', resolved: SPEC }));
  fs.writeFileSync(path.join(root, 'app/.npmrc'), 'install-links=false\n');
  r = check(root);
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /app\/\.npmrc lacks install-links=true/);

  fs.rmSync(path.join(root, 'app/.npmrc'));
  assert.equal(check(root).status, 1);
});

test('without full history the drift check is skipped unless required', (t) => {
  const plain = fixture(t, { repo: false });
  changeContent(plain);
  let r = check(plain);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /drift check skipped: /);
  r = check(plain, '--require-history');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /drift check needs full git history/);

  // A depth-1 clone is only shallow when history was actually cut, hence two commits.
  const origin = fixture(t);
  setVersion(origin, '1.0.1');
  setLockEntry(origin, (entry) => ({ ...entry, version: '1.0.1' }));
  commit(origin, 'bump');
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-hub-shared-pkg-shallow-'));
  t.after(() => { fs.rmSync(shallow, { recursive: true, force: true }); });
  git(os.tmpdir(), 'clone', '--quiet', '--depth', '1', pathToFileURL(origin).href, shallow);
  r = check(shallow);
  assert.equal(r.status, 0, r.output);
  assert.match(r.output, /drift check skipped: shallow clone/);
  r = check(shallow, '--require-history');
  assert.equal(r.status, 1, r.output);
  assert.match(r.output, /needs full git history \(shallow clone\)/);
});
