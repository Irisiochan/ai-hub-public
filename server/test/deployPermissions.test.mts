import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const updateScript = fs.readFileSync(
  fileURLToPath(new URL('../../deploy/update.sh', import.meta.url)),
  'utf8'
);

assert.match(
  updateScript,
  /chmod -R a\+rX server\/agents server\/migrations worker shared\/coordination-keys/,
  'runtime-read agents, migrations, worker and shared coordination keys must be readable after deploy with UMask=0077'
);

assert.match(
  updateScript,
  /write_deploy_receipt/,
  'successful one-click deployments must emit a local deployment receipt for delivery reconciliation'
);

console.log('deploy runtime input permission check passed');
