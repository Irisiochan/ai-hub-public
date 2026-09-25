// Public surface of the runtime module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { AgentManager } from './manager.js';
export { messagesRouter } from './messageRoutes.js';
export { contactModelRouter } from './modelRoutes.js';
export { createRoomTaskDispatcher } from './roomTaskDispatch.js';
export type { AgentDeps, DmTurnResult } from './runtime.js';
