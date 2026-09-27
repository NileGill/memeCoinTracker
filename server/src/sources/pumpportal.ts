import WebSocket from 'ws';
import { markError, markOk, registerSource } from '../lib/status';

export interface PumpCreate {
  mint: string;
  creator: string | null;
  initialBuySol: number | null;
  marketCapSol: number | null;
  pool: string;
  name: string | null;
  symbol: string | null;
}

export interface PumpMigration {
  mint: string;
  pool: string | null;
}

interface Handlers {
  onCreate: (c: PumpCreate) => void;
  onMigration: (m: PumpMigration) => void;
}

const URL = 'wss://pumpportal.fun/api/data';
const ID = 'pumpportal';

/** Real-time pump.fun launches and graduations. Reconnects with backoff forever. */
export function startPumpPortal(h: Handlers) {
  registerSource(ID, 'pump.fun live stream');
  let attempt = 0;
  let lastMessage = Date.now();
  let ws: WebSocket | null = null;

  const connect = () => {
    ws = new WebSocket(URL, { handshakeTimeout: 15_000 });

    ws.on('open', () => {
      attempt = 0;
      lastMessage = Date.now();
      ws?.send(JSON.stringify({ method: 'subscribeNewToken' }));
      ws?.send(JSON.stringify({ method: 'subscribeMigration' }));
      markOk(ID);
      console.log('[pumpportal] connected');
    });

    ws.on('message', (raw) => {
      lastMessage = Date.now();
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (typeof m.mint !== 'string') return;
      markOk(ID);
      if (m.txType === 'create') {
        h.onCreate({
          mint: m.mint,
          creator: typeof m.traderPublicKey === 'string' ? m.traderPublicKey : null,
          initialBuySol: typeof m.solAmount === 'number' ? m.solAmount : null,
          marketCapSol: typeof m.marketCapSol === 'number' ? m.marketCapSol : null,
          pool: typeof m.pool === 'string' ? m.pool : 'pump',
          name: typeof m.name === 'string' ? m.name : null,
          symbol: typeof m.symbol === 'string' ? m.symbol : null,
        });
      } else if (m.txType === 'migrate' || m.txType === 'migration') {
        h.onMigration({ mint: m.mint, pool: typeof m.pool === 'string' ? m.pool : null });
      }
    });

    ws.on('error', (e) => markError(ID, e));

    ws.on('close', () => {
      ws = null;
      attempt += 1;
      const delay = Math.min(60_000, 2_000 * 2 ** Math.min(attempt, 5));
      setTimeout(connect, delay);
    });
  };

  connect();

  // pump.fun launches every few seconds; a silent socket for 2 minutes is dead.
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN && Date.now() - lastMessage > 120_000) {
      markError(ID, new Error('stream went quiet, reconnecting'));
      ws.terminate();
    }
  }, 30_000).unref();
}
