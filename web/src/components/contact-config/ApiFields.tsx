interface Props {
  /** connection = 基本·接入页；context = 历史与记忆页 */
  section: 'connection' | 'context';
  /** CLI 联系人也用 context 段，但没有连接字段 */
  readOnlyConnection?: boolean;
  provider: string;
  model: string;
  visionModel: string;
  imageSupport: 'auto' | 'on' | 'off';
  baseUrl: string;
  apiKey: string;
  apiKeyPlaceholder: string;
  systemPrompt: string;
  maxTokens: number;
  maxHistory: number;
  historyTokenBudget: number;
  minRecentTurns: number;
  summaryMaxTokens: number;
  memoryPreambleMode: 'full' | 'compact' | 'off';
  promptCache: 'auto' | 'off';
  historySummary: boolean;
  memInject: boolean;
  memSearch: boolean;
  memCapture: boolean;
  onProvider(value: string): void;
  onModel(value: string): void;
  onVisionModel(value: string): void;
  onImageSupport(value: 'auto' | 'on' | 'off'): void;
  onBaseUrl(value: string): void;
  onApiKey(value: string): void;
  onSystemPrompt(value: string): void;
  onMaxTokens(value: number): void;
  onMaxHistory(value: number): void;
  onHistoryTokenBudget(value: number): void;
  onMinRecentTurns(value: number): void;
  onSummaryMaxTokens(value: number): void;
  onMemoryPreambleMode(value: 'full' | 'compact' | 'off'): void;
  onPromptCache(value: 'auto' | 'off'): void;
  onHistorySummary(value: boolean): void;
  onMemInject(value: boolean): void;
  onMemSearch(value: boolean): void;
  onMemCapture(value: boolean): void;
}

const PROVIDERS: [string, string, string][] = [
  ['openai-compat', 'OpenAI 兼容', 'https://api.openai.com/v1/chat/completions'],
  ['anthropic', 'Anthropic', 'https://api.anthropic.com/v1/messages'],
  ['gemini', 'Gemini', 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse'],
];

const IMAGE_OPTS: [Props['imageSupport'], string, string][] = [
  ['auto', '自动', '按模型推断；deepseek 这类纯文字模型会自动把图剥掉'],
  ['on', '强制开', '总是把图发过去，模型不支持时会报错'],
  ['off', '强制关', '永远不发图，含图历史降级成文字占位'],
];

const PREAMBLE: [Props['memoryPreambleMode'], string, string][] = [
  ['full', '完整', '每次开会话都注入全部长期记忆，开销最大但最不容易忘事'],
  ['compact', '精简', '只注入核心身份 + 动态检索；这是默认值'],
  ['off', '关闭', '不注入固定前缀，联系人只看得到当前会话'],
];

function Switch({ on, onToggle, title, hint }: { on: boolean; onToggle(): void; title: string; hint?: string }) {
  return (
    <div className="switch-row sub">
      <span>
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
      <button type="button" role="switch" aria-checked={on} className={'switch' + (on ? ' on' : '')} onClick={onToggle}>
        <span className="switch-knob" />
      </button>
    </div>
  );
}

export default function ApiFields(props: Props) {
  if (props.section === 'connection') {
    const placeholder = PROVIDERS.find(([id]) => id === props.provider)?.[2] ?? PROVIDERS[0][2];
    const imageHint = IMAGE_OPTS.find(([id]) => id === props.imageSupport)?.[2] ?? '';
    return (
      <>
        <div className="cfg-group">
          <h3>接入</h3>
          <div className="cfg-field">
            <span>Provider</span>
            <div className="seg">
              {PROVIDERS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={'seg-btn' + (id === props.provider ? ' selected' : '')}
                  onClick={() => props.onProvider(id)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <label className="cfg-field">
            <span>完整 API URL · 请求原样发到这里，不会自动追加 /v1/…</span>
            <input
              className="cfg-mono"
              value={props.baseUrl}
              onChange={(e) => props.onBaseUrl(e.target.value)}
              placeholder={placeholder}
            />
          </label>
          <label className="cfg-field">
            <span>API Key</span>
            <input
              className="cfg-mono"
              type="password"
              value={props.apiKey}
              onChange={(e) => props.onApiKey(e.target.value)}
              placeholder={props.apiKeyPlaceholder}
            />
          </label>
          <div className="cfg-row">
            <label className="cfg-field">
              <span>模型</span>
              <input className="cfg-mono" value={props.model} onChange={(e) => props.onModel(e.target.value)} placeholder="glm-4-plus" />
            </label>
            <label className="cfg-field">
              <span>图片模型（可空）</span>
              <input
                className="cfg-mono"
                value={props.visionModel}
                onChange={(e) => props.onVisionModel(e.target.value)}
                placeholder="qwen3-vl-plus"
              />
            </label>
            <label className="cfg-field">
              <span>单轮输出上限</span>
              <input
                className="cfg-mono"
                type="number"
                min={256}
                step={1024}
                value={props.maxTokens}
                onChange={(e) => props.onMaxTokens(Math.max(256, Number(e.target.value) || 8192))}
              />
            </label>
          </div>
        </div>

        <div className="cfg-group">
          <h3>图片支持</h3>
          <div className="seg">
            {IMAGE_OPTS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={'seg-btn' + (id === props.imageSupport ? ' selected' : '')}
                onClick={() => props.onImageSupport(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="cfg-note">{imageHint}</p>
        </div>

        <div className="cfg-group">
          <h3>System prompt</h3>
          <textarea
            className="cfg-textarea"
            rows={4}
            value={props.systemPrompt}
            onChange={(e) => props.onSystemPrompt(e.target.value)}
            placeholder="这个 AI 是谁、怎么说话；留空用默认人设"
          />
          <div className="switch-row sub">
            <span>
              <b>Prompt 缓存</b>
            </span>
            <div className="num-seg" role="group" aria-label="Prompt 缓存">
              <button type="button" className={props.promptCache === 'auto' ? 'selected' : ''} onClick={() => props.onPromptCache('auto')}>
                自动
              </button>
              <button type="button" className={props.promptCache === 'off' ? 'selected' : ''} onClick={() => props.onPromptCache('off')}>
                关闭
              </button>
            </div>
          </div>
        </div>
      </>
    );
  }

  const preambleHint = PREAMBLE.find(([id]) => id === props.memoryPreambleMode)?.[2] ?? '';
  return (
    <>
      <div className="cfg-group">
        <h3>记忆库</h3>
        <Switch title="开会话时注入记忆" hint="把长期记忆写进 system prompt" on={props.memInject} onToggle={() => props.onMemInject(!props.memInject)} />
        <Switch title="每轮自动检索" hint="按当前问题去 vault 里捞相关片段" on={props.memSearch} onToggle={() => props.onMemSearch(!props.memSearch)} />
        <Switch title="触发词自动记录" hint="把这轮的结论写回 vault" on={props.memCapture} onToggle={() => props.onMemCapture(!props.memCapture)} />
      </div>

      <div className="cfg-group">
        <h3>注入方式</h3>
        <div className="seg">
          {PREAMBLE.map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={'seg-btn' + (id === props.memoryPreambleMode ? ' selected' : '')}
              onClick={() => props.onMemoryPreambleMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="cfg-note">{preambleHint}</p>
      </div>

      <div className="cfg-group">
        <h3>历史预算</h3>
        <div className="cfg-row">
          <label className="cfg-field">
            <span>最多带多少条</span>
            <input
              className="cfg-mono"
              type="number"
              min={2}
              max={200}
              value={props.maxHistory}
              onChange={(e) => props.onMaxHistory(Number(e.target.value) || 60)}
            />
          </label>
          <label className="cfg-field">
            <span>token 预算</span>
            <input
              className="cfg-mono"
              type="number"
              min={2048}
              step={1000}
              value={props.historyTokenBudget}
              onChange={(e) => props.onHistoryTokenBudget(Math.max(2048, Number(e.target.value) || 8000))}
            />
          </label>
          <label className="cfg-field">
            <span>至少保留轮次</span>
            <input
              className="cfg-mono"
              type="number"
              min={1}
              max={30}
              value={props.minRecentTurns}
              onChange={(e) => props.onMinRecentTurns(Math.min(30, Math.max(1, Number(e.target.value) || 6)))}
            />
          </label>
          <label className="cfg-field">
            <span>摘要上限</span>
            <input
              className="cfg-mono"
              type="number"
              min={256}
              step={250}
              value={props.summaryMaxTokens}
              onChange={(e) => props.onSummaryMaxTokens(Math.max(256, Number(e.target.value) || 3000))}
            />
          </label>
        </div>
        <Switch
          title="超预算时持久化滚动摘要"
          hint="token 预算优先保留近期原文，更早消息压成联系人独立摘要"
          on={props.historySummary}
          onToggle={() => props.onHistorySummary(!props.historySummary)}
        />
      </div>
    </>
  );
}
