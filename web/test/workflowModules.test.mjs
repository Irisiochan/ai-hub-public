import assert from 'node:assert/strict';
import { bindingForAgent, chooseEffort, isWorkflowRoom, validModuleBinding } from '../src/workflow/moduleBindings.ts';
import { createWorkerState } from '../src/jobs/workerState.ts';

const previous = { contactId: 'codex', runner: 'codex', model: 'astra', reasoning: 'ultra' };
const muse = { contactId: 'muse', name: 'Sora', runner: 'opencode', compatibleModules: ['execute'],
  models: [{ id: 'muse-1.3', label: 'Muse 1.3', efforts: ['high', 'max'] }] };
assert.deepEqual(bindingForAgent(muse, previous), {
  contactId: 'muse', runner: 'opencode', model: 'muse-1.3', reasoning: 'high',
}, 'explicit agent selection must not retain an unsupported ultra setting');
assert.equal(chooseEffort(['max'], 'high'), 'max');
assert.equal(chooseEffort([], 'high'), '');
assert.equal(validModuleBinding('execute', bindingForAgent(muse, previous), [muse]), true);
assert.equal(validModuleBinding('review', bindingForAgent(muse, previous), [muse]), false,
  'UI must not offer an executor-only adapter as an independent reviewer');
assert.equal(validModuleBinding('execute', { ...bindingForAgent(muse, previous), reasoning: 'ultra' }, [muse]), false);
assert.equal(validModuleBinding('execute', { ...bindingForAgent(muse, previous), runner: 'grok' }, [muse]), false);
assert.equal(isWorkflowRoom({ kind: 'room', config: { coordination: { orchestrator: 'codex' } } }), true);
assert.equal(isWorkflowRoom({ kind: 'room', config: { members: ['codex'], respondAllByDefault: true } }), false);
assert.equal(isWorkflowRoom({ kind: 'room', config: { workflowEnabled: false, coordination: {} } }), false);
assert.equal(isWorkflowRoom({ kind: 'dm', config: { workflowEnabled: true } }), false);

let finish;
const deferred = new Promise((resolve) => { finish = resolve; });
const client = { workflowModules: () => deferred };
const store = createWorkerState(client);
const read = store.refreshModules();
store.applyModules({ revision: 8, modules: [{ id: 'review', status: 'idle' }], jobs: [], agents: [], audit: [] });
finish({ revision: 7, modules: [{ id: 'review', status: 'blocked' }], jobs: [], agents: [], audit: [] });
await read;
assert.equal(store.getSnapshot().modules.revision, 8, 'old REST response cannot undo a just-saved binding');
store.applyModules({ revision: 7, modules: [], jobs: [], agents: [], audit: [] });
assert.equal(store.getSnapshot().modules.revision, 8, 'an older binding revision must never replace a newer one');

let finishLogout;
client.workflowModules = () => new Promise((resolve) => { finishLogout = resolve; });
const afterLogout = store.refreshModules();
await new Promise((resolve) => setImmediate(resolve));
store.reset();
finishLogout({ revision: 9, modules: [], jobs: [], agents: [], audit: [] });
await afterLogout;
assert.equal(store.getSnapshot().modules, null, 'logout discards in-flight workflow state');
console.log('workflow module UI contracts passed: capability checks, workflow-room boundary and revision races');
