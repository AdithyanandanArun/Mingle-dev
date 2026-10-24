import {
  createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey,
  diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, sign, verify, type KeyObject,
} from 'node:crypto';
import { DistributedMessageKindSchema } from '../../../../packages/contracts/src/devices.ts';

export const MAX_DISTRIBUTED_PAYLOAD_BYTES = 256 * 1024;
const MAX_ENVELOPE_BYTES = MAX_DISTRIBUTED_PAYLOAD_BYTES + 4096;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;

export interface DeviceKeyMaterial {
  signingPrivateKey: KeyObject;
  signingPublicKey: KeyObject;
  encryptionPrivateKey: KeyObject;
  encryptionPublicKey: KeyObject;
  signingPublicKeyDer: string;
  encryptionPublicKeyDer: string;
  signingPrivateKeyDer: string;
  encryptionPrivateKeyDer: string;
  fingerprint: string;
}

export interface EnvelopeHeader {
  id: string;
  teamId: string;
  fromDeviceId: string;
  toDeviceId: string;
  idempotencyKey: string;
  kind: string;
  createdAt: string;
  expiresAt: string;
}

export interface SignedEnvelope extends EnvelopeHeader {
  ciphertext: string;
  nonce: string;
  signature: string;
}

export function canonicalJson(value: unknown): string {
  const visit = (current: unknown, seen: Set<object>): unknown => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new TypeError('Distributed JSON numbers must be finite.');
      return current;
    }
    if (Array.isArray(current)) {
      if (seen.has(current)) throw new TypeError('Distributed JSON cannot contain cycles.');
      seen.add(current);
      const result = current.map((item) => visit(item, seen));
      seen.delete(current);
      return result;
    }
    if (typeof current === 'object') {
      const object = current as Record<string, unknown>;
      if (Object.getPrototypeOf(object) !== Object.prototype && Object.getPrototypeOf(object) !== null) throw new TypeError('Distributed JSON must contain plain objects.');
      if (seen.has(object)) throw new TypeError('Distributed JSON cannot contain cycles.');
      seen.add(object);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(object).sort()) {
        if (object[key] === undefined) throw new TypeError('Distributed JSON cannot contain undefined values.');
        result[key] = visit(object[key], seen);
      }
      seen.delete(object);
      return result;
    }
    throw new TypeError('Distributed payloads must be JSON values.');
  };
  return JSON.stringify(visit(value, new Set()));
}

export function generateDeviceKeyMaterial(): DeviceKeyMaterial {
  const signing = generateKeyPairSync('ed25519');
  const encryption = generateKeyPairSync('x25519');
  const signingPublicKeyDer = signing.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const encryptionPublicKeyDer = encryption.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const signingPrivateKeyDer = signing.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const encryptionPrivateKeyDer = encryption.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  return {
    signingPrivateKey: signing.privateKey, signingPublicKey: signing.publicKey,
    encryptionPrivateKey: encryption.privateKey, encryptionPublicKey: encryption.publicKey,
    signingPublicKeyDer, encryptionPublicKeyDer, signingPrivateKeyDer, encryptionPrivateKeyDer,
    fingerprint: fingerprintForPublicKeys(signingPublicKeyDer, encryptionPublicKeyDer),
  };
}

export function restoreDeviceKeyMaterial(record: {
  signingPrivateKeyDer: string; signingPublicKeyDer: string; encryptionPrivateKeyDer: string; encryptionPublicKeyDer: string;
}): DeviceKeyMaterial {
  const signingPrivateKey = createPrivateKey({ key: Buffer.from(record.signingPrivateKeyDer, 'base64'), format: 'der', type: 'pkcs8' });
  const signingPublicKey = createPublicKey({ key: Buffer.from(record.signingPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
  const encryptionPrivateKey = createPrivateKey({ key: Buffer.from(record.encryptionPrivateKeyDer, 'base64'), format: 'der', type: 'pkcs8' });
  const encryptionPublicKey = createPublicKey({ key: Buffer.from(record.encryptionPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
  if (!createPublicKey(signingPrivateKey).export({ type: 'spki', format: 'der' }).equals(signingPublicKey.export({ type: 'spki', format: 'der' })) ||
    !createPublicKey(encryptionPrivateKey).export({ type: 'spki', format: 'der' }).equals(encryptionPublicKey.export({ type: 'spki', format: 'der' }))) {
    throw new Error('Stored device key material does not match its public keys.');
  }
  return {
    signingPrivateKey, signingPublicKey, encryptionPrivateKey, encryptionPublicKey,
    ...record, fingerprint: fingerprintForPublicKeys(record.signingPublicKeyDer, record.encryptionPublicKeyDer),
  };
}

export function fingerprintForPublicKeys(signingPublicKeyDer: string, encryptionPublicKeyDer: string): string {
  const digest = createHash('sha256').update('mingle-device-fingerprint-v1\0').update(signingPublicKeyDer).update('\0').update(encryptionPublicKeyDer).digest('hex');
  return `SHA-256:${digest}`;
}

/** Signs a caller-canonicalized public payload with the registered device's Ed25519 identity key. */
export function signDevicePayload(payload: string, keys: DeviceKeyMaterial): string {
  return sign(null, Buffer.from(payload, 'utf8'), keys.signingPrivateKey).toString('base64');
}

/** Verifies an Ed25519 payload with a registered SPKI public key; malformed peer input is a simple rejection. */
export function verifyDevicePayload(payload: string, signature: string, signingPublicKeyDer: string): boolean {
  try {
    const bytes = Buffer.from(signature, 'base64');
    if (bytes.length !== 64 || bytes.toString('base64') !== signature) return false;
    const publicKey = createPublicKey({ key: Buffer.from(signingPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
    return verify(null, Buffer.from(payload, 'utf8'), publicKey, bytes);
  } catch { return false; }
}

function routingHeader(header: EnvelopeHeader): Record<string, string> {
  return {
    id: header.id, teamId: header.teamId, fromDeviceId: header.fromDeviceId, toDeviceId: header.toDeviceId,
    idempotencyKey: header.idempotencyKey, kind: header.kind, createdAt: header.createdAt, expiresAt: header.expiresAt,
  };
}

function envelopeToSign(envelope: SignedEnvelope): string {
  return canonicalJson({
    ...routingHeader(envelope), ciphertext: envelope.ciphertext, nonce: envelope.nonce,
  });
}

function deriveKey(privateKey: KeyObject, peerPublicKeyDer: string, header: EnvelopeHeader): Buffer {
  const peer = createPublicKey({ key: Buffer.from(peerPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
  const secret = diffieHellman({ privateKey, publicKey: peer });
  try {
    return Buffer.from(hkdfSync('sha256', secret, Buffer.from(header.teamId), Buffer.from(`mingle-mailbox-v1:${header.fromDeviceId}:${header.toDeviceId}:${header.id}`), 32));
  } finally { secret.fill(0); }
}

export function sealEnvelope(input: {
  header: EnvelopeHeader;
  payload: unknown;
  sender: DeviceKeyMaterial;
  recipientEncryptionPublicKey: string;
}): SignedEnvelope {
  const kind = DistributedMessageKindSchema.parse(input.header.kind);
  const header = { ...input.header, kind };
  const plaintext = Buffer.from(canonicalJson(input.payload), 'utf8');
  if (plaintext.byteLength > MAX_DISTRIBUTED_PAYLOAD_BYTES) throw new RangeError('Distributed payload exceeds the 256 KiB limit.');
  const nonce = randomBytes(GCM_NONCE_BYTES);
  const key = deriveKey(input.sender.encryptionPrivateKey, input.recipientEncryptionPublicKey, header);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(canonicalJson(routingHeader(header))));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const envelope: SignedEnvelope = {
      ...header, ciphertext: ciphertext.toString('base64'), nonce: nonce.toString('base64'), signature: '',
    };
    envelope.signature = sign(null, Buffer.from(envelopeToSign(envelope)), input.sender.signingPrivateKey).toString('base64');
    if (Buffer.byteLength(envelope.ciphertext, 'base64') > MAX_ENVELOPE_BYTES) throw new RangeError('Distributed envelope exceeds its size limit.');
    return envelope;
  } finally { key.fill(0); plaintext.fill(0); }
}

export function openEnvelope(input: {
  envelope: SignedEnvelope;
  recipient: DeviceKeyMaterial;
  senderSigningPublicKey: string;
  senderEncryptionPublicKey: string;
}): unknown {
  const { envelope } = input;
  DistributedMessageKindSchema.parse(envelope.kind);
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const nonce = Buffer.from(envelope.nonce, 'base64');
  const signature = Buffer.from(envelope.signature, 'base64');
  if (ciphertext.length < GCM_TAG_BYTES || ciphertext.length > MAX_ENVELOPE_BYTES || nonce.length !== GCM_NONCE_BYTES || signature.length !== 64) {
    throw new Error('Distributed envelope has invalid cryptographic fields.');
  }
  const signingKey = createPublicKey({ key: Buffer.from(input.senderSigningPublicKey, 'base64'), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(envelopeToSign(envelope)), signingKey, signature)) throw new Error('Distributed envelope signature is invalid.');
  const key = deriveKey(input.recipient.encryptionPrivateKey, input.senderEncryptionPublicKey, envelope);
  try {
    const body = ciphertext.subarray(0, ciphertext.length - GCM_TAG_BYTES);
    const tag = ciphertext.subarray(ciphertext.length - GCM_TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(canonicalJson(routingHeader(envelope))));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(body), decipher.final()]);
    try {
      if (plaintext.byteLength > MAX_DISTRIBUTED_PAYLOAD_BYTES) throw new RangeError('Distributed payload exceeds the 256 KiB limit.');
      const parsed = JSON.parse(plaintext.toString('utf8')) as unknown;
      // Reject non-canonical/ambiguous encodings before consumers see the payload.
      if (canonicalJson(parsed) !== plaintext.toString('utf8')) throw new Error('Distributed payload is not canonical JSON.');
      return parsed;
    } finally { plaintext.fill(0); }
  } finally { key.fill(0); }
}
