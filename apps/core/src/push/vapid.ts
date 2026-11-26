import { generateVAPIDKeys } from 'web-push';
import { z } from 'zod';
import type { SecretBox } from '../crypto.js';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/settings.js';

export interface VapidKeys {
  publicKey: string;
  /** Secret. Never logged, never in a response. */
  privateKey: string;
}

export const VAPID_SETTING = 'push.vapid';
const AAD = 'settings.push.vapid';

const storedSchema = z.strictObject({
  publicKey: z.string().regex(/^[A-Za-z0-9_-]{80,100}$/),
  privateKeyEnc: z.string().min(1),
});

/**
 * VAPID key pair: from HZ_VAPID_PUBLIC/HZ_VAPID_PRIVATE if set, otherwise
 * generated on first start and stored in `settings` with the private key
 * encrypted (AES-256-GCM, crypto.ts).
 */
export function loadVapidKeys(
  db: Db,
  box: SecretBox,
  now: number,
  fromEnv: VapidKeys | undefined,
): { keys: VapidKeys; source: 'env' | 'db' | 'generated' } {
  if (fromEnv) return { keys: fromEnv, source: 'env' };
  const stored = storedSchema.safeParse(readSetting(db, VAPID_SETTING));
  if (stored.success) {
    try {
      return {
        keys: {
          publicKey: stored.data.publicKey,
          privateKey: box.decrypt(stored.data.privateKeyEnc, AAD),
        },
        source: 'db',
      };
    } catch {
      // Unreadable (other HZ_SECRET_KEY): generate a new pair. Browsers then
      // have to subscribe again, which the settings page offers.
    }
  }
  const generated = generateVAPIDKeys();
  writeSetting(
    db,
    VAPID_SETTING,
    {
      publicKey: generated.publicKey,
      privateKeyEnc: box.encrypt(generated.privateKey, AAD),
    },
    now,
  );
  return { keys: generated, source: 'generated' };
}
