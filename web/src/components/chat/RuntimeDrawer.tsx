import { useEffect, useState } from 'react';
import {
  api,
  type ClaudeQuota,
  type CodexQuota,
  type Contact,
  type ContactStatus,
  type GrokQuota,
  type HeartbeatStatus,
  type ModelCatalog,
  type Usage,
} from '../../api';
import { DISPLAY_TIME_ZONE, formatRemainingMinutes } from '../../time';
import { Icon } from '../icons';
import ModelPicker from '../ModelPicker';
import type { MotionState } from '../../motionPresence';

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return '重置时间未知';
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(resetsAt))} 重置`;
}

function fmtLastGood(fetchedAt: string | null | undefined): string {
  if (!fetchedAt) return '数据可能过期';
  return `数据可能过期 · 上次成功于 ${new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(fetchedAt))}`;
}

interface QuotaBar {
  label: string;
  pct: number;
  note: string;
  week?: boolean;
}

interface Props {
  motionState: MotionState;
  contact: Contact;
  status: ContactStatus;
  heartbeat: HeartbeatStatus;
  onHeartbeat(status: HeartbeatStatus): void;
  usage: Usage | null;
  quota: ClaudeQuota | null;
  codexQuota: CodexQuota | null;
  grokQuota: GrokQuota | null;
  modelCatalog: ModelCatalog | null;
  switchingModel: boolean;
  bulkMode: boolean;
  bulkCount: number;
  bulkDeleting: boolean;
  onClose(): void;
  onSettings(): void;
  onToggleBulk(): void;
  onSwitchModel(model: string): void;
  onSwitchEffort(effort: string): void;
}

/**
 * 方案 1b 的运行时抽屉：桌面 ≥1024px 是右侧 284px 常驻栏，
 * 窄屏是标题下方的下拉卡（样式见 styles.css §8.3）。
 */
export default function RuntimeDrawer(props: Props) {
  const { contact, status, heartbeat, usage, quota, codexQuota, grokQuota, modelCatalog } = props;
  const isRoom = contact.kind === 'room';
  const busy =
    status.state === 'thinking' || status.state === 'streaming' || status.state.startsWith('tool:');
  const [heartbeatDuration, setHeartbeatDuration] = useState<number | 'unlimited'>(30);
  const [heartbeatBusy, setHeartbeatBusy] = useState(false);
  const [heartbeatError, setHeartbeatError] = useState<string | null>(null);
  const [countdownNow, setCountdownNow] = useState(() => new Date());

  useEffect(() => {
    setHeartbeatDuration(30);
    setHeartbeatError(null);
  }, [contact.id]);

  useEffect(() => {
    if (!heartbeat.active) return;
    setCountdownNow(new Date());
    const timer = window.setInterval(() => setCountdownNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, [heartbeat.active, heartbeat.expiresAt]);

  const startHeartbeat = async () => {
    setHeartbeatBusy(true);
    setHeartbeatError(null);
    try {
      props.onHeartbeat(await api.startHeartbeat(
        contact.id,
        heartbeatDuration === 'unlimited' ? { unlimited: true } : { minutes: heartbeatDuration },
      ));
    } catch (error) {
      setHeartbeatError((error as Error).message);
    } finally {
      setHeartbeatBusy(false);
    }
  };

  const stopHeartbeat = async () => {
    setHeartbeatBusy(true);
    setHeartbeatError(null);
    try {
      props.onHeartbeat(await api.stopHeartbeat(contact.id));
    } catch (error) {
      setHeartbeatError((error as Error).message);
    } finally {
      setHeartbeatBusy(false);
    }
  };

  const bars: QuotaBar[] = [];
  const notes: string[] = [];
  if (contact.backend === 'claude-cli') {
    if (quota?.available) {
      if (quota.fiveHour)
        bars.push({ label: '5 小时', pct: quota.fiveHour.remainingPct, note: fmtReset(quota.fiveHour.resetsAt) });
      if (quota.sevenDay)
        bars.push({ label: '7 天', pct: quota.sevenDay.remainingPct, note: fmtReset(quota.sevenDay.resetsAt), week: true });
    } else if (quota?.reason === 'setup-token') notes.push('额度不可用：VPS 需完整 claude /login');
    else if (quota?.reason === 'login-expired') notes.push('额度不可用：登录过期，需重新 /login');
  }
  if (contact.backend === 'codex' && codexQuota?.available) {
    if (codexQuota.fiveHour)
      bars.push({ label: '5 小时', pct: codexQuota.fiveHour.remainingPct, note: fmtReset(codexQuota.fiveHour.resetsAt) });
    if (codexQuota.sevenDay)
      bars.push({ label: '7 天', pct: codexQuota.sevenDay.remainingPct, note: fmtReset(codexQuota.sevenDay.resetsAt), week: true });
  }
  if (contact.backend === 'grok-cli') {
    if (grokQuota?.available && grokQuota.weekly) {
      const note = [fmtReset(grokQuota.weekly.resetsAt)];
      if (grokQuota.stale) note.push(fmtLastGood(grokQuota.fetchedAt));
      bars.push({ label: '周池', pct: grokQuota.weekly.remainingPct, note: note.join(' · '), week: true });
    }
    else if (grokQuota?.reason === 'login-expired') notes.push('额度不可用：grok 登录过期');
    else if (grokQuota?.reason === 'no-token') notes.push('额度不可用：VPS 没有 grok 登录态');
    else if (grokQuota?.reason === 'error') notes.push('额度暂不可用');
  }

  const hasModels = !isRoom && !!modelCatalog && modelCatalog.models.length > 0;
  const hasEfforts = !isRoom && !!modelCatalog?.efforts && modelCatalog.efforts.length > 0;

  return (
    <aside className="runtime" aria-label="运行时" data-motion-state={props.motionState}>
      <div className="runtime-row" style={{ background: 'none', padding: 0 }}>
        <b style={{ fontSize: 14 }}>运行时</b>
        <button type="button" className="code-act" onClick={props.onClose} aria-label="收起运行时">
          <Icon name="close" />
        </button>
      </div>

      {(bars.length > 0 || notes.length > 0) && (
        <section>
          <h3>订阅额度</h3>
          {bars.map((bar) => (
            <div className="quota" key={bar.label}>
              <div className="quota-head">
                <span>{bar.label}</span>
                <b>{bar.pct}%</b>
              </div>
              <div className="quota-track">
                <div className={'quota-fill' + (bar.week ? ' week' : '')} style={{ width: `${bar.pct}%` }} />
              </div>
              <div className="quota-note">{bar.note}</div>
            </div>
          ))}
          {notes.map((note) => (
            <div className="quota-note" key={note}>
              {note}
            </div>
          ))}
        </section>
      )}

      {usage && (
        <section>
          <h3>Token</h3>
          <div className="runtime-kv">
            <span>本轮</span>
            <span>
              {fmtTokens(usage.last.input)}↑ {fmtTokens(usage.last.output)}↓
            </span>
          </div>
          <div className="runtime-kv">
            <span>缓存</span>
            <span>
              {fmtTokens(usage.last.cacheRead)}读 {fmtTokens(usage.last.cacheCreation)}建
            </span>
          </div>
          <div className="runtime-kv">
            <span>今日</span>
            <span>
              {fmtTokens(usage.today.input)}↑ {fmtTokens(usage.today.output)}↓
            </span>
          </div>
        </section>
      )}

      {hasModels && (
        <section>
          <h3>
            模型{props.switchingModel ? ' · 切换中…' : ''}
            {!props.switchingModel && modelCatalog!.models.length > 1 ? ` · ${modelCatalog!.models.length}` : ''}
          </h3>
          {contact.backend === 'api' ? (
            <ModelPicker
              value={modelCatalog!.current}
              options={modelCatalog!.models}
              disabled={busy || props.switchingModel}
              allowCustom
              title={modelCatalog!.warning ?? '切换模型会开启新的底层会话，并自动衔接近期聊天'}
              ariaLabel="切换模型"
              onChange={props.onSwitchModel}
            />
          ) : (
            <div className="runtime-row">
              <select
                className="runtime-select"
                title={modelCatalog!.warning ?? '切换模型会开启新的底层会话，并自动衔接近期聊天'}
                aria-label="切换模型"
                value={modelCatalog!.current}
                disabled={busy || props.switchingModel}
                onChange={(event) => props.onSwitchModel(event.target.value)}
              >
                {modelCatalog!.models.map((model) => (
                  <option key={model.id || '__default'} value={model.id} title={model.description}>
                    {model.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {hasEfforts && (
            <div className="seg" role="group" aria-label="推理强度">
              {modelCatalog!.efforts!.map((effort) => (
                <button
                  key={effort.id || '__default'}
                  type="button"
                  className={'seg-btn' + ((modelCatalog!.currentEffort ?? '') === effort.id ? ' selected' : '')}
                  disabled={busy || props.switchingModel}
                  onClick={() => props.onSwitchEffort(effort.id)}
                >
                  {effort.label}
                </button>
              ))}
            </div>
          )}
          {modelCatalog!.warning && <div className="quota-note">{modelCatalog!.warning}</div>}
        </section>
      )}

      {contact.config?.heartbeat?.enabled === true && (
        <section className="heartbeat-section">
          <h3>心跳</h3>
          {heartbeat.pausedReason && <p role="status">{heartbeat.pausedReason}</p>}
          {heartbeat.stats && <p className="dim">
            本次/最近会话：唤醒 {heartbeat.stats.dispatched} · 沉默 {heartbeat.stats.silent} · 发言 {heartbeat.stats.visible} · 失败 {heartbeat.stats.failed} · 跳过 {heartbeat.stats.skipped}
            <br />工具 {heartbeat.stats.toolCount} 次 · 已记录输入 {heartbeat.stats.inputTokens.toLocaleString()} / 输出 {heartbeat.stats.outputTokens.toLocaleString()} token（输入含多轮累计，非账单；失败可能无用量）
          </p>}
          {heartbeat.active ? (
            <div className="heartbeat-active">
              <div className="heartbeat-status">
                {heartbeat.pausedReason ? '心跳已暂停' : heartbeat.mode === 'unlimited'
                  ? '心跳中 · 手动常开（直到关闭）'
                  : `心跳中 · ${heartbeat.expiresAt ? formatRemainingMinutes(heartbeat.expiresAt, countdownNow) : '状态同步中'}`}
              </div>
              <button
                type="button"
                className="heartbeat-stop"
                disabled={heartbeatBusy}
                onClick={() => void stopHeartbeat()}
              >
                {heartbeatBusy ? '停止中…' : '停止心跳'}
              </button>
            </div>
          ) : (
            <div className="heartbeat-idle">
              <div className="seg" role="group" aria-label="心跳时长">
                {[30, 60, 120].map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    className={'seg-btn' + (heartbeatDuration === minutes ? ' selected' : '')}
                    disabled={heartbeatBusy}
                    onClick={() => setHeartbeatDuration(minutes)}
                  >
                    {minutes} 分钟
                  </button>
                ))}
                <button
                  type="button"
                  className={'seg-btn' + (heartbeatDuration === 'unlimited' ? ' selected' : '')}
                  disabled={heartbeatBusy}
                  onClick={() => setHeartbeatDuration('unlimited')}
                >
                  不限时
                </button>
              </div>
              {heartbeatDuration === 'unlimited' && (
                <div className="quota-note">开启后不会自动结束，需要手动停止。</div>
              )}
              <button
                type="button"
                className="heartbeat-start"
                disabled={heartbeatBusy}
                onClick={() => void startHeartbeat()}
              >
                {heartbeatBusy ? '开启中…' : '开始心跳'}
              </button>
            </div>
          )}
          {heartbeatError && <div className="quota-note heartbeat-error">{heartbeatError}</div>}
        </section>
      )}

      <div className="runtime-foot">
        <button type="button" onClick={props.onToggleBulk} disabled={props.bulkCount === 0 || props.bulkDeleting}>
          <Icon name="check" />
          <span>{props.bulkMode ? '退出批量选择' : '批量选择消息'}</span>
        </button>
        <button type="button" onClick={props.onSettings}>
          <Icon name="settings" />
          <span>联系人设置</span>
        </button>
        {busy && (
          <button type="button" className="danger" onClick={() => void api.interrupt(contact.id)}>
            <Icon name="stop" />
            <span>打断这一轮</span>
          </button>
        )}
      </div>
    </aside>
  );
}
