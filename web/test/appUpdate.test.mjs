import assert from 'node:assert/strict';
import { writeWebBundle } from '../src/appUpdateBundle.ts';

const calls = [];
const directories = new Set();
const filesystem = {
  async mkdir({ path, recursive }) {
    assert.equal(recursive, true);
    assert.equal(calls.some((call) => call.startsWith('write:')), false);
    directories.add(path);
    calls.push(`mkdir:${path}`);
  },
  async writeFile({ path, recursive }) {
    const parent = path.split('/').slice(0, -1).join('/');
    assert.ok(directories.has(parent), `write started before parent existed: ${path}`);
    assert.equal(recursive, undefined);
    calls.push(`write:${path}`);
    return { uri: `file://${path}` };
  },
};

await writeWebBundle({
  'index.html': new Uint8Array([1]),
  'assets/app.js': new Uint8Array([2]),
  'assets/app.css': new Uint8Array([3]),
  'assets/chunks/vendor.js': new Uint8Array([4]),
}, 'updates/web-next', filesystem);

assert.deepEqual(
  calls.filter((call) => call.startsWith('mkdir:')),
  [
    'mkdir:updates/web-next',
    'mkdir:updates/web-next/assets',
    'mkdir:updates/web-next/assets/chunks',
  ],
);
assert.equal(calls.filter((call) => call.startsWith('write:')).length, 4);

console.log('appUpdate directory creation: ok');
