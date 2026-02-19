export { getMessagesSince, getLatestMessageRowId } from './reader.js';
export type { Message, Chat } from './reader.js';

export { sendMessage, checkMessagesAvailable } from './sender.js';
export type { SendResult } from './sender.js';

export { startDaemon } from './daemon.js';

export { guardInboundMessage } from './input-guard.js';
