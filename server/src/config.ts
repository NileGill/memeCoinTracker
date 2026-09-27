import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env if present (Node >= 20.12 has this built in).
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (key: string) => {
  const v = process.env[key]?.trim();
  return v ? v : undefined;
};

const customRpc = env('SOLANA_RPC_URL');
const jupiterKey = env('JUPITER_API_KEY');

export const config = {
  root: ROOT,
  dataDir: path.join(ROOT, 'data'),
  webDist: path.join(ROOT, 'dist'),
  port: Number(env('PORT') ?? 3000),
  host: env('HOST') ?? '127.0.0.1',

  rpcUrl: customRpc ?? 'https://api.mainnet-beta.solana.com',
  customRpc: Boolean(customRpc),

  // With a key, Jupiter's keyed endpoint is used; otherwise the free lite endpoint.
  jupiterBase: jupiterKey ? 'https://api.jup.ag' : 'https://lite-api.jup.ag',
  jupiterKey,

  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
};

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Majors, stables and liquid-staking tokens that show up in "trending" lists but are not memecoins.
export const NON_MEME_MINTS = new Set<string>([
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', // JUP
  'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', // JTO
  'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', // PYTH
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', // RAY
  'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', // mSOL
  'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', // JitoSOL
  'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // bSOL
  'jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v', // JupSOL
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', // WETH (Wormhole)
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', // WBTC (Wormhole)
  'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij', // cbBTC
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH', // USDG
]);

// Jupiter tags that mark a token as infrastructure rather than a memecoin.
export const NON_MEME_TAGS = new Set(['defi', 'infra', 'lst', 'stablecoin', 'rwa', 'xstocks']);
