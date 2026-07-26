import { type Contact } from '../../api';

interface Props {
  contact: Contact | null;
  enabled: boolean;
  workspaces: string[];
  runners: string[];
  workspaceDraft: string;
  allowShell: boolean;
  maxOpenJobs: number;
  onEnabled(value: boolean): void;
  onWorkspaces(value: string[]): void;
  onRunners(value: string[]): void;
  onWorkspaceDraft(value: string): void;
  onAddWorkspace(): void;
  onAllowShell(value: boolean): void;
  onMaxOpenJobs(value: number): void;
}

export default function DelegationFields(props: Props) {
  return (
    <fieldset className="mem-toggles">
      <legend>PC Worker 委派</legend>
      <label><input type="checkbox" checked={props.enabled} onChange={(event) => props.onEnabled(event.target.checked)} />允许这个联系人把编码任务派给 PC Worker</label>
      {props.enabled && (
        <>
          <div className="deleg-workspaces">
            <span className="field-hint">workspace 白名单（PC 上的绝对路径，派单只能落在这些目录里）</span>
            {props.workspaces.length === 0 && <p className="field-hint deleg-empty">⚠ 白名单为空时无法派单</p>}
            {props.workspaces.map((workspace) => (
              <div className="deleg-workspace-row" key={workspace}>
                <code>{workspace}</code>
                <button type="button" aria-label={`移除 ${workspace}`} onClick={() => props.onWorkspaces(props.workspaces.filter((item) => item !== workspace))}>×</button>
              </div>
            ))}
            <div className="deleg-workspace-add">
              <input value={props.workspaceDraft} placeholder="C:\projects\my-repo" onChange={(event) => props.onWorkspaceDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); props.onAddWorkspace(); } }} />
              <button type="button" onClick={props.onAddWorkspace} disabled={!props.workspaceDraft.trim()}>添加</button>
            </div>
          </div>
          <div className="deleg-workspaces">
            <span className="field-hint">允许使用的本机 runner（至少保留一个）</span>
            <div className="field-row">
              {([['claude', 'Claude'], ['codex', 'Codex'], ['grok', 'Grok']] as const).map(([runner, label]) => (
                <label key={runner}>
                  <input type="checkbox" checked={props.runners.includes(runner)} onChange={() => props.onRunners(props.runners.includes(runner) ? (props.runners.length > 1 ? props.runners.filter((item) => item !== runner) : props.runners) : [...props.runners, runner])} />
                  {label}
                </label>
              ))}
            </div>
          </div>
          <label><input type="checkbox" checked={props.allowShell} onChange={(event) => props.onAllowShell(event.target.checked)} />允许派带 Shell 的任务（Codex 任务必需；风险更高）</label>
          <label className="field" style={{ maxWidth: 200 }}>
            同时在跑/在排任务上限
            <input type="number" min={1} max={10} value={props.maxOpenJobs} onChange={(event) => props.onMaxOpenJobs(Math.min(10, Math.max(1, Number(event.target.value) || 3)))} />
          </label>
          <p className="field-hint">
            SSH 等高影响能力永远不给模型，只能在 🖥 面板手动派。委派任务会以子会话形式挂在原聊天消息下。
            {props.contact?.backend === 'codex' && ' Codex 会按联系人自动接入 hub MCP，无需修改全局 config.toml。'}
            {props.contact?.backend === 'grok-cli' && ' Grok 使用部署机受信任的用户级 hub MCP；这里只控制是否授权委派，并仅自动批准这个接口。'}
          </p>
        </>
      )}
    </fieldset>
  );
}
