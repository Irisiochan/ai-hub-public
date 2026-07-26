#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = path.resolve(serverDir, '..');
const webDist = path.resolve(process.env.HUB_WEB_DIST || path.join(repoDir, 'web/dist'));
const releasesDir = path.resolve(
  process.env.HUB_RELEASES_DIR
    || (process.platform === 'linux' ? '/var/lib/ai-hub/releases' : path.join(serverDir, 'data/releases')),
);
const latestPath = path.join(releasesDir, 'latest.json');

function git(...args) {
  return execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' }).trim();
}

function walk(dir, prefix = '') {
  const entries = {};
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(dir, item.name);
    const relative = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) Object.assign(entries, walk(absolute, relative));
    else if (item.isFile()) {
      entries[relative] = [
        new Uint8Array(fs.readFileSync(absolute)),
        { mtime: new Date('1980-01-02T12:00:00.000Z') },
      ];
    }
  }
  return entries;
}

function readPrevious() {
  try {
    return JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function atomicJson(file, value) {
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

if (!fs.existsSync(path.join(webDist, 'index.html'))) {
  throw new Error(`Web build is missing: ${path.join(webDist, 'index.html')}`);
}

fs.mkdirSync(releasesDir, { recursive: true });
const previous = readPrevious();
const webVersion = process.env.AI_HUB_WEB_VERSION || git('rev-parse', '--short=12', 'HEAD');
const bundleName = `web-${webVersion}.zip`;
const bundlePath = path.join(releasesDir, bundleName);
const zipped = Buffer.from(zipSync(walk(webDist), { level: 9 }));
const bundleSha256 = sha256(zipped);

if (fs.existsSync(bundlePath)) {
  const existingSha = sha256(fs.readFileSync(bundlePath));
  if (existingSha !== bundleSha256) {
    throw new Error(`${bundleName} already exists with different content; use a new webVersion`);
  }
} else {
  const tempBundle = `${bundlePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempBundle, zipped);
  fs.renameSync(tempBundle, bundlePath);
}

const mobilePackage = JSON.parse(fs.readFileSync(path.join(repoDir, 'mobile/package.json'), 'utf8'));
const manifest = {
  webVersion,
  nativeVersion: previous.nativeVersion || mobilePackage.version,
  minNativeVersion: process.env.AI_HUB_MIN_NATIVE_VERSION || previous.minNativeVersion || '0.1.0',
  webBundleUrl: `/releases/${bundleName}`,
  webBundleSha256: bundleSha256,
  apkUrl: previous.apkUrl || '',
  apkSha256: previous.apkSha256 || '',
  releaseNotes: process.env.AI_HUB_RELEASE_NOTES || git('log', '-1', '--pretty=%s'),
  publishedAt: new Date().toISOString(),
};
atomicJson(latestPath, manifest);

const webBundles = fs.readdirSync(releasesDir)
  .filter((name) => /^web-[a-zA-Z0-9._-]+\.zip$/.test(name))
  .filter((name) => name !== bundleName)
  .map((name) => ({ name, mtime: fs.statSync(path.join(releasesDir, name)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const stale of webBundles.slice(1)) fs.unlinkSync(path.join(releasesDir, stale.name));

console.log(JSON.stringify({
  ok: true,
  latestPath,
  bundlePath,
  ...manifest,
}, null, 2));
