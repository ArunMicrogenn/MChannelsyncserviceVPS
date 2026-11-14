import crypto from 'node:crypto';
import firebaseConfig from '../../firebase-applet-config.json';

function getEncryptionKey(): Buffer {
  const raw = process.env.MCHANNEL_ENCRYPTION_KEY;
  if (raw && /^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const seed = raw && raw.length >= 12 ? raw : `${firebaseConfig.projectId}:${firebaseConfig.firestoreDatabaseId}:mchannel-sync-key`;
  return crypto.createHash('sha256').update(seed).digest();
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted credential');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

export function computeWebhookSignature(secret: string, timestamp: string, rawBody: Buffer | string): string {
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${bodyStr}`, 'utf8')
    .digest('hex')
    .toLowerCase();
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  signatureHeader: string,
  rawBody: Buffer | string
): { valid: boolean; skewSeconds: number } {
  const tsNum = Number(timestamp);
  if (!Number.isFinite(tsNum) || tsNum <= 0) {
    return { valid: false, skewSeconds: 999999 };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const skewSeconds = Math.abs(nowSec - tsNum);
  if (skewSeconds > 300) {
    return { valid: false, skewSeconds };
  }

  const expected = computeWebhookSignature(secret, timestamp, rawBody);
  const provided = signatureHeader.trim().toLowerCase();
  if (expected.length !== provided.length) {
    return { valid: false, skewSeconds };
  }
  const valid = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  return { valid, skewSeconds };
}
