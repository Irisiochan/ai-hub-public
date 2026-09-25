// Public surface of the prompt module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { compactSummaryText, summaryNeedsTimeAnchorUpgrade, touchConversationSummary } from './conversationSummary.js';
export { ConversationSummaryRepo, SHARED_SUMMARY_MEMBER_ID } from './conversationSummaryRepo.js';
export { gemHeartbeatHistory } from './gemHeartbeatHistory.js';
export { chooseKeepFrom } from './historyPolicy.js';
export { PromptComposer } from './promptComposer.js';
export type { PromptContext, StartPrompt } from './promptComposer.js';
export { TOOL_RESULT_MAX_CHARS, compressToolResultForInjection } from './selectiveCompress.js';
export { estimateTokens } from './tokenEstimate.js';
