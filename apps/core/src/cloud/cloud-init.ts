import {
  buildOneLiner,
  cloudMachineNameSchema,
  hubOriginSchema,
  ONBOARDING_CODE_DISPLAY_RE,
  tailscaleAuthKeySchema,
} from '@hz/shared';

/**
 * cloud-init of a new cloud VM (M22): Docker and Compose from Ubuntu, Tailscale from
 * its official apt repository, `tailscale up` with the auth key from a 0600 file in
 * /run (tmpfs, removed right after, also on failure), then the M11 one-liner with a
 * one-time onboarding code. Every interpolated value passes its schema and a strict
 * character check and is single-quoted; anything else throws before a VM is ordered.
 */

export const TAILSCALE_KEY_FILE = '/run/hz/tailscale.key';
export const SETUP_SCRIPT_FILE = '/run/hz/setup.sh';
const TAILSCALE_REPO = 'https://pkgs.tailscale.com/stable/ubuntu';
const TAILSCALE_KEYRING = '/usr/share/keyrings/tailscale-archive-keyring.gpg';
/**
 * Copies of the user data (and so of the auth key) that cloud-init and the Azure
 * agent leave on disk. Removed after `tailscale up` and again on exit (also on
 * failure). obj.pkl stays: cloud-init needs it to boot the same instance again
 * (without it, it would treat a reboot as a first boot); runcmd and write_files run
 * once per instance, so a reboot never needs these files.
 */
export const USER_DATA_COPIES = [
  '/var/lib/cloud/instance/user-data.txt',
  '/var/lib/cloud/instance/user-data.txt.i',
  '/var/lib/cloud/instance/cloud-config.txt',
  '/var/lib/waagent/ovf-env.xml',
  '/var/lib/waagent/CustomData',
] as const;

export class CloudInitError extends Error {
  constructor(readonly field: 'name' | 'code' | 'key' | 'origin') {
    super(`invalid ${field}`);
    this.name = 'CloudInitError';
  }
}

/** Characters that need no escaping inside single quotes and none in YAML plain/block text. */
const SAFE = /^[A-Za-z0-9._:/@=+-]+$/;

/** Single-quoted shell word; refuses anything outside SAFE (no quote can be closed). */
export function shQuote(v: string, field: CloudInitError['field']): string {
  if (!SAFE.test(v)) throw new CloudInitError(field);
  return `'${v}'`;
}

/** https origin of HZ_BASE_URL, or the loopback dev/test hub of onboardingHub(). */
function checkOrigin(origin: string): string {
  // Strict shape first (hubOriginSchema's refine would throw on some malformed URLs).
  if (!/^https?:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?$/.test(origin)) {
    throw new CloudInitError('origin');
  }
  const dev = /^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(origin);
  let https: boolean;
  try {
    https = hubOriginSchema.safeParse(origin).success;
  } catch {
    https = false;
  }
  if (!dev && !https) throw new CloudInitError('origin');
  return origin;
}

const ONE_LINER_RE =
  /^curl -fsSL https?:\/\/[A-Za-z0-9.-]{1,253}(:[0-9]{1,5})?\/install\.sh \| sudo sh -s -- [2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/;

export interface CloudInitInput {
  /** Machine name: Tailscale host name. */
  name: string;
  /** Tailscale auth key (write-only setting). */
  tailscaleAuthKey: string;
  /** Hub origin, only from onboardingHub(config). */
  hubOrigin: string;
  /** Onboarding code in display form XXXX-XXXX. */
  code: string;
}

/** The #cloud-config document (plain text). Contains the auth key: never log it. */
export function renderCloudInit(input: CloudInitInput): string {
  const name = cloudMachineNameSchema.safeParse(input.name);
  if (!name.success || name.data !== input.name) throw new CloudInitError('name');
  if (!tailscaleAuthKeySchema.safeParse(input.tailscaleAuthKey).success) {
    throw new CloudInitError('key');
  }
  if (!ONBOARDING_CODE_DISPLAY_RE.test(input.code)) throw new CloudInitError('code');
  const origin = checkOrigin(input.hubOrigin);
  const oneLiner = buildOneLiner(origin, input.code);
  if (!ONE_LINER_RE.test(oneLiner)) throw new CloudInitError('origin');
  // Re-checked for the shell (also guards the YAML block below).
  const qName = shQuote(input.name, 'name');
  const key = input.tailscaleAuthKey;
  if (!SAFE.test(key)) throw new CloudInitError('key');

  const copies = USER_DATA_COPIES.join(' ');
  const script = [
    '#!/bin/sh',
    'set -eu',
    `trap 'rm -f ${TAILSCALE_KEY_FILE} ${copies}' EXIT`,
    'export DEBIAN_FRONTEND=noninteractive',
    'systemctl enable --now docker',
    `curl -fsSL ${TAILSCALE_REPO}/noble.noarmor.gpg -o ${TAILSCALE_KEYRING}`,
    `curl -fsSL ${TAILSCALE_REPO}/noble.tailscale-keyring.list -o /etc/apt/sources.list.d/tailscale.list`,
    'apt-get update',
    'apt-get install -y tailscale',
    'systemctl enable --now tailscaled',
    `tailscale up --auth-key=file:${TAILSCALE_KEY_FILE} --hostname=${qName}`,
    `rm -f ${TAILSCALE_KEY_FILE}`,
    // cloud-init and waagent keep copies of the user data (with the key) on disk.
    `rm -f ${copies}`,
    oneLiner,
  ];
  const indent = (lines: string[]): string => lines.map((l) => `      ${l}`).join('\n');
  return [
    '#cloud-config',
    'package_update: true',
    'packages:',
    '  - docker.io',
    '  - docker-compose-v2',
    '  - curl',
    '  - ca-certificates',
    'write_files:',
    `  - path: ${TAILSCALE_KEY_FILE}`,
    "    permissions: '0600'",
    '    owner: root:root',
    '    content: |',
    indent([key]),
    `  - path: ${SETUP_SCRIPT_FILE}`,
    "    permissions: '0700'",
    '    owner: root:root',
    '    content: |',
    indent(script),
    'runcmd:',
    `  - [sh, ${SETUP_SCRIPT_FILE}]`,
    `  - [rm, -f, ${SETUP_SCRIPT_FILE}]`,
    '',
  ].join('\n');
}

/** customData of the VM: base64 of the document. */
export function cloudInitCustomData(input: CloudInitInput): string {
  return Buffer.from(renderCloudInit(input), 'utf8').toString('base64');
}
