import type { Response } from 'express';

/** Server-Sent Events hub. Every open browser tab is one client. */
const clients = new Set<Response>();

export function addClient(res: Response) {
  clients.add(res);
  res.on('close', () => clients.delete(res));
}

export function clientCount() {
  return clients.size;
}

export function send(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function broadcast(event: string, data: unknown) {
  if (clients.size === 0) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

setInterval(() => {
  for (const res of clients) res.write(`: ping ${Date.now()}\n\n`);
}, 15_000).unref();
