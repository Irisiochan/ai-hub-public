// Public surface of the companion module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { heartbeatReceipt, heartbeatWriteTool, retryableHeartbeatError } from './heartbeatPolicy.js';
export { LifeEventRepo, LifeEventService } from './lifeEvents.js';
