import assert from 'node:assert/strict';
import { detectTrigger, maybeCapture, type CaptureReviewer } from '../src/memory/capture.js';
import { captureEvalCases, dirtyHubAutoCases, trueTaskCases } from './capture-eval-cases.js';

type Write = { tool: string; args: Record<string, unknown> };
function makeVault() {
  const writes: Write[] = [];
  return {
    writes,
    vault: {
      write: async (tool: string, args: Record<string, unknown>) => {
        writes.push({ tool, args });
        return 'ok' as const;
      },
    },
  };
}

const captureReviewer: CaptureReviewer = async () => ({
  decision: 'capture',
  confidence: 0.92,
  category: 'commitment',
  subject: 'eval',
  due: null,
  isCommitment: true,
});

const rejectReviewer: CaptureReviewer = async () => ({
  decision: 'reject',
  confidence: 0.04,
  category: 'other',
  subject: null,
  due: null,
  isCommitment: false,
});

console.log('=== hub-auto capture regression corpus ===');
console.log(`dirty hub-auto samples: ${dirtyHubAutoCases.length}`);
console.log(`true task samples: ${trueTaskCases.length}`);

assert.equal(dirtyHubAutoCases.length, 5);
assert.equal(trueTaskCases.length, 2);

let failures = 0;
for (const item of captureEvalCases) {
  const trigger = detectTrigger(item.text);
  const { writes, vault } = makeVault();
  await maybeCapture(
    vault as never,
    { id: `eval-${item.id}`, name: item.contactName },
    item.text,
    '',
    () => {},
    item.expected === 'capture' ? captureReviewer : rejectReviewer
  );
  const captured = writes.length > 0;
  const ok = item.expected === 'capture' ? captured : !captured;
  if (!ok) failures++;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${item.id}`);
  console.log(`  expected=${item.expected} trigger=${trigger ?? 'null'} writes=${writes.length}`);
  console.log(`  source=${item.source}`);
  console.log(`  note=${item.note}`);
}

if (failures > 0) {
  console.error(`capture eval failed: ${failures} case(s)`);
  process.exit(1);
}
console.log('capture eval: ok');
