import { type Contact } from '../../api';

interface Props {
  contact: Contact;
  projectEnabled: boolean;
  projectWorkspace: string;
  projectShell: boolean;
  sessionTokenLimit: number;
  onProjectEnabled(value: boolean): void;
  onProjectWorkspace(value: string): void;
  onProjectShell(value: boolean): void;
  onSessionTokenLimit(value: number): void;
}

function fmtTokens(value: number): string {
  if (value === 0) return '关闭';
  return value >= 1000 ? `${Math.round(value / 1000)}k` : String(value);
}

export default function CliFields(props: Props) {
  const { contact } = props;
  const grok = contact.backend === 'grok-cli';

  return (
    <>
      <div className="cfg-group">
        <h3>项目访问</h3>
        {grok ? (
          <p className="cfg-note">grok-cli 后端暂不支持项目写权限。</p>
        ) : (
          <>
            <div className="switch-row">
              <span>
                <b>允许读写 workspace</b>
                <small>关掉后这个联系人只能聊天</small>
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={props.projectEnabled}
                className={'switch' + (props.projectEnabled ? ' on' : '')}
                onClick={() => props.onProjectEnabled(!props.projectEnabled)}
              >
                <span className="switch-knob" />
              </button>
            </div>

            {props.projectEnabled && (
              <>
                <label className="cfg-field">
                  <span>workspace 绝对路径（必须已存在，不能填磁盘根目录）</span>
                  <input
                    className="cfg-mono"
                    value={props.projectWorkspace}
                    onChange={(event) => props.onProjectWorkspace(event.target.value)}
                    placeholder="/opt/my-project 或 E:\projects\my-project"
                  />
                </label>
                {contact.backend === 'claude-cli' && (
                  <div className="switch-row sub">
                    <span>
                      <b>允许 Bash</b>
                      <small>可运行测试/构建，风险更高</small>
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={props.projectShell}
                      className={'switch' + (props.projectShell ? ' on' : '')}
                      onClick={() => props.onProjectShell(!props.projectShell)}
                    >
                      <span className="switch-knob" />
                    </button>
                  </div>
                )}
                <p className="cfg-note">
                  默认仍只读。开启后 Claude 获得 Read/Write/Edit，Codex 使用 workspace-write；工具调用会保留在聊天审计记录中，可随时关闭。
                </p>
              </>
            )}
          </>
        )}
      </div>

      <div className="cfg-group">
        <h3>会话上限</h3>
        <div className="slider-row">
          <input
            type="range"
            min={0}
            max={200000}
            step={10000}
            value={props.sessionTokenLimit}
            onChange={(event) => props.onSessionTokenLimit(Number(event.target.value) || 0)}
          />
          <b>{fmtTokens(props.sessionTokenLimit)}</b>
        </div>
        <p className="cfg-note">达到阈值后自动开新 thread，并注入最近对话的压缩回放与最新记忆。0 = 关闭。</p>
      </div>
    </>
  );
}
