import { hash, verify } from '@node-rs/argon2';

// argon2id (the library default) with the OWASP baseline: 19 MiB, t=2, p=1.
const options = { memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32 } as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, options);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Hash used when the username does not exist, so a failed login costs the same
 * time either way (no username enumeration via timing).
 */
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword('hz-dummy-password-not-used');
  return dummy;
}
