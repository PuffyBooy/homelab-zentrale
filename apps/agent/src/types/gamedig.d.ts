/** Minimal typings for gamedig 5 (the package ships none); only what game.status uses. */
declare module 'gamedig' {
  export interface QueryOptions {
    type: string;
    host: string;
    port?: number;
    maxRetries?: number;
    socketTimeout?: number;
    attemptTimeout?: number;
    givenPortOnly?: boolean;
    portCache?: boolean;
    requestRules?: boolean;
    requestPlayers?: boolean;
    username?: string;
    password?: string;
  }
  export interface QueryPlayer {
    name?: string;
    raw?: unknown;
  }
  export interface QueryResult {
    name: string;
    map: string;
    password: boolean;
    numplayers?: number;
    maxplayers: number;
    players: QueryPlayer[];
    bots: QueryPlayer[];
    version: string;
    ping: number;
    connect: string;
  }
  export class GameDig {
    constructor(opts?: { listenUdpPort?: number });
    query(options: QueryOptions): Promise<QueryResult>;
    static query(options: QueryOptions): Promise<QueryResult>;
  }
}
