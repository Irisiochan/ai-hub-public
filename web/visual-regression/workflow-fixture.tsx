import { createRoot } from 'react-dom/client';
import WorkflowModules from '../src/workflow/WorkflowModules';
import { workerState } from '../src/jobs/useWorkerState';
import type { WorkflowModulesResponse, WorkflowModuleId } from '../src/platform/api';
import { BUILTIN_THEMES } from '../src/settings/theme/builtins';
import { applyThemeManifest } from '../src/settings/theme/store';

applyThemeManifest(BUILTIN_THEMES[0], new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark');
const all: WorkflowModuleId[] = ['plan', 'execute', 'review', 'arbitration', 'merge', 'deploy', 'maintenance'];
let data: WorkflowModulesResponse = {
  revision: 7,
  workerTarget: null,
  agents: [
    { contactId: 'codex', name: 'Codex', runner: 'codex', quotaPool: 'codex-account', compatibleModules: all,
      models: [{ id: 'gpt-6-astra', label: 'Astra', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] }] },
    { contactId: 'muse', name: 'Sora', runner: 'opencode', quotaPool: 'opencode-go', compatibleModules: ['execute', 'plan', 'arbitration'],
      models: [{ id: 'opencode-go/muse-spark-1.3-contributor', label: 'Muse Spark 1.3', efforts: ['high', 'max'] }] },
    { contactId: 'aye', name: '阿野', runner: 'grok', quotaPool: 'grok-account', unavailableReason: 'Grok 额度已耗尽', compatibleModules: all,
      models: [{ id: 'grok-4.6', label: 'Grok 4.6', efforts: ['low', 'medium', 'high'] }] },
    { contactId: 'claude', name: 'Claude', runner: 'claude', quotaPool: 'claude-account', compatibleModules: all,
      models: [{ id: 'opus', label: 'Opus', efforts: ['high', 'max'] }] },
  ],
  modules: all.map((id) => {
    const labels = { plan: '接入／规划', execute: '执行／修复', review: '独立评审', arbitration: '技术仲裁', merge: '合并', deploy: '部署／验证', maintenance: '维护／巡逻' };
    const contactId = id === 'execute' ? 'muse' : id === 'review' || id === 'maintenance' ? 'aye' : 'codex';
    return {
      id, label: labels[id], description: id === 'review' ? '独立核对需求、候选版本和测试证据，给出可复核的评审结果。' : '按固定模块职责处理已授权的任务。',
      permissions: { write: id === 'execute' || id === 'merge', shell: id !== 'plan', ssh: id === 'deploy' },
      binding: { contactId, runner: contactId === 'muse' ? 'opencode' : contactId === 'aye' ? 'grok' : 'codex', model: contactId === 'muse' ? 'opencode-go/muse-spark-1.3-contributor' : contactId === 'aye' ? 'grok-4.6' : 'gpt-6-astra', reasoning: 'high' },
      status: id === 'review' ? 'blocked' : id === 'maintenance' ? 'unavailable' : id === 'execute' ? 'running' : 'idle',
      ...(id === 'review' ? { statusDetail: '当前评审失败：Grok 额度已耗尽。可以更换绑定并接管。' } : {}),
    };
  }),
  jobs: [
    { id: 'review-blocked-1', moduleId: 'review', model: 'grok-4.6', reasoning: 'high', status: 'failed', bindingRevision: 6, error: 'Grok 额度已耗尽', canTakeover: true },
    { id: 'execute-running-1', moduleId: 'execute', model: 'opencode-go/muse-spark-1.3-contributor', reasoning: 'high', status: 'running', bindingRevision: 6, canTakeover: false },
  ], audit: [],
};
const requests: Array<{ method: string; url: string; body: unknown }> = [];
let uiErrors = 0;
window.addEventListener('error', () => { uiErrors++; });
window.addEventListener('unhandledrejection', () => { uiErrors++; });
const fixture = {
  requests,
  errors: () => uiErrors,
  bumpRevision() { data.revision++; workerState.applyModules(structuredClone(data)); },
  data: () => structuredClone(data),
};
(window as unknown as { workflowFixture: typeof fixture }).workflowFixture = fixture;
window.fetch = async (input, init) => {
  const url = String(input);
  const method = init?.method ?? 'GET';
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  requests.push({ method, url, body });
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  if (url === '/api/workflow-modules' && method === 'GET') return response(data);
  if (url === '/api/workers' && method === 'GET') return response({ workers: [
    { id: 'pc-User', name: 'my-pc', status: 'online', acceptingJobs: true, last_seen_at: null,
      capabilities: { workspaces: ['C:/path/to/project'], runners: ['codex', 'opencode'] } },
    { id: 'vps-dev', name: 'vps-dev', status: 'online', acceptingJobs: true, last_seen_at: null,
      capabilities: { workspaces: ['/srv/ai-dev/jobs'], runners: ['codex', 'opencode'] } },
  ] });
  if (url === '/api/project-targets' && method === 'GET') return response({ targets: [
    { repoId: 'ai-hub', platform: 'linux', workerId: 'vps-dev', workspace: '/srv/ai-dev/jobs' },
  ] });
  if (url === '/api/workflow-modules/worker-target' && method === 'PATCH') {
    if (body.expectedRevision !== data.revision) return response({ error: '配置版本已变化' }, 409);
    data.workerTarget = body.target;
    data.revision++;
    return response(data);
  }
  if (url.startsWith('/api/workflow-modules/jobs/') && method === 'POST') {
    if (body.expectedRevision !== data.revision) return response({ error: '配置版本已变化' }, 409);
    const job = data.jobs.find((item) => item.id === 'review-blocked-1')!;
    job.canTakeover = false;
    const binding = data.modules.find((item) => item.id === 'review')!.binding;
    data.jobs.push({ ...job, id: 'review-takeover-2', model: binding.model, reasoning: binding.reasoning, status: 'pending', bindingRevision: data.revision, error: undefined });
    return response({ job: { id: 'review-takeover-2', status: 'pending', created_at: '2026-09-10T00:00:00Z' } });
  }
  if (url.startsWith('/api/workflow-modules/') && method === 'PATCH') {
    if (body.expectedRevision !== data.revision) return response({ error: '配置版本已变化' }, 409);
    const module = data.modules.find((item) => item.id === url.split('/').at(-1));
    if (!module) return response({ error: 'module missing' }, 404);
    module.binding = body.binding;
    module.status = 'idle'; module.statusDetail = undefined;
    data.revision++;
    return response(data);
  }
  return response({ error: `Unexpected fixture request ${method} ${url}` }, 404);
};
createRoot(document.getElementById('root')!).render(
  <div style={{ height: '100%', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
    <header style={{ padding: '16px 20px', borderBottom: '1px solid var(--border)' }}><b>协作会议室</b></header>
    <WorkflowModules initiallyOpen />
    <div style={{ flex: 1, padding: 24, color: 'var(--text-dim)', minHeight: 60 }}>会议室消息与任务记录</div>
  </div>,
);
const ready = window.setInterval(() => {
  if (!document.querySelector('.workflow-module-editor')) return;
  document.documentElement.dataset.visualReady = 'true';
  window.clearInterval(ready);
}, 30);
