import type { Config } from '../config.js';

/**
 * Where agents connect: wss://<host of HZ_BASE_URL>/agent through `tailscale
 * serve`, or the local core when no base URL is set (development).
 */
export function agentCoreUrl(config: Pick<Config, 'baseUrl' | 'port'>): string {
  if (config.baseUrl) return `wss://${new URL(config.baseUrl).host}/agent`;
  return `ws://127.0.0.1:${config.port}/agent`;
}

/** Container name, same as deploy/docker-compose.agent.yml. */
export const AGENT_CONTAINER = 'homelab-agent';

const CAPS = [
  'SYS_ADMIN',
  'SYS_PTRACE',
  'SYS_CHROOT',
  'DAC_READ_SEARCH',
  'DAC_OVERRIDE',
  'CHOWN',
  'FOWNER',
  'FSETID',
  'SETUID',
  'SETGID',
  'NET_RAW',
];

/**
 * Copy-ready one-liner and compose snippet (SPEC 5.3), with the same rights as
 * deploy/docker-compose.agent.yml (see the comments there for why each is
 * needed). Name and token are validated by the route (agentNameSchema,
 * base64url token), so they are safe in a shell line. The enrollment token is
 * single-use and expires after 15 min; the agent then keeps its own token in
 * the /data volume.
 */
export function enrollSnippets(
  config: Pick<Config, 'baseUrl' | 'port' | 'agentImage'>,
  name: string,
  token: string,
): { dockerRun: string; compose: string } {
  const url = agentCoreUrl(config);
  const image = config.agentImage;
  const env: [string, string][] = [
    ['HZ_CORE_URL', url],
    ['HZ_AGENT_NAME', name],
    ['HZ_AGENT_TOKEN', token],
    ['HZ_AGENT_ALLOW_TERMINAL', '0'],
    ['HZ_AGENT_DATA', '/data'],
    ['HZ_AGENT_HOST_EXEC', 'nsenter'],
    ['HZ_AGENT_HOST_PROC', '/host/proc'],
    ['HZ_AGENT_HOST_ROOT', '/host/proc/1/root'],
  ];
  const dockerRun = [
    `docker run -d --name ${AGENT_CONTAINER} --restart unless-stopped`,
    '--user 0:0 --network host --pid host --read-only --tmpfs /tmp',
    '--cap-drop ALL',
    ...CAPS.map((c) => `--cap-add ${c}`),
    '--security-opt no-new-privileges:true --security-opt apparmor=unconfined',
    '-v /var/run/docker.sock:/var/run/docker.sock',
    '-v /proc:/host/proc:ro -v /sys:/host/sys:ro',
    '-v /opt/homelab:/opt/homelab',
    '-v homelab-agent-data:/data',
    ...env.map(([k, v]) => `-e ${k}=${v}`),
    image,
  ].join(' ');
  const compose = `services:
  agent:
    image: ${image}
    container_name: ${AGENT_CONTAINER}
    restart: unless-stopped
    user: '0:0'
    pid: host
    network_mode: host
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    cap_add:
${CAPS.map((c) => `      - ${c}`).join('\n')}
    security_opt:
      - no-new-privileges:true
      - apparmor=unconfined
    environment:
${env.map(([k, v]) => `      ${k}: '${v}'`).join('\n')}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /proc:/host/proc:ro
      - /sys:/host/sys:ro
      - /opt/homelab:/opt/homelab
      - agent-data:/data
volumes:
  agent-data:
`;
  return { dockerRun, compose };
}
