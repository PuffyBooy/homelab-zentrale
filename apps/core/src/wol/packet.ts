import dgram from 'node:dgram';

export const MAGIC_PACKET_BYTES = 102;
/** Bind + send of one datagram; anything longer is a broken socket. */
export const UDP_SEND_TIMEOUT_MS = 3_000;

/** "AA:BB:CC:DD:EE:FF" -> 6 x 0xFF followed by the 6 MAC bytes 16 times (102 bytes). */
export function magicPacket(mac: string): Buffer {
  if (!/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}$/.test(mac)) throw new Error('invalid mac');
  const macBytes = Buffer.from(mac.replaceAll(':', ''), 'hex');
  const packet = Buffer.alloc(MAGIC_PACKET_BYTES, 0xff);
  for (let i = 0; i < 16; i++) macBytes.copy(packet, 6 + i * 6);
  return packet;
}

/** Sends one UDP broadcast datagram from the core (injectable for tests). */
export interface UdpSender {
  send(packet: Buffer, port: number, address: string): Promise<void>;
}

/** node:dgram, IPv4, SO_BROADCAST on, socket closed after the one datagram. */
export const dgramSender: UdpSender = {
  send(packet, port, address) {
    return new Promise<void>((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      let done = false;
      const finish = (err: Error | null): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Already closed.
        }
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error('udp send timeout')), UDP_SEND_TIMEOUT_MS);
      socket.on('error', () => finish(new Error('udp send failed')));
      socket.bind(() => {
        if (done) return;
        try {
          socket.setBroadcast(true);
          socket.send(packet, port, address, (err) =>
            finish(err ? new Error('udp send failed') : null),
          );
        } catch {
          finish(new Error('udp send failed'));
        }
      });
    });
  },
};
