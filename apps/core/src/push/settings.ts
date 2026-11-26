import { notifySettingsSchema, type NotifySettings } from '@hz/shared';
import type { z } from 'zod';
import type { notifySettingsPatchSchema } from '@hz/shared';
import type { Db } from '../db/index.js';
import { readSetting, writeSetting } from '../db/settings.js';

export const NOTIFY_SETTING = 'notify';

/** Stored settings merged over the defaults (23:00-07:00, 30 min, report on). */
export function readNotifySettings(db: Db): NotifySettings {
  const parsed = notifySettingsSchema.safeParse(readSetting(db, NOTIFY_SETTING) ?? {});
  return parsed.success ? parsed.data : notifySettingsSchema.parse({});
}

export function patchNotifySettings(
  db: Db,
  patch: z.infer<typeof notifySettingsPatchSchema>,
  now: number,
): NotifySettings {
  const next = notifySettingsSchema.parse({ ...readNotifySettings(db), ...patch });
  writeSetting(db, NOTIFY_SETTING, next, now);
  return next;
}
