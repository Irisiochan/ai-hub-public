#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = path.join(root, 'THIRD_PARTY_NOTICES.md');
const checkOnly = process.argv.includes('--check');

const surfaces = [
  ['server/package-lock.json', 'Gateway / Docker'],
  ['web/package-lock.json', 'Web UI'],
  ['desktop/package-lock.json', 'Desktop'],
  ['mobile/package-lock.json', 'Android'],
];

// npm lockfiles omit license metadata for these bundled packages. The values
// below are reviewed against the package metadata shipped by npm.
const licenseOverrides = new Map([
  ['busboy@1.6.0', 'MIT'],
  ['streamsearch@1.1.0', 'MIT'],
]);

const blockedLicense = /(?:^|[^A-Z])(A?GPL|LGPL|SSPL|BUSL)(?:[^A-Z]|$)|SEE LICENSE|UNLICENSED|UNKNOWN|CUSTOM/i;
const components = new Map();

function packageNameFromPath(packagePath) {
  const marker = 'node_modules/';
  const suffix = packagePath.slice(packagePath.lastIndexOf(marker) + marker.length);
  const parts = suffix.split('/');
  return suffix.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

for (const [relativeLock, surface] of surfaces) {
  const lockPath = path.join(root, relativeLock);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (!lock.packages || typeof lock.packages !== 'object') {
    throw new Error(`${relativeLock} does not contain a package-lock packages map`);
  }

  for (const [packagePath, entry] of Object.entries(lock.packages)) {
    if (!packagePath.includes('node_modules/')) continue;
    const name = packageNameFromPath(packagePath);
    if (!name || name.startsWith('@ai-hub/')) continue;
    const version = String(entry.version ?? '').trim();
    if (!version) throw new Error(`${relativeLock}: ${packagePath} has no version`);
    const key = `${name}@${version}`;
    const license = String(entry.license ?? licenseOverrides.get(key) ?? '').trim();
    if (!license) throw new Error(`${relativeLock}: ${key} has no license metadata or reviewed override`);
    if (blockedLicense.test(license)) {
      throw new Error(`${relativeLock}: ${key} uses review-blocked license ${license}`);
    }

    const existing = components.get(key) ?? {
      name,
      version,
      license,
      surfaces: new Set(),
      runtime: false,
    };
    if (existing.license !== license) {
      throw new Error(`${key} has conflicting licenses: ${existing.license} / ${license}`);
    }
    existing.surfaces.add(surface);
    if (entry.dev !== true && entry.devOptional !== true) existing.runtime = true;
    components.set(key, existing);
  }
}

const ordered = [...components.values()].sort((a, b) =>
  a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'),
);
const licenseCounts = new Map();
for (const component of ordered) {
  licenseCounts.set(component.license, (licenseCounts.get(component.license) ?? 0) + 1);
}

const lines = [
  '# Third-Party Notices',
  '',
  'This file is generated from the tracked npm lockfiles for the AI Hub gateway/Docker image,',
  'web UI, Electron desktop shell, and Capacitor Android shell. Do not edit it by hand; run',
  '`npm run notices` and commit the result.',
  '',
  'The list intentionally includes build-time packages as well as runtime packages so release',
  'tooling is not under-reported. Platform runtimes such as Electron/Chromium/Node and Android',
  'also ship their own upstream notices; those notices remain authoritative for the native',
  'binaries produced by their toolchains.',
  '',
  'AI Hub itself is licensed under the repository MIT license. Every component below remains',
  'subject to its own license; package names and versions come from the lockfiles.',
  '',
  `Generated component versions: **${ordered.length}**.`,
  '',
  '## License summary',
  '',
  '| SPDX/license expression | Component versions |',
  '|---|---:|',
  ...[...licenseCounts.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'en'))
    .map(([license, count]) => `| ${license.replaceAll('|', '\\|')} | ${count} |`),
  '',
  '## Components',
  '',
  '| Package | Version | License | Surfaces | Scope |',
  '|---|---:|---|---|---|',
  ...ordered.map((component) => {
    const encoded = encodeURIComponent(component.name);
    const link = `https://www.npmjs.com/package/${encoded}/v/${component.version}`;
    const surfaceList = [...component.surfaces].sort().join(', ');
    const scope = component.runtime ? 'runtime' : 'build/dev';
    return `| [${component.name}](${link}) | ${component.version} | ${component.license.replaceAll('|', '\\|')} | ${surfaceList} | ${scope} |`;
  }),
  '',
];

const generated = lines.join('\n');
if (checkOnly) {
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '';
  if (current !== generated) {
    console.error('THIRD_PARTY_NOTICES.md is stale; run npm run notices');
    process.exit(1);
  }
  console.log(`third-party notices: current (${ordered.length} component versions)`);
} else {
  fs.writeFileSync(outputPath, generated, 'utf8');
  console.log(`third-party notices: wrote ${ordered.length} component versions`);
}
