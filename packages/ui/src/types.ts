// Mirrors design/reference/index.d.ts. Keep both in sync.
export type Status = 'ok' | 'warn' | 'crit' | 'off' | 'info' | 'busy';
export type Tone = 'neutral' | 'ok' | 'warn' | 'crit' | 'info' | 'accent';
export type IconName =
  | 'server'
  | 'container'
  | 'git'
  | 'home'
  | 'globe'
  | 'bell'
  | 'power'
  | 'terminal'
  | 'refresh'
  | 'cpu'
  | 'thermo'
  | 'plug'
  | 'lock'
  | 'wifi'
  | 'play'
  | 'stop'
  | 'check'
  | 'alert'
  | 'door'
  | 'cloud'
  | 'gamepad'
  | 'link'
  | 'copy'
  | 'users'
  | 'plus';
