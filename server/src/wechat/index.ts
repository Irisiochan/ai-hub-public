// Public surface of the wechat module: the only file other modules may import.
// Keep it to what other modules actually use (server/test/moduleBoundaries.test.mts).
export { WechatChannel } from './channel.js';
export { loadWechatChannelConfig } from './config.js';
