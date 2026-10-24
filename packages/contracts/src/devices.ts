import { z } from 'zod';

export const DistributedMessageKindSchema = z.string().trim().min(1).max(100)
  .regex(/^(execution|collaboration|git|command|teamchat|teamgroup)\.[a-z][a-z0-9.-]*$/, 'Unsupported distributed message kind');
export type DistributedMessageKind = z.infer<typeof DistributedMessageKindSchema>;

export const RegisterDeviceSchema = z.object({ teamId: z.string().uuid(), name: z.string().trim().min(1).max(100) }).strict();
export type RegisterDeviceInput = z.infer<typeof RegisterDeviceSchema>;

export const LinkDeviceSchema = z.object({
  teamId: z.string().uuid(), deviceId: z.string().uuid(), fingerprint: z.string().regex(/^SHA-256:[0-9a-f]{64}$/),
}).strict();
export type LinkDeviceInput = z.infer<typeof LinkDeviceSchema>;

export const RevokeDeviceSchema = z.object({ teamId: z.string().uuid(), deviceId: z.string().uuid() }).strict();
export type RevokeDeviceInput = z.infer<typeof RevokeDeviceSchema>;

export const SendDistributedMessageSchema = z.object({
  teamId: z.string().uuid(), toDeviceId: z.string().uuid(), kind: DistributedMessageKindSchema,
  payload: z.unknown(), idempotencyKey: z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
}).strict();
export type SendDistributedMessageInput = z.infer<typeof SendDistributedMessageSchema>;

export type DistributedDeviceStatus = 'online' | 'offline' | 'revoked';
export interface DistributedDevice {
  id: string;
  teamId: string;
  ownerId: string;
  name: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  fingerprint: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: DistributedDeviceStatus;
}

export interface DistributedDeviceLink {
  teamId: string;
  deviceId: string;
  peerDeviceId: string;
  peerFingerprint: string;
  createdAt: string;
  /** True only when both devices have pinned each other's current key fingerprint. */
  mutual: boolean;
}

export type DistributedOutboxStatus = 'queued' | 'delivered' | 'expired';
export interface DistributedOutboxItem {
  id: string;
  teamId: string;
  toDeviceId: string;
  kind: DistributedMessageKind;
  createdAt: string;
  expiresAt: string;
  status: DistributedOutboxStatus;
  attempts: number;
  error: string | null;
}

export type TransportStatus = 'ready' | 'offline' | 'signed-out' | 'unregistered' | 'error';
export interface TransportSnapshot {
  deviceId: string | null;
  devices: DistributedDevice[];
  links: DistributedDeviceLink[];
  outbox: DistributedOutboxItem[];
  status: TransportStatus;
  error: string | null;
}

export interface AuthenticatedTransportMessage<TPayload = unknown> {
  id: string;
  teamId: string;
  fromDeviceId: string;
  toDeviceId: string;
  kind: DistributedMessageKind;
  payload: TPayload;
}
