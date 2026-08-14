import { useState } from 'react';
import type { Message, WorkerJob } from '../../api';
import {
  defaultClosableTaskPath,
  isTailTaskPath,
  taskPathCandidates,
  type FollowupJobInput,
} from '../../sideJobActions';
import { useConfirm } from '../ConfirmDialog';

interface Props {
  message: Message;
  job: WorkerJob;
  onHandled(): void;
  onRework(message: Message, job: WorkerJob): Promise<WorkerJob>;
  onFollowup(message: Message, job: WorkerJob, input: FollowupJobInput): Promise<WorkerJob>;
  onMarkTaskDone(message: Message, job: WorkerJob, taskPath: string): Promise<void>;
}

export default function SideJobActions({ message, job, onHandled, onRework, onFollowup, onMarkTaskDone }: Props) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState<'rework' | 'followup' | 'done' | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);
  const [panel, setPanel] = useState<'followup' | 'done' | null>(null);
  const [instruction, setInstruction] = useState('');
  const [runner, setRunner] = useState<WorkerJob['runner']>(job.runner);
  const [workspace, setWorkspace] = useState(job.workspace);
  const [taskPath, setTaskPath] = useState(() => defaultClosableTaskPath(job, message));
  const [donePath, setDonePath] = useState<string | null>(null);
  const candidates = taskPathCandidates(job, message);

  const rework = async () => {
    if (busy) return;
    setBusy('rework');
    try {
      const created = await onRework(message, job);
      setCreatedId(created.id);
      onHandled();
    } catch {
      // ChatPane routes the API error to its existing visible sendError slot.
    } finally {
      setBusy(null);
    }
  };

  const followup = async () => {
    const input = { instruction: instruction.trim(), runner, workspace: workspace.trim() };
    if (busy || !input.instruction || !input.workspace) return;
    setBusy('followup');
    try {
      const created = await onFollowup(message, job, input);
      setCreatedId(created.id);
      setInstruction('');
      setPanel(null);
      onHandled();
    } catch {
      // ChatPane routes the API error to its existing visible sendError slot.
    } finally {
      setBusy(null);
    }
  };

  const markDone = async () => {
    const exactPath = taskPath.trim().toLowerCase();
    if (busy || !exactPath) return;
    if (!(await confirm({
      title: '确认置 done',
      message: `确认将 ${exactPath} 标为 done？\n只关闭这一条，尾巴任务不会自动关闭。`,
      confirmLabel: '标为 done',
      danger: true,
    }))) {
      return;
    }
    setBusy('done');
    try {
      await onMarkTaskDone(message, job, exactPath);
      setDonePath(exactPath);
      setPanel(null);
      onHandled();
    } catch {
      // ChatPane routes the API error to its existing visible sendError slot.
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="side-job-action-wrap">
      <div className="side-job-actions" aria-label="Worker 回执操作">
        <button type="button" onClick={() => void rework()} disabled={busy !== null}>
          {busy === 'rework' ? '派单中…' : '↩ 打回重做'}
        </button>
        <button type="button" onClick={() => setPanel(panel === 'followup' ? null : 'followup')} disabled={busy !== null}>
          ＋ 再派一单
        </button>
        <button type="button" onClick={() => setPanel(panel === 'done' ? null : 'done')} disabled={busy !== null || donePath !== null}>
          {donePath ? '✓ 已置 done' : '✓ 置 done'}
        </button>
        {createdId && <span title={createdId}>已派出新任务</span>}
      </div>

      {panel === 'followup' && (
        <div className="side-job-action-editor">
          <label>
            Runner
            <select value={runner} onChange={(event) => setRunner(event.target.value as WorkerJob['runner'])}>
              <option value="codex">Codex</option>
              <option value="claude">Claude</option>
              <option value="grok">Grok</option>
            </select>
          </label>
          <label>
            Workspace
            <input value={workspace} onChange={(event) => setWorkspace(event.target.value)} />
          </label>
          <label className="wide">
            新指令
            <textarea
              rows={3}
              autoFocus
              value={instruction}
              placeholder="写这次要做的新事情；上方回执会自动附带"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
          <div className="side-job-editor-actions">
            <button type="button" onClick={() => setPanel(null)}>取消</button>
            <button type="button" className="primary-btn" onClick={() => void followup()} disabled={!instruction.trim() || !workspace.trim() || busy !== null}>
              {busy === 'followup' ? '派单中…' : '确认派单'}
            </button>
          </div>
        </div>
      )}

      {panel === 'done' && (
        <div className="side-job-action-editor">
          <label className="wide">
            只关闭这一条任务
            <input
              autoFocus
              list={`task-paths-${message.id}`}
              value={taskPath}
              placeholder="tasks/example.md"
              onChange={(event) => setTaskPath(event.target.value)}
            />
            <datalist id={`task-paths-${message.id}`}>
              {candidates.map((candidate) => <option key={candidate} value={candidate} />)}
            </datalist>
          </label>
          {isTailTaskPath(taskPath) && <p className="side-job-warning">尾巴任务不能用快捷按钮关闭，请在任务账本单独处理。</p>}
          <div className="side-job-editor-actions">
            <button type="button" onClick={() => setPanel(null)}>取消</button>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void markDone()}
              disabled={!taskPath.trim() || isTailTaskPath(taskPath) || busy !== null}
            >
              {busy === 'done' ? '写入中…' : '确认置 done'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
