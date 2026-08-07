import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const updateScript = fs.readFileSync(
  fileURLToPath(new URL('../../deploy/update.sh', import.meta.url)),
  'utf8'
);

assert.match(
  updateScript,
  /chmod -R a\+rX server\/agents server\/migrations worker/,
  'runtime-read agents, migrations and worker sources must be readable after the deploy unit pulls them with UMask=0077'
);

assert.match(
  updateScript,
  /write_deploy_receipt/,
  'successful one-click deployments must emit a local deployment receipt for delivery reconciliation'
);

console.log('deploy runtime input permission check passed');
