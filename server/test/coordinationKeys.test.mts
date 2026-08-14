import assert from 'node:assert/strict';
import {
  executionDispatchKey,
  executionFingerprint,
  legacyExecutionDispatchKey,
  legacyVerificationDispatchKey,
  verificationDispatchKey,
} from '../src/workers/coordinationKeys.js';
import {
  coordinationMarkerDispatchKey,
  parseCoordinationMarker,
} from '../src/workers/coordinationReceipt.js';
// @ts-expect-error 跨包导入 worker 的 ESM 实现，仅用于 parity 校验
import * as triageCore from '../../worker/triage-core.mjs';

const executionSamples = [
  {
    taskPath: 'tasks/demo.md',
    planHash: 'a'.repeat(64),
    executor: 'codex',
    workspace: 'C:/ai-hub-codex',
    branch: 'coordination-demo',
  },
  {
    taskPath: 'tasks/other.md',
    planHash: 'b'.repeat(64),
    executor: ' Aye ',
    workspace: 'c:\\ai-hub-codex\\',
    branch: 'claude/some-branch',
  },
  {
    taskPath: 'tasks/linux.md',
    planHash: 'c'.repeat(64),
    executor: 'claude',
    workspace: '/opt/Repo/ai-hub',
    branch: 'fix/thing',
  },
];

// 同一套规范化算法：server TS 实现与 worker mjs 实现必须逐字节一致
for (const sample of executionSamples) {
  assert.equal(
    executionFingerprint(sample),
    triageCore.executionFingerprint(sample),
    `execution fingerprint parity failed for ${sample.taskPath}`
  );
  assert.equal(executionDispatchKey(sample), triageCore.executionDispatchKey(sample));
  assert.equal(legacyExecutionDispatchKey(sample), triageCore.legacyExecutionDispatchKey(sample));
}
const verificationSample = { taskPath: 'tasks/demo.md', due: '2026-08-14', verifier: 'Aye' };
assert.equal(
  verificationDispatchKey(verificationSample),
  triageCore.verificationDispatchKey(verificationSample)
);
assert.equal(
  legacyVerificationDispatchKey(verificationSample),
  triageCore.legacyVerificationDispatchKey(verificationSample)
);

// fingerprint 覆盖改派语义：Plan 不变、只改 executor 也必须换 key
const base = executionSamples[0];
assert.notEqual(
  executionFingerprint({ ...base, executor: 'aye' }),
  executionFingerprint(base)
);
assert.equal(
  executionFingerprint({ ...base, workspace: 'c:\\ai-hub-codex\\' }),
  executionFingerprint(base),
  'workspace canonicalization must ignore slash direction and Windows case'
);

// marker 解析：V1（无 fingerprint）与 V2（含 fingerprint）都要接受
const planHash = 'a'.repeat(64);
const fingerprint = executionFingerprint(base);
const v1Prompt = [
  '[AI_HUB_COORDINATION_V1]',
  'taskPath=tasks/demo.md',
  `planHash=${planHash}`,
  '只执行任务文件 Plan。',
].join('\n');
const v2Prompt = [
  '[AI_HUB_COORDINATION_V2]',
  'taskPath=tasks/demo.md',
  `planHash=${planHash}`,
  `fingerprint=${fingerprint}`,
  '只执行任务文件 Plan。',
].join('\n');
const v1Marker = parseCoordinationMarker(v1Prompt);
assert.deepEqual(v1Marker, { taskPath: 'tasks/demo.md', planHash });
const v2Marker = parseCoordinationMarker(v2Prompt);
assert.deepEqual(v2Marker, { taskPath: 'tasks/demo.md', planHash, fingerprint });
assert.equal(parseCoordinationMarker(v2Prompt.replace(`fingerprint=${fingerprint}`, 'fingerprint=bad')), null);
assert.equal(parseCoordinationMarker(v2Prompt.replace(/^fingerprint=.*$/m, '')), null);
assert.equal(parseCoordinationMarker(v1Prompt.replace(planHash, 'bad')), null);

// 回执 dispatch key 必须与派单时的 idempotencyKey 完全一致
assert.equal(
  coordinationMarkerDispatchKey(v1Marker!),
  `coordination:tasks/demo.md:${planHash}`
);
assert.equal(
  coordinationMarkerDispatchKey(v2Marker!),
  `coordination:v2:tasks/demo.md:${fingerprint}`
);

console.log('coordination keys tests: ok');
