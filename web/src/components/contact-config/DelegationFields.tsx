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

const RUNNERS: [string, string][] = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['grok', 'Grok'],
];
const CAPS = [1, 2, 3, 5];

export default function DelegationFields(props: Props) {
  return (
    <>
      <div className="switch-row accent">
        <span>
          <b>允许派单到我的 PC</b>
          <small>开启后这个联系人能把编码任务丢进 worker 队列</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={props.enabled}
          className={'switch' + (props.enabled ? ' on' : '')}
          onClick={() => props.onEnabled(!props.enabled)}
        >
          <span className="switch-knob" />
        </button>
      </div>

      {props.enabled && (
        <>
          <div className="cfg-group">
            <h3>Runner 白名单</h3>
            <div className="pill-row">
              {RUNNERS.map(([runner, label]) => {
                const on = props.runners.includes(runner);
                return (
                  <button
                    key={runner}
                    type="button"
                    aria-pressed={on}
                    className={'chip-pill' + (on ? ' selected' : '')}
                    onClick={() =>
                      props.onRunners(
                        on
                          ? props.runners.length > 1
                            ? props.runners.filter((item) => item !== runner)
                            : props.runners
                          : [...props.runners, runner]
                      )
                    }
                  >
                    {label}
                  </button>
                );
              })}
            </div>
            <p className="cfg-note">至少保留一个。</p>
          </div>

          <div className="cfg-group">
            <h3>Workspace 白名单</h3>
            {props.workspaces.length === 0 && <p className="cfg-warn">⚠ 白名单为空时无法派单</p>}
            <div className="path-chips">
              {props.workspaces.map((workspace) => (
                <span className="path-chip" key={workspace}>
                  <code>{workspace}</code>
                  <button
                    type="button"
                    aria-label={`移除 ${workspace}`}
                    onClick={() => props.onWorkspaces(props.workspaces.filter((item) => item !== workspace))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
            <div className="path-add">
              <input
                className="cfg-mono"
                value={props.workspaceDraft}
                placeholder="C:\path\to\project"
                onChange={(event) => props.onWorkspaceDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    props.onAddWorkspace();
                  }
                }}
              />
              <button type="button" onClick={props.onAddWorkspace} disabled={!props.workspaceDraft.trim()}>
                添加
              </button>
            </div>
            <p className="cfg-note">PC 上的绝对路径，派单只能落在这些目录里。</p>
          </div>

          <div className="cfg-group">
            <h3>限额</h3>
            <div className="switch-row sub">
              <span>
                <b>允许 Shell</b>
                <small>Codex 任务必需；风险更高</small>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={props.allowShell}
                className={'switch' + (props.allowShell ? ' on' : '')}
                onClick={() => props.onAllowShell(!props.allowShell)}
              >
                <span className="switch-knob" />
              </button>
            </div>
            <div className="switch-row sub">
              <span>
                <b>同时在跑 / 在排上限</b>
              </span>
              <div className="num-seg" role="group" aria-label="任务上限">
                {CAPS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={n === props.maxOpenJobs ? 'selected' : ''}
                    onClick={() => props.onMaxOpenJobs(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
            <p className="cfg-note">
              SSH 等高影响能力永远不给模型，只能在 🖥 面板手动派。委派任务会以子会话形式挂在原聊天消息下。
              {props.contact?.backend === 'codex' && ' Codex 会按联系人自动接入 hub MCP，无需修改全局 config.toml。'}
              {props.contact?.backend === 'grok-cli' &&
                ' Grok 使用部署机受信任的用户级 hub MCP；这里只控制是否授权委派，并仅自动批准这个接口。'}
            </p>
          </div>
        </>
      )}
    </>
  );
}
