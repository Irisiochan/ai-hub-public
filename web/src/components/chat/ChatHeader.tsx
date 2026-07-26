import { useEffect, useRef, useState } from 'react';
import {
  api,
  type ClaudeQuota,
  type CodexQuota,
  type Contact,
  type ContactStatus,
  type GrokQuota,
  type ModelCatalog,
  type Usage,
} from '../../api';
import { statusText } from '../../statusText';
import { DISPLAY_TIME_ZONE } from '../../time';

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function fmtFullTokens(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value);
}

function fmtQuotaReset(resetsAt: string | null | undefined): string {
  if (!resetsAt) return '重置时间未知';
  return `${new Intl.DateTimeFormat('zh-CN', {
    timeZone: DISPLAY_TIME_ZONE,
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(resetsAt))} 重置`;
}

interface Props {
  contact: Contact;
  status: ContactStatus;
  usage: Usage | null;
  quota: ClaudeQuota | null;
  codexQuota: CodexQuota | null;
  grokQuota: GrokQuota | null;
  modelCatalog: ModelCatalog | null;
  switchingModel: boolean;
  bulkMode: boolean;
  bulkDeleting: boolean;
  bulkCount: number;
  onBack(): void;
  onSettings(): void;
  onToggleBulk(): void;
  onSwitchModel(model: string): void;
  onSwitchEffort(effort: string): void;
}

export default function ChatHeader(props: Props) {
  const { contact, status, usage, quota, codexQuota, grokQuota, modelCatalog } = props;
  const isRoom = contact.kind === 'room';
  const busy = status.state === 'thinking' || status.state === 'streaming' || status.state.startsWith('tool:');
  const statusLabel = statusText(status, { isRoom, contactName: contact.name });
  const [tokenDetailOpen, setTokenDetailOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const tokenDetailRef = useRef<HTMLDivElement>(null);

  const hasModels = !isRoom && !!modelCatalog && modelCatalog.models.length > 0;
  const hasEfforts = !isRoom && !!modelCatalog?.efforts && modelCatalog.efforts.length > 0;
  // 手机端点名字打开底部面板；桌面端有内联下拉框，点名字不响应
  const openSheet = () => {
    if (window.matchMedia('(max-width: 767px)').matches) setSheetOpen(true);
  };
  useEffect(() => setSheetOpen(false), [contact.id]);

  useEffect(() => setTokenDetailOpen(false), [contact.id]);
  useEffect(() => {
    if (!tokenDetailOpen) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && tokenDetailRef.current?.contains(event.target)) return;
      setTokenDetailOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [tokenDetailOpen]);

  const quotaBits: string[] = [];
  if (contact.backend === 'claude-cli') {
    if (quota?.available) {
      if (quota.fiveHour) quotaBits.push(`5h剩${quota.fiveHour.remainingPct}%`);
      if (quota.sevenDay) quotaBits.push(`周剩${quota.sevenDay.remainingPct}%`);
    } else if (quota?.reason === 'setup-token') quotaBits.push('额度不可用：VPS 需完整 claude /login');
    else if (quota?.reason === 'login-expired') quotaBits.push('额度不可用：登录过期，需重新 /login');
  }
  if (contact.backend === 'codex' && codexQuota?.available) {
    if (codexQuota.fiveHour) quotaBits.push(`5h剩${codexQuota.fiveHour.remainingPct}%`);
    if (codexQuota.sevenDay) quotaBits.push(`周剩${codexQuota.sevenDay.remainingPct}%`);
  }
  if (contact.backend === 'grok-cli') {
    if (grokQuota?.available && grokQuota.weekly) {
      quotaBits.push(`周池剩${grokQuota.weekly.remainingPct}%`);
      if (grokQuota.weekly.resetsAt) {
        const reset = new Intl.DateTimeFormat('zh-CN', { timeZone: DISPLAY_TIME_ZONE, month: 'numeric', day: 'numeric' }).format(new Date(grokQuota.weekly.resetsAt));
        quotaBits.push(`${reset}重置`);
      }
    } else if (grokQuota?.reason === 'login-expired') quotaBits.push('额度不可用：grok 登录过期');
    else if (grokQuota?.reason === 'no-token') quotaBits.push('额度不可用：VPS 没有 grok 登录态');
  }
  if (usage && (usage.today.input > 0 || usage.today.output > 0)) {
    quotaBits.push(`本轮 ${fmtTokens(usage.last.input)}↑ ${fmtTokens(usage.last.output)}↓`);
    if (usage.last.cacheRead > 0 || usage.last.cacheCreation > 0) quotaBits.push(`缓存 ${fmtTokens(usage.last.cacheRead)}读 ${fmtTokens(usage.last.cacheCreation)}建`);
    quotaBits.push(`今日 ${fmtTokens(usage.today.input)}↑ ${fmtTokens(usage.today.output)}↓`);
  }
  const tokenSummary = quotaBits.join(' · ');
  const showTokenDetail = !statusLabel && tokenSummary.length > 0;
  const quotaRows: { label: string; value: string; note?: string }[] = [];
  if (contact.backend === 'claude-cli') {
    if (quota?.available) {
      if (quota.fiveHour) quotaRows.push({ label: 'Claude 5 小时窗口', value: `剩余 ${quota.fiveHour.remainingPct}%`, note: fmtQuotaReset(quota.fiveHour.resetsAt) });
      if (quota.sevenDay) quotaRows.push({ label: 'Claude 7 天窗口', value: `剩余 ${quota.sevenDay.remainingPct}%`, note: fmtQuotaReset(quota.sevenDay.resetsAt) });
    } else if (quota?.reason) quotaRows.push({ label: 'Claude 额度', value: quotaBits[0] ?? '额度不可用' });
  }
  if (contact.backend === 'codex' && codexQuota?.available) {
    if (codexQuota.fiveHour) quotaRows.push({ label: 'Codex 5 小时窗口', value: `剩余 ${codexQuota.fiveHour.remainingPct}%`, note: fmtQuotaReset(codexQuota.fiveHour.resetsAt) });
    if (codexQuota.sevenDay) quotaRows.push({ label: 'Codex 7 天窗口', value: `剩余 ${codexQuota.sevenDay.remainingPct}%`, note: fmtQuotaReset(codexQuota.sevenDay.resetsAt) });
  }
  if (contact.backend === 'grok-cli') {
    if (grokQuota?.available && grokQuota.weekly) quotaRows.push({ label: 'Grok 周池', value: `剩余 ${grokQuota.weekly.remainingPct}%`, note: fmtQuotaReset(grokQuota.weekly.resetsAt) });
    else if (grokQuota?.reason) quotaRows.push({ label: 'Grok 额度', value: quotaBits[0] ?? '额度不可用' });
  }

  return (
    <header className="chat-header">
      <button className="back-btn" onClick={props.onBack}>←</button>
      <span className="avatar" style={{ background: contact.color + '33' }}>{contact.avatar}</span>
      <div className="chat-title">
        <button type="button" className="chat-title-name" onClick={openSheet} aria-haspopup="dialog">
          <span style={{ color: contact.color }}>{contact.name}</span>
          <span className="chat-title-caret" aria-hidden="true">⌄</span>
        </button>
        <div className="token-detail-wrap" ref={tokenDetailRef}>
          {showTokenDetail ? (
            <button type="button" className="chat-status token-status-btn" aria-expanded={tokenDetailOpen} onClick={() => setTokenDetailOpen((open) => !open)}>{tokenSummary}</button>
          ) : <span className="chat-status">{statusLabel}</span>}
          {showTokenDetail && tokenDetailOpen && (
            <div className="token-detail-popover" role="dialog" aria-label="Token 消耗详情">
              <div className="token-detail-head"><b>Token 详情</b><button type="button" className="modal-close" onClick={() => setTokenDetailOpen(false)}>关闭</button></div>
              <div className="token-detail-body">
                {usage && <>
                  <div className="token-detail-section"><b>本轮</b><span>{fmtFullTokens(usage.last.input)} 输入 · {fmtFullTokens(usage.last.output)} 输出</span><small>{fmtFullTokens(usage.last.cacheRead)} 缓存读 · {fmtFullTokens(usage.last.cacheCreation)} 缓存建</small></div>
                  <div className="token-detail-section"><b>今日</b><span>{fmtFullTokens(usage.today.input)} 输入 · {fmtFullTokens(usage.today.output)} 输出</span><small>{fmtFullTokens(usage.today.cacheRead)} 缓存读 · {fmtFullTokens(usage.today.cacheCreation)} 缓存建</small></div>
                </>}
                {quotaRows.length > 0 && <div className="token-detail-section"><b>额度窗口</b>{quotaRows.map((row) => <span key={row.label}>{row.label}：{row.value}{row.note ? <small>{row.note}</small> : null}</span>)}</div>}
              </div>
            </div>
          )}
        </div>
      </div>
      {busy && <button className="interrupt-btn" onClick={() => void api.interrupt(contact.id)}>⏹ 打断</button>}
      <div className="chat-header-controls">
        {hasModels && (
          <select className="model-select" title={modelCatalog!.warning ?? '切换模型会开启新的底层会话，并自动衔接近期聊天'} aria-label="切换模型" value={modelCatalog!.current} disabled={busy || props.switchingModel} onChange={(event) => props.onSwitchModel(event.target.value)}>
            {modelCatalog!.models.map((model) => <option key={model.id || '__default'} value={model.id} title={model.description}>{model.label}</option>)}
          </select>
        )}
        {hasEfforts && (
          <select className="model-select" title="推理强度：切换会开启新的底层会话，并自动衔接近期聊天" aria-label="切换推理强度" value={modelCatalog!.currentEffort ?? ''} disabled={busy || props.switchingModel} onChange={(event) => props.onSwitchEffort(event.target.value)}>
            {modelCatalog!.efforts!.map((effort) => <option key={effort.id || '__default'} value={effort.id}>{effort.label}</option>)}
          </select>
        )}
        <button className={'bulk-tool-btn' + (props.bulkMode ? ' active' : '')} title="批量选择消息气泡" onClick={props.onToggleBulk} disabled={props.bulkCount === 0 || props.bulkDeleting}>批量消息</button>
      </div>
      <button className="gear-btn" title="联系人设置" onClick={props.onSettings}>⚙</button>
      {sheetOpen && (
        <div className="sheet-backdrop" onClick={() => setSheetOpen(false)}>
          <div className="sheet" role="dialog" aria-label="会话选项" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-handle" aria-hidden="true" />
            {hasModels && (
              <section className="sheet-section">
                <h3>模型{props.switchingModel ? ' · 切换中…' : ''}</h3>
                {modelCatalog!.models.map((model) => (
                  <button
                    key={model.id || '__default'}
                    type="button"
                    className={'sheet-row' + (model.id === modelCatalog!.current ? ' selected' : '')}
                    disabled={busy || props.switchingModel}
                    onClick={() => { props.onSwitchModel(model.id); setSheetOpen(false); }}
                  >
                    <span className="sheet-row-main">
                      {model.label}
                      {model.description && <small>{model.description}</small>}
                    </span>
                    {model.id === modelCatalog!.current && <span className="sheet-check">✓</span>}
                  </button>
                ))}
                {modelCatalog!.warning && <p className="field-hint">{modelCatalog!.warning}</p>}
              </section>
            )}
            {hasEfforts && (
              <section className="sheet-section">
                <h3>推理强度</h3>
                <div className="sheet-segment">
                  {modelCatalog!.efforts!.map((effort) => (
                    <button
                      key={effort.id || '__default'}
                      type="button"
                      className={'sheet-seg-btn' + ((modelCatalog!.currentEffort ?? '') === effort.id ? ' selected' : '')}
                      disabled={busy || props.switchingModel}
                      onClick={() => { props.onSwitchEffort(effort.id); setSheetOpen(false); }}
                    >
                      {effort.label}
                    </button>
                  ))}
                </div>
              </section>
            )}
            <section className="sheet-section">
              <button
                type="button"
                className={'sheet-row' + (props.bulkMode ? ' selected' : '')}
                disabled={props.bulkCount === 0 || props.bulkDeleting}
                onClick={() => { props.onToggleBulk(); setSheetOpen(false); }}
              >
                <span className="sheet-row-main">批量选择消息<small>勾选多条消息，一起删除或退出选择</small></span>
                {props.bulkMode && <span className="sheet-check">✓</span>}
              </button>
            </section>
          </div>
        </div>
      )}
    </header>
  );
}
