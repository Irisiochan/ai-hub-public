// Public surface of the heartbeat module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { CompanionHeartbeat } from './companionHeartbeat.js';
export { heartbeatRouter } from './heartbeatRoutes.js';
