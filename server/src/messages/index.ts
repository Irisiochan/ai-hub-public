// Public surface of the messages module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { attachmentsRouter } from './attachmentRoutes.js';
export { ALLOWED_IMAGE_TYPES, MAX_IMAGES_PER_MESSAGE, MAX_IMAGE_BYTES, attachmentDataUrl, attachmentPathsForMessages, attachmentsForMessage, cleanupOrphanUploads, deleteMessageFiles, hardDeleteMessages, persistImage, persistImageBuffer, withAttachments, withAttachmentsMany } from './attachments.js';
export { CaptionService } from './captionService.js';
export { journalRouter } from './journalRoutes.js';
export { MessageRepo } from './messageRepo.js';
export type { RoomDeliveryRow } from './messageRepo.js';
export { automationMeta, frameAutomatedTurn, legacyAutomationDescriptor, normalizeAutomationDescriptor, replyTriggerMeta } from './messageSource.js';
export type { AutomationDescriptor } from './messageSource.js';
export { getMessageReadState, markMessagesRead, readStatesForContact } from './readState.js';
export { historicalMessageText } from './sideChannel.js';
export { UsageRepo } from './usageRepo.js';
