import { createHash } from 'node:crypto';
import Parser from 'rss-parser';
import type { NewsItem } from '../../../shared/types';
import { registerPersisted } from '../lib/cache';
import { fetchText } from '../lib/http';
import { markError, markOk, registerSource } from '../lib/status';

interface Feed {
  id: string;
  name: string;
  url: string;
  /** Every item from this feed counts as memecoin news. */
  memeFeed?: boolean;
  everyMs: number;
}

const FEEDS: Feed[] = [
  { id: 'ct-meme', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss/tag/memecoin', memeFeed: true, everyMs: 180_000 },
  { id: 'reddit-memecoins', name: 'r/memecoins', url: 'https://www.reddit.com/r/memecoins/.rss', memeFeed: true, everyMs: 420_000 },
  { id: 'ct', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', everyMs: 180_000 },
  { id: 'coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', everyMs: 180_000 },
  { id: 'decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', everyMs: 180_000 },
  { id: 'theblock', name: 'The Block', url: 'https://www.theblock.co/rss.xml', everyMs: 240_000 },
  { id: 'cryptoslate', name: 'CryptoSlate', url: 'https://cryptoslate.com/feed/', everyMs: 240_000 },
  { id: 'cryptonews', name: 'Cryptonews', url: 'https://cryptonews.com/news/feed/', everyMs: 240_000 },
  { id: 'beincrypto', name: 'BeInCrypto', url: 'https://beincrypto.com/feed/', everyMs: 240_000 },
  { id: 'cryptopotato', name: 'CryptoPotato', url: 'https://cryptopotato.com/feed/', everyMs: 300_000 },
  { id: 'bitcoinist', name: 'Bitcoinist', url: 'https://bitcoinist.com/feed/', everyMs: 300_000 },
  { id: 'newsbtc', name: 'NewsBTC', url: 'https://www.newsbtc.com/feed/', everyMs: 300_000 },
  { id: 'utoday', name: 'U.Today', url: 'https://u.today/rss', everyMs: 300_000 },
  { id: 'defiant', name: 'The Defiant', url: 'https://thedefiant.io/api/feed', everyMs: 300_000 },
];

// Well-known memecoins, matched as whole words in headlines.
const MEME_TICKERS = [
  'DOGE', 'SHIB', 'PEPE', 'BONK', 'WIF', 'FLOKI', 'TRUMP', 'MELANIA', 'POPCAT', 'MEW', 'BRETT', 'FARTCOIN',
  'PENGU', 'SPX', 'MOODENG', 'PNUT', 'GOAT', 'NEIRO', 'TURBO', 'MOG', 'BOME', 'WOJAK', 'GIGA', 'MICHI',
  'PONKE', 'SLERF', 'MYRO', 'CHILLGUY', 'AI16Z', 'USELESS', 'BABYDOGE',
];
const MEME_TICKER_RE = new RegExp(`\\b(${MEME_TICKERS.join('|')})\\b`, 'g');
const MEME_WORDS_RE =
  /\b(meme ?coins?|meme[- ]token|memecoin|pump\.?fun|letsbonk|bonk\.fun|dogecoin|shiba inu|pepe|bonk|dogwifhat|fartcoin|pudgy penguins|rug ?pull|degen|launchpad|solana meme|community takeover)\b/i;
const CASHTAG_RE = /\$([A-Za-z][A-Za-z0-9]{1,9})\b/g;

// rss-parser is only used to parse; its built-in HTTP client can hang, so fetching uses fetch() with a hard timeout.
const parser: Parser = new Parser({
  customFields: {
    item: [
      ['media:content', 'mediaContent', { keepArray: false }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: false }],
    ],
  },
});

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

const stripHtml = (s: string) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function pickImage(item: Record<string, unknown>): string | null {
  const candidates: unknown[] = [
    (item.enclosure as { url?: string } | undefined)?.url,
    (item.mediaContent as { $?: { url?: string } } | undefined)?.$?.url,
    (item.mediaThumbnail as { $?: { url?: string } } | undefined)?.$?.url,
  ];
  const html = String(item['content:encoded'] ?? item.content ?? '');
  const m = /<img[^>]+src="([^"]+)"/i.exec(html);
  if (m) candidates.push(m[1]);
  for (const c of candidates) {
    if (typeof c === 'string' && /^https:\/\//.test(c) && !/\.(mp4|mp3|webm)(\?|$)/i.test(c)) return decodeEntities(c);
  }
  return null;
}

const items = new Map<string, NewsItem>();
const listeners: ((items: NewsItem[]) => void)[] = [];

export function newsList(): NewsItem[] {
  return [...items.values()].sort((a, b) => b.published - a.published).slice(0, 300);
}

export function onNews(fn: (items: NewsItem[]) => void) {
  listeners.push(fn);
}

registerPersisted(
  'news',
  () => newsList(),
  (value) => {
    if (!Array.isArray(value)) return;
    for (const n of value as NewsItem[]) if (n?.id && !items.has(n.id)) items.set(n.id, n);
  },
);

async function poll(feed: Feed) {
  try {
    const xml = await fetchText(feed.url, {
      timeoutMs: 15_000,
      headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8' },
    });
    const parsed = await parser.parseString(xml);
    let added = 0;
    for (const raw of parsed.items ?? []) {
      const it = raw as unknown as Record<string, unknown>;
      const link = String(it.link ?? '').trim();
      const title = stripHtml(String(it.title ?? ''));
      if (!link || !title) continue;
      const id = createHash('sha1').update(link.replace(/[?#].*$/, '')).digest('hex').slice(0, 16);
      if (items.has(id)) continue;
      const published = Date.parse(String(it.isoDate ?? it.pubDate ?? '')) || Date.now();
      if (Date.now() - published > 3 * 86_400_000) continue; // keep the feed current
      const summary = stripHtml(String(it.contentSnippet ?? it.content ?? it.summary ?? '')).slice(0, 280);
      const text = `${title} ${summary}`;
      const tickers = new Set<string>();
      for (const m of title.matchAll(MEME_TICKER_RE)) tickers.add(m[1]);
      for (const m of text.matchAll(CASHTAG_RE)) {
        const t = m[1].toUpperCase();
        if (!/^\d/.test(t) && t !== 'USD') tickers.add(t);
      }
      const meme = Boolean(feed.memeFeed) || MEME_WORDS_RE.test(text) || [...title.matchAll(MEME_TICKER_RE)].length > 0;
      items.set(id, {
        id,
        title,
        url: link,
        source: feed.name,
        published: Math.min(published, Date.now()),
        summary,
        image: pickImage(it),
        meme,
        tickers: [...tickers].slice(0, 6),
      });
      added++;
    }
    // Bound memory: drop the oldest beyond 600 items.
    if (items.size > 600) {
      const sorted = [...items.values()].sort((a, b) => a.published - b.published);
      for (const old of sorted.slice(0, items.size - 600)) items.delete(old.id);
    }
    markOk('news');
    if (added > 0) {
      const list = newsList();
      for (const fn of listeners) fn(list);
    }
  } catch (e) {
    markError('news', new Error(`${feed.name}: ${e instanceof Error ? e.message : String(e)}`));
  }
}

export function startNews() {
  registerSource('news', 'News feeds');
  FEEDS.forEach((feed, i) => {
    // Stagger start-up so all feeds don't hit at once.
    setTimeout(() => {
      void poll(feed);
      setInterval(() => void poll(feed), feed.everyMs);
    }, i * 1500);
  });
}

