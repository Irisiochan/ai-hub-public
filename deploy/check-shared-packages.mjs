#!/usr/bin/env node
// Version guard for the npm packages under shared/ (today only contact-config).
//
// server/, web/ and desktop/ install them as copies: `file:../shared/<pkg>` plus
// `.npmrc` install-links=true, lock entry `resolved: file:../shared/<pkg>` without
// `link: true`. npm keys such a copy by version alone, so while the version in a
// consumer's lock and node_modules stays put, `npm install` keeps the old copy however
// much shared/<pkg> changed. Changing it without a bump leaves every existing checkout
// on stale code while CI and the VPS (`npm ci`, fresh copies) stay green: 2026-09-24,
// five changes rode on contact-config 0.1.2 and local tsc failed on 'kimi-cli'.
//
// Fails, per shared package, when
//   1. a consumer lock records another version or lost the copy shape, or the consumer
//      has no install-links=true;
//   2. anything under shared/<pkg> differs from the commit that set the current version
//      (working tree included). That needs git history: skipped without it, a failure
//      under --require-history (CI checks out with fetch-depth: 0).
//
//   node deploy/check-shared-packages.mjs [--root <repo>] [--require-history]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const requireHistory = argv.includes('--require-history');
const rootFlag = argv.indexOf('--root');
const root = rootFlag >= 0
  ? path.resolve(argv[rootFlag + 1] ?? '')
  : fileURLToPath(new URL('..', import.meta.url));

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const lines = (text) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function git(...args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

function gitOrThrow(...args) {
  const out = git(...args);
  if (out === null) throw new Error(`git ${args.join(' ')} failed in ${root}`);
  return out;
}

/** Why the drift check cannot run here, or null when full history is available. */
function historyGap() {
  const prefix = git('rev-parse', '--show-prefix');
  if (prefix === null) return 'not a git checkout';
  if (prefix.trim() !== '') return `${root} is not the top of its checkout`;
  if (git('rev-parse', '--is-shallow-repository')?.trim() === 'true') return 'shallow clone';
  return null;
}

const sharedRoot = path.join(root, 'shared');
const packages = (fs.existsSync(sharedRoot) ? fs.readdirSync(sharedRoot, { withFileTypes: true }) : [])
  .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(sharedRoot, entry.name, 'package.json')))
  .map((entry) => {
    const dir = `shared/${entry.name}`;
    const { name, version } = readJson(path.join(root, dir, 'package.json'));
    return { dir, name, version };
  });

const consumerDirs = fs.readdirSync(root, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !['node_modules', 'shared'].includes(entry.name))
  .map((entry) => entry.name)
  .filter((dir) => fs.existsSync(path.join(root, dir, 'package.json')));

function consumersOf(pkg) {
  return consumerDirs.flatMap((dir) => {
    const manifest = readJson(path.join(root, dir, 'package.json'));
    const spec = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.optionalDependencies }[pkg.name];
    if (!spec?.startsWith('file:')) return [];
    return path.resolve(root, dir, spec.slice('file:'.length)) === path.resolve(root, pkg.dir) ? [{ dir, spec }] : [];
  });
}

function lockProblems(pkg, consumer) {
  const problems = [];
  const lockPath = `${consumer.dir}/package-lock.json`;
  const entry = fs.existsSync(path.join(root, lockPath))
    ? readJson(path.join(root, lockPath)).packages?.[`node_modules/${pkg.name}`]
    : undefined;
  if (!entry) {
    problems.push({ text: `${lockPath} has no node_modules/${pkg.name} entry` });
  } else if (entry.link || entry.resolved !== consumer.spec) {
    const shape = entry.link ? 'a link' : `resolved ${entry.resolved}`;
    problems.push({ text: `${lockPath} installs ${pkg.name} as ${shape}, expected a copy resolved ${consumer.spec}` });
  } else if (entry.version !== pkg.version) {
    problems.push({ text: `${lockPath} records ${pkg.name}@${entry.version}, ${pkg.dir} is ${pkg.version}`, bump: true });
  }
  const npmrc = path.join(root, consumer.dir, '.npmrc');
  if (!fs.existsSync(npmrc) || !/^\s*install-links\s*=\s*true\s*$/m.test(fs.readFileSync(npmrc, 'utf8'))) {
    problems.push({ text: `${consumer.dir}/.npmrc lacks install-links=true, so npm links ${pkg.dir} instead of copying it` });
  }
  return problems;
}

/** Oldest commit of the newest run of package.json revisions carrying the current version. */
function versionCommit(pkg) {
  const file = `${pkg.dir}/package.json`;
  let found = null;
  for (const sha of lines(gitOrThrow('log', '--format=%H', '--', file))) {
    let version;
    try {
      version = JSON.parse(git('show', `${sha}:${file}`)).version;
    } catch {
      version = undefined;
    }
    if (version !== pkg.version) break;
    found = sha;
  }
  return found;
}

const failures = [];
const gap = historyGap();
if (gap && requireHistory) {
  failures.push(`drift check needs full git history (${gap}); in CI check out with fetch-depth: 0`);
}
if (!packages.length) failures.push(`no shared/*/package.json under ${root}`);

for (const pkg of packages) {
  const consumers = consumersOf(pkg);
  const problems = consumers.flatMap((consumer) => lockProblems(pkg, consumer));
  let history;
  if (gap) {
    history = `drift check skipped: ${gap}`;
  } else {
    const since = versionCommit(pkg);
    const changed = since && [
      ...lines(gitOrThrow('diff', '--name-only', since, '--', pkg.dir)),
      ...lines(gitOrThrow('ls-files', '--others', '--exclude-standard', '--', pkg.dir)),
    ];
    if (!since) {
      history = `${pkg.version} not committed yet`;
    } else if (changed.length) {
      const where = gitOrThrow('log', '-1', '--format=%h %s', since).trim();
      problems.push({
        text: `${pkg.dir} changed since ${pkg.version} was set in ${where}:\n${changed.map((file) => `      ${file}`).join('\n')}`,
        bump: true,
      });
    } else {
      history = `unchanged since ${since.slice(0, 7)}`;
    }
  }

  const who = consumers.map((consumer) => consumer.dir).join(', ') || 'no consumers';
  if (!problems.length) {
    console.log(`ok   ${pkg.dir} ${pkg.version} (${who}; ${history})`);
    continue;
  }
  const lockCommands = consumers.map((consumer) =>
    `    npm install --package-lock-only --prefix ${consumer.dir} ${pkg.name}@${consumer.spec}`);
  failures.push([
    `${pkg.dir} ${pkg.version} (${who})`,
    ...problems.map((problem) => `  - ${problem.text}`),
    ...(problems.some((problem) => problem.bump) ? [
      '  Bump the version and record it in every consumer lock (a plain npm install keeps the old entry):',
      `    npm pkg set version=<next> --prefix ${pkg.dir}`,
      ...lockCommands,
      '  then `npm install --prefix <consumer>` swaps the stale copy in existing checkouts.',
    ] : []),
  ].join('\n'));
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
