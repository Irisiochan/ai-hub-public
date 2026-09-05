import assert from 'node:assert/strict';
import {
  resolveTurnTimeouts,
  timeoutTurnEvent,
  TurnTimeoutController,
  type TurnTimeoutKind,
} from '../src/agents/turnTimeouts.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

assert.deepEqual(resolveTurnTimeouts({}), { idleTimeoutMs: 120_000, hardTimeoutMs: 900_000 });
assert.deepEqual(
  resolveTurnTimeouts(
    { turnTimeoutMs: 300_000 },
    { turnTimeoutMs: 300_000 },
  ),
  { idleTimeoutMs: 120_000, hardTimeoutMs: 900_000 },
  'legacy turnTimeoutMs must not override the hard timeout default',
);
assert.deepEqual(
  resolveTurnTimeouts(
    { turnIdleTimeoutMs: 1_000, turnHardTimeoutMs: 2_000 },
    { turnIdleTimeoutMs: 3_000, turnHardTimeoutMs: 4_000 },
  ),
  { idleTimeoutMs: 3_000, hardTimeoutMs: 4_000 },
);

let firstTimeout: TurnTimeoutKind | null = null;
const idle = new TurnTimeoutController(
  { idleTimeoutMs: 60, hardTimeoutMs: 600 },
  (kind) => { firstTimeout = kind; },
);
idle.start();
for (const type of ['delta', 'thinking', 'tool_use', 'tool_result'] as const) {
  await sleep(40);
  idle.activity({ type });
}
await sleep(40);
assert.equal(firstTimeout, null, 'delta/thinking/tool_use/tool_result must each reset idle timeout');
await sleep(35);
assert.equal(firstTimeout, 'idle');
idle.finish();

let pulsedTimeout: TurnTimeoutKind | null = null;
const pulsed = new TurnTimeoutController(
  { idleTimeoutMs: 60, hardTimeoutMs: 600 },
  (kind) => { pulsedTimeout = kind; },
);
pulsed.start();
await sleep(40);
pulsed.pulse();
await sleep(40);
assert.equal(pulsedTimeout, null, 'pulse must reset idle timeout');
await sleep(35);
assert.equal(pulsedTimeout, 'idle');
pulsed.finish();

let hardTimeout: TurnTimeoutKind | null = null;
const hard = new TurnTimeoutController(
  { idleTimeoutMs: 55, hardTimeoutMs: 150 },
  (kind) => { hardTimeout = kind; },
);
hard.start();
const activity = setInterval(() => hard.activity({ type: 'tool_result' }), 30);
await sleep(185);
clearInterval(activity);
assert.equal(hardTimeout, 'hard', 'activity cannot extend the absolute hard cap');
assert.equal(timeoutTurnEvent('hard').reason, 'turn-timeout');
hard.finish();

console.log('turn timeout smoke: ok');
