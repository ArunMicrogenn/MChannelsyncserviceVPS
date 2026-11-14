import crypto from 'node:crypto';

function getEncryptionKey(): Buffer {
  const hex = process.env.MCHANNEL_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('MCHANNEL_ENCRYPTION_KEY must be a 64-character hex string (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptSecret(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const [ivHex, tagHex, dataHex] = ciphertext.split(':');
  if (!ivHex || !tagHex || !dataHex) {
    throw new Error('Invalid encrypted secret format');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  signatureHeader: string,
  rawBody: Buffer
): { valid: boolean; skewSeconds: number } {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || ts <= 0) {
    return { valid: false, skewSeconds: 999999 };
  }
  const skewSeconds = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (skewSeconds > 300) {
    return { valid: false, skewSeconds };
  }

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody.toString('utf8')}`, 'utf8')
    .digest('hex')
    .toLowerCase();

  const provided = signatureHeader.trim().toLowerCase();
  if (expected.length !== provided.length) {
    return { valid: false, skewSeconds };
  }
  const valid = crypto.timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(provided, 'utf8'));
  return { valid, skewSeconds };
}
