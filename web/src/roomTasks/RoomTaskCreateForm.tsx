import { useEffect, useState } from 'react';
import { api } from '../platform/api';
import { defaultRepoId, defaultWorkspaceFor, needsPcSelected, type ProjectTargetInfo } from './roomTaskDefaults';

export default function RoomTaskCreateForm({ roomId, onCreated, onCancel }: {
  roomId: string; onCreated: (notice: string) => void; onCancel: () => void;
}) {
  const [targets, setTargets] = useState<ProjectTargetInfo[]>([]);
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [repoId, setRepoId] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [workspaceTouched, setWorkspaceTouched] = useState(false);
  const [taskPath, setTaskPath] = useState('');
  const [baselineSha, setBaselineSha] = useState('');
  const [needsCamera, setNeedsCamera] = useState(false);
  const [needsTaobao, setNeedsTaobao] = useState(false);
  const [needsSsh, setNeedsSsh] = useState(false);
  const [needsWin32, setNeedsWin32] = useState(false);
  const [module, setModule] = useState<'plan' | 'execute'>('execute');
  const [request, setRequest] = useState('');
  const [autoStart, setAutoStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState(false);
  const needsPc = needsPcSelected({ camera: needsCamera, taobao: needsTaobao, ssh: needsSsh, win32: needsWin32 });
  // W3 默认路由到 VPS：有映射的仓库默认选 VPS 围栏工作区；声明 PC 能力才走 PC。
  const vpsMode = repoId !== '' && !needsPc;
  useEffect(() => {
    let active = true;
    Promise.all([
      api.workers().then(({ workers }) => workers).catch(() => []),
      api.projectTargets().then(({ targets }) => targets).catch(() => []),
      api.workflowModules().then(({ workerTarget }) => workerTarget),
    ]).then(([workers, projectTargets, workerTarget]) => {
      if (!active) return;
      const roots = [...new Set(workers.flatMap(worker => worker.capabilities.workspaces ?? [])
        .map((root) => root.replaceAll('\\', '/')))]
        .filter((root) => /^[A-Za-z]:[\\/]/.test(root));
      setWorkspaces(roots);
      setTargets(projectTargets);
      const defaultRepo = workerTarget?.repoId && projectTargets.some((target) => target.repoId === workerTarget.repoId)
        ? workerTarget.repoId : workerTarget ? '' : defaultRepoId(projectTargets);
      setRepoId(defaultRepo);
      setWorkspace(defaultRepo ? '' : (workerTarget?.workspace ?? roots[0] ?? ''));
      setLoaded(true);
    }).catch((err: unknown) => {
      if (active) { setError(String(err)); setLoaded(true); }
    });
    return () => { active = false; };
  }, []);
  // 仓库/任务路径变化且用户没手动改过工作区时，跟随默认 VPS 工作区。
  useEffect(() => {
    if (!loaded || workspaceTouched || !vpsMode) return;
    setWorkspace(defaultWorkspaceFor(repoId, taskPath, targets) ?? '');
  }, [loaded, workspaceTouched, vpsMode, repoId, taskPath, targets]);
  useEffect(() => {
    if (!needsPc || !repoId) return;
    setRepoId('');
    setWorkspace(workspaces.find((root) => /^[A-Za-z]:[\\/]/.test(root)) ?? '');
    setWorkspaceTouched(false);
  }, [needsPc, repoId, workspaces]);
  const switchRepo = (next: string) => {
    setRepoId(next);
    setWorkspaceTouched(false);
    if (!next) setWorkspace(workspaces[0] ?? '');
    else setWorkspace(defaultWorkspaceFor(next, taskPath, targets) ?? '');
  };
  return <form className="room-task-create" onSubmit={async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.createRoomTask(roomId, {
        task_path: taskPath.trim(),
        ...(workspace.trim() ? { workspace: workspace.trim() } : {}),
        ...(repoId ? { repo_id: repoId } : {}),
        ...(baselineSha.trim() ? { baseline_sha: baselineSha.trim() } : {}),
        ...(needsCamera ? { needs_camera: true } : {}),
        ...(needsTaobao ? { needs_taobao: true } : {}),
        ...(needsSsh ? { needs_ssh: true } : {}),
        ...(needsWin32 ? { needs_win32: true } : {}),
        dispatch: { to_module: module, request: request.trim(), auto_start: module === 'execute' && autoStart },
      });
      onCreated(result.delivery?.status === 'failed'
        ? `已建账；派单未送达：${result.delivery.reason ?? '请查看账本后重试交接'}`
        : result.job ? `已建账，执行任务已入队：${result.job.id.slice(0, 8)}` : '已建账并派单');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }}>
    <label>任务路径<input name="task_path" required pattern="tasks/[a-zA-Z0-9][a-zA-Z0-9-]*\.md"
      placeholder="tasks/example.md" value={taskPath} onChange={event => setTaskPath(event.target.value)} disabled={busy} /></label>
    <small>需求默认读取 Vault 中该任务的原文。</small>
    <label>仓库<select name="repo_id" value={repoId} onChange={event => switchRepo(event.target.value)} disabled={busy || !loaded}>
      <option value="">不指定（PC 工作区）</option>
      {targets.map(target => <option key={target.repoId} value={target.repoId}>{target.repoId}（{target.workerId} · VPS）</option>)}
    </select></label>
    {vpsMode
      ? <label>工作区（VPS 默认，可改）<input name="workspace"
        placeholder="/srv/ai-dev/jobs/<任务slug>" value={workspace}
        onChange={event => { setWorkspace(event.target.value); setWorkspaceTouched(true); }} disabled={busy || !loaded} /></label>
      : <label>工作区<select name="workspace" required value={workspace} onChange={event => setWorkspace(event.target.value)} disabled={busy || !loaded}>
        {!workspaces.length && <option value="">{loaded ? '没有可用的工作区' : '读取中…'}</option>}
        {workspaces.map(root => <option key={root} value={root}>{root}</option>)}
      </select></label>}
    <label>起点提交（可空）<input name="baseline_sha" pattern="[0-9a-fA-F]{40}" minLength={40} maxLength={40}
      placeholder="留空自动取部署回执→远端 master" value={baselineSha} onChange={event => setBaselineSha(event.target.value)} disabled={busy} /></label>
    <fieldset className="room-task-create-pc"><legend>PC 能力（需要才勾，勾选后改走 PC 工作区）</legend>
      <label className="room-task-create-check"><input type="checkbox" name="needs_camera" checked={needsCamera}
        onChange={event => setNeedsCamera(event.target.checked)} disabled={busy} />摄像头 camera</label>
      <label className="room-task-create-check"><input type="checkbox" name="needs_taobao" checked={needsTaobao}
        onChange={event => setNeedsTaobao(event.target.checked)} disabled={busy} />淘宝 taobao</label>
      <label className="room-task-create-check"><input type="checkbox" name="needs_ssh" checked={needsSsh}
        onChange={event => setNeedsSsh(event.target.checked)} disabled={busy} />SSH ssh</label>
      <label className="room-task-create-check"><input type="checkbox" name="needs_win32" checked={needsWin32}
        onChange={event => setNeedsWin32(event.target.checked)} disabled={busy} />Windows win32</label>
    </fieldset>
    <label>目标模块<select name="to_module" value={module} onChange={event => setModule(event.target.value as 'plan' | 'execute')} disabled={busy}>
      <option value="execute">执行</option><option value="plan">规划</option>
    </select></label>
    <label>请求<textarea name="request" required maxLength={20_000} value={request} onChange={event => setRequest(event.target.value)} disabled={busy} /></label>
    {module === 'execute' && <label className="room-task-create-check"><input type="checkbox" name="auto_start" checked={autoStart}
      onChange={event => setAutoStart(event.target.checked)} disabled={busy} />直接启动执行，完成后交评审</label>}
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div><button type="submit" disabled={busy || (!workspace && !repoId)}>{busy ? '提交中…' : '建账并派单'}</button>
      <button type="button" onClick={onCancel} disabled={busy}>取消</button></div>
  </form>;
}
