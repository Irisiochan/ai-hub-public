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

export default function CliFields(props: Props) {
  const { contact } = props;
  return (
    <fieldset className="mem-toggles">
      <legend>项目权限</legend>
      {contact.backend === 'grok-cli' ? (
        <p className="field-hint">grok-cli 后端暂不支持项目写权限。</p>
      ) : (
        <label><input type="checkbox" checked={props.projectEnabled} onChange={(event) => props.onProjectEnabled(event.target.checked)} />允许这个联系人修改指定项目</label>
      )}
      {props.projectEnabled && contact.backend !== 'grok-cli' && (
        <>
          <label className="field">
            项目工作区（必须已存在，不能填磁盘根目录）
            <input value={props.projectWorkspace} onChange={(event) => props.onProjectWorkspace(event.target.value)} placeholder="/opt/my-project 或 E:\\projects\\my-project" />
          </label>
          {contact.backend === 'claude-cli' && <label><input type="checkbox" checked={props.projectShell} onChange={(event) => props.onProjectShell(event.target.checked)} />同时允许 Bash（可运行测试/构建，风险更高）</label>}
          <p className="field-hint">默认仍只读。开启后 Claude 获得 Read/Write/Edit，Codex 使用 workspace-write；工具调用会保留在聊天审计记录中，可随时关闭。</p>
        </>
      )}
      <label className="field" style={{ maxWidth: 240 }}>
        换新会话阈值（输入 token，0 = 关闭）
        <input type="number" min={0} step={10000} value={props.sessionTokenLimit} onChange={(event) => props.onSessionTokenLimit(Math.max(0, Number(event.target.value) || 0))} />
      </label>
      <p className="field-hint">达到阈值后自动开启新 thread，并注入最近对话的压缩回放与最新记忆。</p>
    </fieldset>
  );
}
