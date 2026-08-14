import assert from 'node:assert/strict';
import { CodexAppServerBackend } from '../src/agents/codexAppServer.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function identifyCompactTurn(instance: any, turnId: string): void {
  instance.handleNotification('turn/started', {
    threadId: 'thread-native-compact',
    turn: { id: turnId },
  });
}

function backend(
  options: { enabled?: boolean; inputTokens?: number } | undefined = { enabled: true, inputTokens: 100 },
  turnTimeoutMs = 5_000,
) {
  const logs: string[] = [];
  const instance = new CodexAppServerBackend({
    cliPath: 'codex',
    cwd: process.cwd(),
    nativeCompact: options,
    turnTimeoutMs,
    log: (message) => logs.push(message),
  }) as any;
  instance.threadId = 'thread-native-compact';
  return { instance, logs };
}

{
  const { instance, logs } = backend();
  const requests: { method: string; params: any }[] = [];
  const turnEvents: any[] = [];
  instance.request = async (method: string, params: any) => {
    requests.push({ method, params });
    return {};
  };
  instance.turnId = 'turn-before-compact';
  instance.userTurnStartRequested = true;
  instance.turn = {
    push: (event: any) => turnEvents.push(event),
    end: () => {},
  };

  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-before-compact',
    tokenUsage: { last: { inputTokens: 99, cachedInputTokens: 90, outputTokens: 5 } },
  });
  assert.equal(requests.length, 0, 'usage below the configured threshold stays idle');

  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-before-compact',
    tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 5 } },
  });
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-before-compact',
    tokenUsage: { last: { inputTokens: 150, cachedInputTokens: 140, outputTokens: 5 } },
  });
  assert.equal(requests.length, 0, 'compaction is queued while a turn is active');
  assert.equal(instance.lastTokenUsage.input, 10, 'reported usage still excludes cached input for billing display');

  instance.handleNotification('turn/completed', {
    turn: { id: 'turn-before-compact', status: 'completed' },
  });
  await tick();
  assert.deepEqual(requests, [{
    method: 'thread/compact/start',
    params: { threadId: 'thread-native-compact' },
  }]);
  assert.ok(turnEvents.some((event) => event.type === 'done'));

  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-before-compact',
    tokenUsage: { last: { inputTokens: 160, cachedInputTokens: 150, outputTokens: 5 } },
  });
  assert.equal(requests.length, 1, 'one threshold crossing cannot re-enter before completion');
  const eventCountBeforeNotification = turnEvents.length;
  identifyCompactTurn(instance, 'compact-turn-1');
  instance.handleNotification('thread/compacted', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-1',
  });
  assert.equal(instance.compactInFlight, false);
  assert.equal(turnEvents.length, eventCountBeforeNotification, 'protocol completion does not leak into chat events');
  assert.match(logs.join('\n'), /native compact completed thread=thread-nativ turn=compact-turn/);

  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-1',
    tokenUsage: { last: { inputTokens: 160, cachedInputTokens: 150, outputTokens: 5 } },
  });
  await tick();
  assert.equal(requests.length, 1, 'the compact turn own high usage cannot trigger compaction again');
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-after-compact-low',
    tokenUsage: { last: { inputTokens: 99, cachedInputTokens: 90, outputTokens: 5 } },
  });
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-after-compact-high',
    tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 5 } },
  });
  await tick();
  assert.equal(requests.length, 2, 'a later below-to-above crossing permits the next compaction');
  identifyCompactTurn(instance, 'compact-turn-2');
  instance.handleNotification('thread/compacted', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-2',
  });
}

{
  const { instance, logs } = backend();
  let requests = 0;
  instance.request = async () => { requests++; return {}; };
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-item-completion',
    tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 } },
  });
  await tick();
  identifyCompactTurn(instance, 'compact-turn-item');
  instance.handleNotification('item/completed', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-item',
    item: { id: 'compact-item-1', type: 'contextCompaction' },
  });
  assert.equal(requests, 1);
  assert.equal(instance.compactInFlight, false, 'the current ContextCompaction item also releases the guard');
  assert.match(logs.join('\n'), /via=contextCompaction item/);
}

{
  const { instance, logs } = backend();
  let requests = 0;
  instance.request = async () => { requests++; return {}; };
  const usage = (inputTokens: number) => instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    tokenUsage: { last: { inputTokens, cachedInputTokens: 0, outputTokens: 0 } },
  });

  usage(100);
  await tick();
  identifyCompactTurn(instance, 'compact-turn-old');
  instance.settleNativeCompact();
  usage(99);
  usage(100);
  await tick();
  identifyCompactTurn(instance, 'compact-turn-current');
  assert.equal(requests, 2);

  instance.handleNotification('thread/compacted', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-old',
  });
  assert.equal(instance.compactInFlight, true, 'a late completion cannot settle a newer compact barrier');
  assert.match(logs.join('\n'), /native compact ignored unmatched completion/);

  instance.handleNotification('thread/compacted', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-current',
  });
  assert.equal(instance.compactInFlight, false);
}

{
  const { instance, logs } = backend();
  let attempts = 0;
  instance.request = async () => {
    attempts++;
    throw new Error('synthetic compact failure');
  };
  const usage = (inputTokens: number) => instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-failure',
    tokenUsage: { last: { inputTokens, cachedInputTokens: 0, outputTokens: 0 } },
  });

  usage(100);
  await tick();
  assert.equal(attempts, 1);
  assert.equal(instance.compactInFlight, false);
  assert.match(logs.join('\n'), /native compact failed .*synthetic compact failure/);
  usage(101);
  await tick();
  assert.equal(attempts, 1, 'a failed crossing is not retried while usage remains over threshold');
  usage(99);
  usage(100);
  await tick();
  assert.equal(attempts, 2, 'dropping below and crossing again permits one later attempt');
}

{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled: { callback: () => void; delay: number }[] = [];
  let timerId = 0;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
    scheduled.push({ callback: () => callback(), delay: Number(delay ?? 0) });
    return ++timerId as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    const { instance } = backend({ enabled: true, inputTokens: 100 }, 5_000);
    instance.request = async () => ({});
    instance.handleNotification('thread/tokenUsage/updated', {
      threadId: 'thread-native-compact',
      turnId: 'turn-minimum-timeout',
      tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 } },
    });
    await tick();
    assert.equal(scheduled[0]?.delay, 120_000, 'completion wait keeps the 120s floor below turn timeout');
    instance.settleNativeCompact();
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduled: { callback: () => void; delay: number }[] = [];
  let timerId = 0;
  globalThis.setTimeout = ((callback: (...args: any[]) => void, delay?: number) => {
    scheduled.push({ callback: () => callback(), delay: Number(delay ?? 0) });
    return ++timerId as unknown as NodeJS.Timeout;
  }) as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout;
  try {
    const { instance, logs } = backend({ enabled: true, inputTokens: 100 }, 300_000);
    const requests: { method: string; timeoutMs: number | undefined }[] = [];
    instance.request = async (method: string, _params: any, timeoutMs?: number) => {
      requests.push({ method, timeoutMs });
      return {};
    };
    instance.handleNotification('thread/tokenUsage/updated', {
      threadId: 'thread-native-compact',
      turnId: 'turn-timeout',
      tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 } },
    });
    await tick();
    assert.deepEqual(requests, [{ method: 'thread/compact/start', timeoutMs: 30_000 }]);
    assert.equal(scheduled[0]?.delay, 300_000, 'completion wait follows the longer configured turn timeout');
    assert.ok(scheduled[0]!.delay > requests[0]!.timeoutMs!, 'completion wait is clearly longer than start ack');

    scheduled[0]!.callback();
    assert.equal(instance.compactInFlight, false, 'completion timeout releases the in-flight guard');
    assert.equal(instance.compactBarrier, null, 'completion timeout cannot leave the turn barrier stuck');
    assert.match(logs.join('\n'), /native compact completion timed out/);

    instance.request = async (method: string) => {
      assert.equal(method, 'turn/start');
      throw new Error('activeTurnNotSteerable');
    };
    await assert.rejects(
      instance.beginTurnAfterCompaction('do not lose this message'),
      /当前消息未发送，请稍后重试/,
    );
    assert.equal(instance.userTurnStartRequested, false, 'a rejected start does not accept compact notifications as chat output');
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}

{
  const { instance } = backend({ enabled: false, inputTokens: 100 });
  let requests = 0;
  instance.request = async () => { requests++; return {}; };
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-disabled',
    tokenUsage: { last: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 0 } },
  });
  await tick();
  assert.equal(requests, 0, 'the gateway config switch disables native compaction');
}

{
  const { instance } = backend(undefined);
  let requests = 0;
  instance.request = async () => { requests++; return {}; };
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-defaults',
    tokenUsage: { last: { inputTokens: 200_000, cachedInputTokens: 0, outputTokens: 0 } },
  });
  await tick();
  assert.equal(requests, 1, 'native compaction defaults on at the conservative 200k threshold');
  identifyCompactTurn(instance, 'compact-defaults');
  instance.handleNotification('thread/compacted', {
    threadId: 'thread-native-compact', turnId: 'compact-defaults',
  });
}

{
  const { instance } = backend();
  const methods: string[] = [];
  instance.request = async (method: string) => {
    methods.push(method);
    return method === 'turn/start' ? { turn: { id: 'turn-after-compact' } } : {};
  };
  instance.handleNotification('thread/tokenUsage/updated', {
    threadId: 'thread-native-compact',
    turnId: 'turn-trigger',
    tokenUsage: { last: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0 } },
  });
  await tick();
  instance.sendTurn({ text: 'wait for compact', userMessageId: 1 });
  await tick();
  assert.deepEqual(methods, ['thread/compact/start'], 'the next turn waits behind in-flight compaction');
  identifyCompactTurn(instance, 'compact-turn-2');
  instance.handleNotification('turn/completed', {
    turn: { id: 'compact-turn-2', status: 'completed' },
  });
  assert.ok(instance.turn, 'the compaction turn completion must not finish the queued chat turn');
  instance.handleNotification('thread/compacted', {
    threadId: 'thread-native-compact',
    turnId: 'compact-turn-2',
  });
  await tick();
  assert.deepEqual(methods, ['thread/compact/start', 'turn/start']);
  instance.finishTurn();
}

console.log('[PASS] Codex native compact threshold, latch, split timeouts, completion, failure, and turn barrier');
