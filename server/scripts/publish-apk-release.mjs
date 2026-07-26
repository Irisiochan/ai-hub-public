#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);

const source = args.get('--source');
const version = args.get('--version');
const expectedSha = args.get('--sha256');
const releasesDir = path.resolve(
  args.get('--release-dir')
    || process.env.HUB_RELEASES_DIR
    || (process.platform === 'linux' ? '/var/lib/ai-hub/releases' : path.join(serverDir, 'data/releases')),
);

if (!source || !version || !expectedSha) {
  throw new Error('Usage: publish-apk-release.mjs --source <apk> --version <version> --sha256 <64 hex> [--release-dir <dir>]');
}
if (!/^[0-9A-Za-z._-]+$/.test(version) || !/^[a-f0-9]{64}$/i.test(expectedSha)) {
  throw new Error('Invalid version or sha256.');
}

const data = fs.readFileSync(source);
const actualSha = crypto.createHash('sha256').update(data).digest('hex');
if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
  throw new Error(`APK SHA-256 mismatch: expected ${expectedSha}, got ${actualSha}`);
}

fs.mkdirSync(releasesDir, { recursive: true });
const latestPath = path.join(releasesDir, 'latest.json');
const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
const name = `ai-hub-${version}.apk`;
const destination = path.join(releasesDir, name);
const tempApk = `${destination}.tmp-${process.pid}`;
fs.writeFileSync(tempApk, data, { mode: 0o644 });
fs.renameSync(tempApk, destination);

const next = {
  ...latest,
  nativeVersion: version,
  apkUrl: `/releases/${name}`,
  apkSha256: actualSha,
  publishedAt: new Date().toISOString(),
};
const tempManifest = `${latestPath}.tmp-${process.pid}`;
fs.writeFileSync(tempManifest, `${JSON.stringify(next, null, 2)}\n`);
fs.renameSync(tempManifest, latestPath);

const apks = fs.readdirSync(releasesDir)
  .filter((file) => /^ai-hub-[0-9A-Za-z._-]+\.apk$/.test(file) && file !== name)
  .map((file) => ({ file, mtime: fs.statSync(path.join(releasesDir, file)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const stale of apks.slice(1)) fs.unlinkSync(path.join(releasesDir, stale.file));

console.log(JSON.stringify({ ok: true, destination, ...next }, null, 2));
