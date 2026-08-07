import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveDeliverySummary } from '../src/workers/deliveryStatus.js';

const job = (overrides: Record<string, unknown> = {}) => ({
  status: 'done',
  delivery_state: 'delivered',
  delivery_meta: JSON.stringify({}),
  permissions: JSON.stringify({ write: true }),
  result: 'ok',
  error: null,
  ...overrides,
});

test('active work has one human conclusion and one next owner', () => {
  const value = deriveDeliverySummary(job({ status: 'running', delivery_state: null }) as never);
  assert.equal(value.state, 'in_progress');
  assert.equal(value.nextOwner, 'PC Worker');
});

test('local and unpushed work are completed but not delivered', () => {
  assert.equal(
    deriveDeliverySummary(job({ status: 'blocked', delivery_state: 'blocked_local_changes' }) as never).state,
    'completed_not_delivered',
  );
  assert.equal(
    deriveDeliverySummary(job({ status: 'blocked', delivery_state: 'blocked_unpushed' }) as never).label,
    '已提交，尚未推送',
  );
});

test('write delivery remains waiting for deploy without post-deploy evidence', () => {
  const value = deriveDeliverySummary(job() as never);
  assert.equal(value.state, 'delivered_waiting_deploy');
  assert.match(value.label, /未收到部署证据/);
});

test('declared production stages override the conservative delivery default', () => {
  const value = deriveDeliverySummary(job({
    delivery_meta: JSON.stringify({
      declared: {
        stage: 'online_waiting_validation',
        summary: '新版本已经上线，等待真实入口验收。',
        nextOwner: 'Codex',
      },
    }),
  }) as never);
  assert.equal(value.state, 'online_waiting_validation');
  assert.equal(value.summary, '新版本已经上线，等待真实入口验收。');
  assert.equal(value.nextOwner, 'Codex');
});

test('read-only delivery closes while explicit decisions stay open', () => {
  assert.equal(
    deriveDeliverySummary(job({ permissions: JSON.stringify({ write: false }) }) as never).state,
    'closed_loop',
  );
  const decision = deriveDeliverySummary(job({
    delivery_meta: JSON.stringify({
      declared: { stage: 'user_decision', nextOwner: 'User' },
    }),
  }) as never);
  assert.equal(decision.state, 'user_decision');
  assert.equal(decision.needsUserDecision, true);
});

test('unchanged synchronized git evidence closes a historically writable read-only job', () => {
  const value = deriveDeliverySummary(job({
    delivery_meta: JSON.stringify({ changed: false, ahead: 0, head: 'abc1234', source: 'git' }),
  }) as never);
  assert.equal(value.state, 'closed_loop');
  assert.match(value.summary, /未产生代码变更/);
});

test('human rework conclusion is explicit and terminal', () => {
  const value = deriveDeliverySummary(job({
    delivery_meta: JSON.stringify({ declared: { stage: 'rework_required' } }),
  }) as never);
  assert.equal(value.state, 'rework_required');
  assert.equal(value.label, '需要返工');
});

test('failures never look delivered', () => {
  const value = deriveDeliverySummary(job({ status: 'failed', delivery_state: 'failed_clean' }) as never);
  assert.equal(value.state, 'failure_or_blocked');
});
