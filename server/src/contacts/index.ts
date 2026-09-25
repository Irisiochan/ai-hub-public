// Public surface of the contacts module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { contactConfig, formatContactConfigError, openContact, validateContactConfig } from './configSchemas.js';
export { contactsRouter, publicContactRow } from './contactRoutes.js';
export { modelCatalog, rememberModelCatalog } from './modelCatalog.js';
export type { ModelOption } from './modelCatalog.js';
export { ensureCodexContact, ensureGrokContact, ensureMuseContact, ensureOpencodeDelegationRunner, ensureRoomOrchestratorCove, seedIfEmpty } from './seed.js';
export { getUserProfile, userRouter } from './userRoutes.js';
