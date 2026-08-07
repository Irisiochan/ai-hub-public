import crypto from 'node:crypto';
import { MAX_IMAGE_BYTES } from '../attachments.js';
import type { WechatMessageItem } from './protocol.js';

export interface DownloadedWechatImage {
  bytes: Buffer;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
}

export function parseWechatAesKey(encoded: string): Buffer {
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-f]{32}$/i.test(decoded.toString('ascii'))) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw new Error(`invalid WeChat AES key length ${decoded.length}`);
}

function imageMimeType(bytes: Buffer): DownloadedWechatImage['mimeType'] {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  throw new Error('unsupported WeChat image format');
}

async function responseBytes(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`WeChat CDN HTTP ${response.status}`);
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES + 16) {
    throw new Error('WeChat image exceeds 10 MB');
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES + 16) throw new Error('WeChat image exceeds 10 MB');
  return bytes;
}

export async function downloadWechatImage(
  item: WechatMessageItem,
  cdnBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DownloadedWechatImage> {
  const image = item.image_item;
  const media = image?.media;
  if (!media || (!media.full_url && !media.encrypt_query_param)) {
    throw new Error('WeChat image has no CDN reference');
  }
  const url = media.full_url
    ? new URL(media.full_url)
    : new URL(
        `download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param ?? '')}`,
        cdnBaseUrl.endsWith('/') ? cdnBaseUrl : `${cdnBaseUrl}/`,
      );
  if (url.protocol !== 'https:') throw new Error('WeChat CDN URL must use https');
  const encrypted = await responseBytes(await fetchImpl(url));
  const key = image?.aeskey
    ? Buffer.from(image.aeskey, 'hex')
    : media.aes_key
      ? parseWechatAesKey(media.aes_key)
      : null;
  if (key && key.length !== 16) throw new Error(`invalid WeChat AES key length ${key.length}`);
  let bytes = encrypted;
  if (key) {
    const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
    bytes = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error('WeChat image exceeds 10 MB');
  return { bytes, mimeType: imageMimeType(bytes) };
}
