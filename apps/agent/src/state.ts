import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { agentTokenSchema } from '@hz/shared';

/** Contents of /data/agent.json. */
export const agentStateSchema = z.strictObject({
  agentToken: agentTokenSchema,
  serverId: z.string().max(64),
  savedAt: z.iso.datetime(),
});
export type AgentState = z.infer<typeof agentStateSchema>;

export const STATE_FILE = 'agent.json';

export async function loadState(dataDir: string): Promise<AgentState | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dataDir, STATE_FILE), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = agentStateSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Writes the state atomically: a temp file in the same directory with mode
 * 0600 (created exclusively, never following an existing file), fsync, rename.
 */
export async function saveState(dataDir: string, state: AgentState): Promise<void> {
  agentStateSchema.parse(state);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  const target = path.join(dataDir, STATE_FILE);
  const tmp = path.join(dataDir, `.${STATE_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  const fh = await open(tmp, 'wx', 0o600);
  try {
    await fh.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
    await fh.sync();
  } catch (err) {
    await fh.close();
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await fh.close();
  await chmod(tmp, 0o600);
  await rename(tmp, target);
}
