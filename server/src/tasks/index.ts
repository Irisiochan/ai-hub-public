// Public surface of the tasks module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { maybeWriteBackTask } from './taskWriteback.js';
export { VaultTaskProjection } from './vaultProjection.js';
export { vaultTasksRouter } from './vaultTaskRoutes.js';
