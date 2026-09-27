import type { Response } from 'express';

/** Server-Sent Events hub. Every open browser tab is one client. */
const clients = new Set<Response>();
const perIp = new Map<string, number>();
const MAX_CLIENTS = 300;
const MAX_PER_IP = 8;

export function canAcceptClient(ip: string) {
  return clients.size < MAX_CLIENTS && (perIp.get(ip) ?? 0) < MAX_PER_IP;
}

export function addClient(res: Response, ip: string) {
  clients.add(res);
  perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
  res.on('close', () => {
    clients.delete(res);
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
  });
}

export function clientCount() {
  return clients.size;
}

/** compression() buffers output; flush so each event reaches the browser immediately. */
function flush(res: Response) {
  (res as Response & { flush?: () => void }).flush?.();
}

export function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  flush(res);
}

export function broadcast(event: string, data: unknown) {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(frame);
    flush(res);
  }
}

setInterval(() => {
  for (const res of clients) {
    res.write(`: ping ${Date.now()}\n\n`);
    flush(res);
  }
}, 15_000).unref();
