import type * as React from 'react';
export type Status = 'ok' | 'warn' | 'crit' | 'off' | 'info' | 'busy';
export type Tone = 'neutral' | 'ok' | 'warn' | 'crit' | 'info' | 'accent';
export type IconName = 'server' | 'container' | 'git' | 'home' | 'globe' | 'bell' | 'power' | 'terminal' | 'refresh' | 'cpu' | 'thermo' | 'plug' | 'lock' | 'wifi' | 'play' | 'stop' | 'check' | 'alert' | 'door' | 'cloud' | 'gamepad' | 'link' | 'copy' | 'users' | 'plus';
export interface IconProps { name: IconName; size?: number; label?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; icon?: IconName }
export declare function Button(props: ButtonProps): React.ReactElement;
export interface StatusDotProps { status?: Status; label?: string; hideLabel?: boolean; pulse?: boolean; className?: string }
export declare function StatusDot(props: StatusDotProps): React.ReactElement;
export interface BadgeProps { tone?: Tone; icon?: IconName; children?: React.ReactNode; className?: string }
export declare function Badge(props: BadgeProps): React.ReactElement;
export interface TileProps { count?: React.ReactNode; flush?: boolean; title?: React.ReactNode; icon?: IconName; status?: Status; statusLabel?: string; actions?: React.ReactNode; footer?: React.ReactNode; span?: 2 | 3 | 4; children?: React.ReactNode; className?: string }
export declare function Tile(props: TileProps): React.ReactElement;
export interface MetricProps { label: string; value: React.ReactNode; unit?: string; delta?: string; deltaTone?: 'ok' | 'warn' | 'crit'; hint?: string; size?: 'default' | 'wall'; className?: string }
export declare function Metric(props: MetricProps): React.ReactElement;
export interface UsageBarProps { cells?: number; label: string; value: number; detail?: string; warnAt?: number; critAt?: number }
export declare function UsageBar(props: UsageBarProps): React.ReactElement;
export interface SparklineProps { data: number[]; width?: number; height?: number; tone?: 'accent' | 'ok' | 'info' | 'muted' }
export declare function Sparkline(props: SparklineProps): React.ReactElement | null;
export interface ServiceRowProps { name: string; host: string; status?: Status; icon?: IconName; meta?: React.ReactNode; actions?: React.ReactNode }
export declare function ServiceRow(props: ServiceRowProps): React.ReactElement;
export interface CommitRowProps { message: string; repo: string; branch?: string; hash: string; time: string; status?: Status; statusLabel?: string; live?: boolean; action?: React.ReactNode }
export declare function CommitRow(props: CommitRowProps): React.ReactElement;
export interface ServerInfo { id: string; name: string; where: string; ip?: string; status?: Status; cpu?: number; ram?: number; disk?: number; uptime?: string; note?: string }
export interface ServerListProps { servers: ServerInfo[]; active?: string; onSelect?: (id: string) => void }
export declare function ServerList(props: ServerListProps): React.ReactElement;
export interface WebCheckRowProps { url: string; host?: string; status?: Status; code?: number | string; ms?: number | null; sslDays?: number; actions?: React.ReactNode }
export declare function WebCheckRow(props: WebCheckRowProps): React.ReactElement;
export interface RepoRowProps { repo: string; branch?: string; commit: string; ci?: 'ok' | 'crit' | 'busy' | 'off'; deployedTo?: string | null; behind?: number; action?: React.ReactNode }
export declare function RepoRow(props: RepoRowProps): React.ReactElement;
export interface GameServerProps { name: string; game: string; version?: string; address: string; status?: Status; players?: [number, number]; ram?: number; ramDetail?: string; tps?: number | null; online?: string[]; host: string }
export declare function GameServer(props: GameServerProps): React.ReactElement;
export interface GameTemplate { id: string; name: string; image: string; ram: string; port: number; fits?: boolean }
export interface GameTemplatesProps { templates: GameTemplate[]; selected?: string; onPick?: (id: string) => void }
export declare function GameTemplates(props: GameTemplatesProps): React.ReactElement;
export interface SharePerm { id: string; label: string; on: boolean }
export interface ShareLinkProps { server: string; user: string; url: string; expires: string; expired?: boolean; lastUsed?: string; perms: SharePerm[] }
export declare function ShareLink(props: ShareLinkProps): React.ReactElement;
export interface BlockBarProps { value: number; cells?: number; warnAt?: number; critAt?: number; label?: string }
export declare function BlockBar(props: BlockBarProps): React.ReactElement;
export interface ToggleProps { label: string; hint?: string; icon?: IconName; checked?: boolean; disabled?: boolean; onChange?: (next: boolean) => void }
export declare function Toggle(props: ToggleProps): React.ReactElement;
export interface AlertProps { tone?: 'ok' | 'warn' | 'crit' | 'info'; title: string; time?: string; floating?: boolean; action?: React.ReactNode; children?: React.ReactNode }
export declare function Alert(props: AlertProps): React.ReactElement;
export interface TerminalLine { text: string; kind?: 'cmd' | 'ok' | 'warn' | 'err' | 'dim' }
export interface TerminalProps { prompt?: string; title?: string; host?: string; lines: Array<string | TerminalLine>; height?: number | string; cursor?: boolean }
export declare function Terminal(props: TerminalProps): React.ReactElement;
export interface NavItem { id: string; label: string; icon: IconName; href?: string; count?: number }
export interface NavRailProps { items: NavItem[]; active?: string; title?: string }
export declare function NavRail(props: NavRailProps): React.ReactElement;
export interface ServerEntry { id: string; name: string; where?: string; status?: Status; icon?: IconName }
export interface ServerSwitchProps { servers: ServerEntry[]; active?: string; onChange?: (id: string) => void }
export declare function ServerSwitch(props: ServerSwitchProps): React.ReactElement;
declare global { interface Window { HZ: { Icon: typeof Icon; Button: typeof Button; StatusDot: typeof StatusDot; Badge: typeof Badge; Tile: typeof Tile; Metric: typeof Metric; UsageBar: typeof UsageBar; Sparkline: typeof Sparkline; ServiceRow: typeof ServiceRow; CommitRow: typeof CommitRow; Toggle: typeof Toggle; Alert: typeof Alert; Terminal: typeof Terminal; NavRail: typeof NavRail; ServerSwitch: typeof ServerSwitch; ServerList: typeof ServerList; WebCheckRow: typeof WebCheckRow; RepoRow: typeof RepoRow; GameServer: typeof GameServer; GameTemplates: typeof GameTemplates; ShareLink: typeof ShareLink; BlockBar: typeof BlockBar } } }
