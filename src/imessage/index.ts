export { getChats, getRecentMessages, getMessagesSince, getLatestMessageRowId } from './reader.js';
export type { Message, Chat } from './reader.js';

export { sendMessage, sendToChat, checkMessagesAvailable } from './sender.js';
export type { SendResult } from './sender.js';

export { startDaemon } from './daemon.js';
export type { DaemonConfig } from './daemon.js';

export { guardInboundMessage, resetRateLimits, INPUT_GUARD_CONFIG } from './input-guard.js';
export type { InputGuardResult } from './input-guard.js';
