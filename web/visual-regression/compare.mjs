import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((value) => value.startsWith('--' + name + '='))?.slice(name.length + 3);
const baseline = path.resolve(root, arg('baseline') ?? 'visual-regression/baseline');
const actual = path.resolve(root, arg('actual') ?? 'visual-regression/actual');
const files = readdirSync(baseline).filter((file) => file.endsWith('.png')).sort();
if (files.length === 0) throw new Error('No PNG baselines found in ' + baseline);

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');
const differences = [];
for (const file of files) {
  const expected = readFileSync(path.join(baseline, file));
  let observed;
  try {
    observed = readFileSync(path.join(actual, file));
  } catch {
    differences.push({ file, reason: 'missing actual screenshot' });
    continue;
  }
  if (!expected.equals(observed)) differences.push({ file, expected: hash(expected), actual: hash(observed) });
}

console.log(JSON.stringify({
  total: files.length,
  identical: files.length - differences.length,
  different: differences.length,
  differences,
}, null, 2));
if (differences.length > 0) process.exitCode = 1;
