interface Props {
  provider: string;
  model: string;
  visionModel: string;
  imageSupport: 'auto' | 'on' | 'off';
  baseUrl: string;
  apiKey: string;
  apiKeyPlaceholder: string;
  systemPrompt: string;
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

export default function ApiFields(props: Props) {
  return (
    <div className="api-fields-grid">
      <section className="config-section api-connection-section">
        <h3>模型与连接</h3>
        <div className="api-connection-grid">
          <label className="field">
            协议
            <select value={props.provider} onChange={(event) => props.onProvider(event.target.value)}>
              <option value="openai-compat">OpenAI 兼容（GLM/DeepSeek/…）</option>
              <option value="anthropic">Anthropic</option>
              <option value="gemini">Gemini 原生</option>
            </select>
          </label>
          <label className="field">模型<input value={props.model} onChange={(event) => props.onModel(event.target.value)} placeholder="glm-4-plus" /></label>
          <label className="field api-grid-wide">
            图片模型（可选）
            <input value={props.visionModel} onChange={(event) => props.onVisionModel(event.target.value)} placeholder="例如 qwen3-vl-plus；留空则沿用普通模型" />
            <span className="field-hint">只在消息含图片时使用，不改变日常文字聊天模型。</span>
          </label>
          <label className="field api-grid-wide">
            图片支持
            <select value={props.imageSupport} onChange={(event) => props.onImageSupport(event.target.value as Props['imageSupport'])}>
              <option value="auto">自动（按模型判断，deepseek 等纯文字模型自动去图）</option>
              <option value="on">支持（多模态模型）</option>
              <option value="off">不支持（纯文字，含图历史降级为文字占位）</option>
            </select>
            <span className="field-hint">纯文字模型遇到含图历史时会自动剥图并换成文字占位。</span>
          </label>
          <label className="field api-grid-wide">
            完整 API URL
            <input value={props.baseUrl} onChange={(event) => props.onBaseUrl(event.target.value)} placeholder={props.provider === 'anthropic' ? 'https://api.anthropic.com/v1/messages' : props.provider === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse' : 'https://api.openai.com/v1/chat/completions'} />
            <span className="field-hint">请求原样发到这里，不再自动追加 /v1/… 路径。</span>
          </label>
          <label className="field api-grid-wide">API Key<input type="password" value={props.apiKey} onChange={(event) => props.onApiKey(event.target.value)} placeholder={props.apiKeyPlaceholder} /></label>
        </div>
      </section>

      <section className="config-section api-context-section">
        <h3>人设与上下文</h3>
        <label className="field">人设 / 系统提示<textarea rows={4} value={props.systemPrompt} onChange={(event) => props.onSystemPrompt(event.target.value)} placeholder="这个 AI 是谁、怎么说话" /></label>
        <div className="field-row">
          <label className="field">历史条数<input type="number" min={2} max={200} value={props.maxHistory} onChange={(event) => props.onMaxHistory(Number(event.target.value) || 60)} /></label>
          <label className="field">历史 token 预算<input type="number" min={2048} step={1000} value={props.historyTokenBudget} onChange={(event) => props.onHistoryTokenBudget(Math.max(2048, Number(event.target.value) || 8000))} /></label>
          <label className="field">近期轮数<input type="number" min={1} max={30} value={props.minRecentTurns} onChange={(event) => props.onMinRecentTurns(Math.min(30, Math.max(1, Number(event.target.value) || 6)))} /></label>
        </div>
        <label className="compact-check"><input type="checkbox" checked={props.historySummary} onChange={(event) => props.onHistorySummary(event.target.checked)} />超预算时持久化滚动摘要</label>
        <p className="field-hint">历史条数是硬上限；token 预算优先保留近期原文，更早消息压成联系人独立摘要。</p>
      </section>

      <section className="config-section api-memory-section">
        <h3>记忆与缓存</h3>
        <label className="field">滚动摘要上限（token）<input type="number" min={256} step={250} value={props.summaryMaxTokens} onChange={(event) => props.onSummaryMaxTokens(Math.max(256, Number(event.target.value) || 3000))} /></label>
        <label className="field">
          记忆前缀
          <select value={props.memoryPreambleMode} onChange={(event) => props.onMemoryPreambleMode(event.target.value as Props['memoryPreambleMode'])}>
            <option value="compact">compact（推荐，核心身份 + 动态检索）</option><option value="full">full（完整 get_context）</option><option value="off">off（不注入固定前缀）</option>
          </select>
        </label>
        <label className="field">
          Prompt cache
          <select value={props.promptCache} onChange={(event) => props.onPromptCache(event.target.value as Props['promptCache'])}>
            <option value="auto">auto（推荐）</option><option value="off">off（不打标、不展示命中）</option>
          </select>
        </label>
        <fieldset className="mem-toggles">
          <legend>记忆库</legend>
          <label><input type="checkbox" checked={props.memInject} onChange={(event) => props.onMemInject(event.target.checked)} />开局注入核心记忆</label>
          <label><input type="checkbox" checked={props.memSearch} onChange={(event) => props.onMemSearch(event.target.checked)} />每轮自动检索</label>
          <label><input type="checkbox" checked={props.memCapture} onChange={(event) => props.onMemCapture(event.target.checked)} />触发词自动记录</label>
        </fieldset>
      </section>
    </div>
  );
}
