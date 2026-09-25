import assert from 'node:assert/strict';
import {
  resolveTurnTimeouts,
  timeoutTurnEvent,
  TurnTimeoutController,
  type TurnTimeoutKind,
} from '../src/backends/turnTimeouts.js';
import { interruptionDisplayText } from '../src/backends/turnInterruption.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

assert.deepEqual(resolveTurnTimeouts({}), { idleTimeoutMs: 300_000, hardTimeoutMs: 900_000 });
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
assert.equal(timeoutTurnEvent('hard').reason, 'turn-hard-timeout');
assert.equal(timeoutTurnEvent('hard').message, '这轮达到最长时间，已打断');
assert.equal(timeoutTurnEvent('idle').reason, 'turn-idle-timeout');
assert.equal(timeoutTurnEvent('idle').message, '这轮空闲超时了，已打断');
// 面板读的是 meta.interruptionReason，两种超时必须各自成句，不能再退回笼统文案
assert.equal(interruptionDisplayText('turn-idle-timeout', 'fallback'), '这轮空闲超时了，已打断');
assert.equal(interruptionDisplayText('turn-hard-timeout', 'fallback'), '这轮达到最长时间，已打断');
// 2026-09-16 之前落库的历史行仍按老文案渲染
assert.equal(interruptionDisplayText('turn-timeout', 'fallback'), '这轮超时了，已打断');
hard.finish();

console.log('turn timeout smoke: ok');
