import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TokenView, UltraOrder } from '../../../shared/types';
import { api, SOL_MINT } from '../lib/api';
import { fmtNum, fmtSol, fmtUsd, fromBaseUnits, toBaseUnits } from '../lib/format';
import { connectWallet, getPhantom, PHANTOM_DOWNLOAD, phantomAppLink, refreshHoldings, signAndExecute } from '../lib/phantom';
import { recordSwap, useStore } from '../store';
import { Icon } from './Icon';

const FEE_RESERVE_SOL = 0.01;
const LAMPORTS = 9;

type Phase = 'idle' | 'signing' | 'sending' | 'done' | 'error';

function impactPct(o: UltraOrder): number | null {
  if (typeof o.priceImpact === 'number') return Math.abs(o.priceImpact);
  const p = Number(o.priceImpactPct);
  return Number.isFinite(p) ? Math.abs(p * 100) : null;
}

export function TradePanel({ token, initialSide }: { token: TokenView; initialSide: 'buy' | 'sell' }) {
  const settings = useStore((s) => s.settings);
  const wallet = useStore((s) => s.wallet);
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide);
  const [amountStr, setAmountStr] = useState('');
  const [sellRaw, setSellRaw] = useState<bigint | null>(null);
  const [quote, setQuote] = useState<UltraOrder | null>(null);
  const [quoteErr, setQuoteErr] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [signature, setSignature] = useState<string | null>(null);
  const [impactAck, setImpactAck] = useState(false);
  const quoteSeq = useRef(0);

  useEffect(() => setSide(initialSide), [initialSide, token.mint]);

  // The pinned Buy / Sell bar on phones switches sides from outside the panel.
  useEffect(() => {
    const onSide = (e: Event) => setSide((e as CustomEvent<'buy' | 'sell'>).detail);
    window.addEventListener('memeradar:trade-side', onSide);
    return () => window.removeEventListener('memeradar:trade-side', onSide);
  }, []);

  const holding = wallet.holdings?.tokens.find((h) => h.mint === token.mint) ?? null;
  const decimals = token.decimals ?? holding?.decimals ?? null;
  const solBalance = wallet.holdings?.sol ?? null;

  // ---- what the user asked for, in base units
  const amountRaw: bigint | null = useMemo(() => {
    if (side === 'buy') return toBaseUnits(amountStr, LAMPORTS);
    if (sellRaw !== null) return sellRaw;
    return decimals === null ? null : toBaseUnits(amountStr, decimals);
  }, [side, amountStr, sellRaw, decimals]);

  const inputMint = side === 'buy' ? SOL_MINT : token.mint;
  const outputMint = side === 'buy' ? token.mint : SOL_MINT;

  const validation: string | null = useMemo(() => {
    if (amountRaw === null || amountRaw <= 0n) return null;
    if (side === 'buy') {
      const sol = fromBaseUnits(amountRaw, LAMPORTS);
      if (sol > settings.maxTradeSol)
        return `That's above your max trade size of ${settings.maxTradeSol} SOL. You can change it in Settings.`;
      if (solBalance !== null && sol + FEE_RESERVE_SOL > solBalance)
        return `Not enough SOL. You have ${fmtSol(solBalance)} and about ${FEE_RESERVE_SOL} SOL is kept for fees.`;
    } else {
      if (!wallet.address) return null;
      if (!holding) return `You don't hold any ${token.symbol}.`;
      if (amountRaw > BigInt(holding.amountRaw)) return `You only have ${fmtNum(holding.uiAmount)} ${token.symbol}.`;
    }
    return null;
  }, [amountRaw, side, settings.maxTradeSol, solBalance, holding, wallet.address, token.symbol]);

  // ---- live quote (debounced, refreshed every 12s)
  const fetchQuote = useCallback(async () => {
    if (amountRaw === null || amountRaw <= 0n || validation) {
      setQuote(null);
      setQuoteErr(null);
      return;
    }
    const seq = ++quoteSeq.current;
    setQuoting(true);
    try {
      const o = await api.order({ inputMint, outputMint, amount: amountRaw.toString(), taker: wallet.address ?? undefined });
      if (seq !== quoteSeq.current) return;
      setQuote(o);
      setQuoteErr(o.errorMessage && !o.outAmount ? o.errorMessage : null);
    } catch (e) {
      if (seq !== quoteSeq.current) return;
      setQuote(null);
      setQuoteErr((e as Error).message);
    } finally {
      if (seq === quoteSeq.current) setQuoting(false);
    }
  }, [amountRaw, validation, inputMint, outputMint, wallet.address]);

  useEffect(() => {
    if (phase === 'signing' || phase === 'sending') return;
    setImpactAck(false);
    const t = setTimeout(fetchQuote, 450);
    const i = setInterval(fetchQuote, 12_000);
    return () => {
      clearTimeout(t);
      clearInterval(i);
    };
  }, [fetchQuote, phase]);

  // Reset when switching token or side.
  useEffect(() => {
    setAmountStr('');
    setSellRaw(null);
    setQuote(null);
    setQuoteErr(null);
    setPhase('idle');
    setMessage(null);
    setSignature(null);
  }, [token.mint, side]);

  const impact = quote ? impactPct(quote) : null;
  const highImpact = impact !== null && impact > 15;
  const outDecimals = side === 'buy' ? decimals : LAMPORTS;
  const outUi = quote && outDecimals !== null ? fromBaseUnits(quote.outAmount, outDecimals) : null;
  const busy = phase === 'signing' || phase === 'sending';
  const phantomMissing = !wallet.available && !getPhantom();

  async function submit() {
    setMessage(null);
    setSignature(null);
    if (amountRaw === null || amountRaw <= 0n) return;
    try {
      let taker = wallet.address;
      if (!taker) taker = await connectWallet();
      setPhase('signing');
      // Always sign a fresh order: quotes expire within seconds.
      const order = await api.order({ inputMint, outputMint, amount: amountRaw.toString(), taker });
      if (!order.transaction) throw new Error(order.errorMessage || order.error || 'Jupiter could not build this trade.');
      const freshImpact = impactPct(order);
      if (freshImpact !== null && freshImpact > 15 && !impactAck)
        throw new Error(`Price impact jumped to ${freshImpact.toFixed(1)}%. Review the quote and confirm again.`);
      const result = await signAndExecute(order, { inputMint, outputMint, amount: amountRaw.toString(), taker });
      setPhase('sending');
      if (result.status === 'Success' && result.signature) {
        setSignature(result.signature);
        setPhase('done');
        const inDec = side === 'buy' ? LAMPORTS : (decimals ?? 0);
        const outDec = side === 'buy' ? (decimals ?? 0) : LAMPORTS;
        recordSwap({
          signature: result.signature,
          time: Date.now(),
          side,
          mint: token.mint,
          symbol: token.symbol,
          inAmount: fromBaseUnits(result.inputAmountResult ?? order.inAmount, inDec),
          outAmount: fromBaseUnits(result.outputAmountResult ?? order.outAmount, outDec),
        });
        setMessage(side === 'buy' ? `Bought ${token.symbol}.` : `Sold ${token.symbol}.`);
        setAmountStr('');
        setSellRaw(null);
        setTimeout(() => void refreshHoldings(), 1500);
        setTimeout(() => void refreshHoldings(), 7000);
      } else {
        if (result.signature) setSignature(result.signature);
        throw new Error(result.error || 'The swap failed on-chain. No tokens were exchanged.');
      }
    } catch (e) {
      setPhase('error');
      setMessage((e as Error).message);
    }
  }

  const presetsSell = [25, 50, 75, 100];

  return (
    <div className="trade" id="trade-panel">
      <div className="row">
        <div className="seg">
          <button className={side === 'buy' ? 'on buy' : ''} onClick={() => setSide('buy')}>
            Buy
          </button>
          <button className={side === 'sell' ? 'on sell' : ''} onClick={() => setSide('sell')}>
            Sell
          </button>
        </div>
        <span className="spacer" />
        {wallet.address ? (
          <span className="muted num" style={{ fontSize: 12.5, textAlign: 'right' }}>
            {side === 'buy' ? (
              <>Balance {fmtSol(solBalance)}</>
            ) : (
              <>
                Holding {holding ? fmtNum(holding.uiAmount) : '0'} {token.symbol}
              </>
            )}
          </span>
        ) : (
          <span className="dim" style={{ fontSize: 12.5 }}>
            Wallet not connected
          </span>
        )}
      </div>

      <div className="amount-box">
        <input
          inputMode="decimal"
          placeholder="0.00"
          value={amountStr}
          disabled={busy}
          onChange={(e) => {
            const v = e.target.value.replace(/,/g, '.');
            if (/^\d*\.?\d*$/.test(v)) {
              setAmountStr(v);
              setSellRaw(null);
              if (phase === 'done' || phase === 'error') {
                setPhase('idle');
                setMessage(null);
              }
            }
          }}
        />
        <span className="unit">{side === 'buy' ? 'SOL' : token.symbol}</span>
      </div>

      {side === 'buy' ? (
        <div className="presets">
          {settings.buyPresets.map((p) => (
            <button key={p} className="btn sm" disabled={busy} onClick={() => setAmountStr(String(p))}>
              {p} SOL
            </button>
          ))}
        </div>
      ) : (
        <div className="presets four">
          {presetsSell.map((p) => (
            <button
              key={p}
              className="btn sm"
              disabled={busy || !holding}
              onClick={() => {
                if (!holding) return;
                const raw = (BigInt(holding.amountRaw) * BigInt(p)) / 100n;
                setSellRaw(raw);
                setAmountStr(String(fromBaseUnits(raw, holding.decimals)));
              }}
            >
              {p}%
            </button>
          ))}
        </div>
      )}

      {validation && <div className="notice amber">{validation}</div>}

      {!validation && (quote || quoting || quoteErr) && (
        <div className="quote">
          {quoteErr ? (
            <span className="down">{quoteErr}</span>
          ) : quote ? (
            <>
              <div className="qrow">
                <span className="muted">You receive (est.)</span>
                <b className="num">
                  {outUi !== null ? `${fmtNum(outUi, 4)} ${side === 'buy' ? token.symbol : 'SOL'}` : fmtUsd(quote.outUsdValue)}
                </b>
              </div>
              <div className="qrow">
                <span className="muted">Value</span>
                <span className="num">
                  {fmtUsd(quote.inUsdValue)} → {fmtUsd(quote.outUsdValue)}
                </span>
              </div>
              <div className="qrow">
                <span className="muted">Price impact</span>
                <span className={`num ${impact !== null && impact > 5 ? (highImpact ? 'down' : 'warn') : ''}`}>
                  {impact !== null ? `${impact.toFixed(2)}%` : '—'}
                </span>
              </div>
              <div className="qrow">
                <span className="muted">Route</span>
                <span className="truncate" style={{ maxWidth: 220 }}>
                  {quote.routePlan?.map((r) => r.swapInfo.label).filter(Boolean).join(' → ') || quote.swapType || 'Jupiter'}
                  {quote.feeBps != null && <span className="dim"> · fee {(quote.feeBps / 100).toFixed(2)}%</span>}
                </span>
              </div>
              {quote.errorMessage && <div className="warn">{quote.errorMessage}</div>}
            </>
          ) : (
            <span className="muted">Getting the best price…</span>
          )}
        </div>
      )}

      {highImpact && !validation && (
        <label className="notice red row" style={{ cursor: 'pointer', alignItems: 'flex-start' }}>
          <input type="checkbox" checked={impactAck} onChange={(e) => setImpactAck(e.target.checked)} style={{ marginTop: 3 }} />
          <span>
            Price impact is {impact!.toFixed(1)}%: you'd lose a large share of this trade to slippage. Tick to confirm
            anyway, or trade a smaller amount.
          </span>
        </label>
      )}

      {phantomMissing ? (
        phantomAppLink() ? (
          <a className="btn primary lg wide" href={phantomAppLink()!}>
            Open in the Phantom app to trade
          </a>
        ) : (
          <a className="btn primary lg wide" href={PHANTOM_DOWNLOAD} target="_blank" rel="noreferrer">
            Install Phantom to trade
          </a>
        )
      ) : (
        <button
          className={`btn lg wide ${side === 'buy' ? 'buy' : 'sell'}`}
          disabled={
            busy ||
            amountRaw === null ||
            amountRaw <= 0n ||
            Boolean(validation) ||
            Boolean(quoteErr) ||
            (highImpact && !impactAck) ||
            (side === 'sell' && Boolean(wallet.address) && !holding)
          }
          onClick={submit}
        >
          {busy ? (
            <>
              <Icon name="refresh" size={15} className="spin" /> {phase === 'signing' ? 'Approve in Phantom…' : 'Sending…'}
            </>
          ) : !wallet.address ? (
            'Connect Phantom & ' + (side === 'buy' ? 'buy' : 'sell')
          ) : side === 'buy' ? (
            `Buy ${token.symbol}`
          ) : (
            `Sell ${token.symbol}`
          )}
        </button>
      )}

      {phase === 'done' && message && (
        <div className="notice green">
          {message}{' '}
          {signature && (
            <a href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              View transaction
            </a>
          )}
        </div>
      )}
      {phase === 'error' && message && (
        <div className="notice red">
          {message}{' '}
          {signature && (
            <a href={`https://solscan.io/tx/${signature}`} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline' }}>
              View transaction
            </a>
          )}
        </div>
      )}

      <div className="dim" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        Swaps route through Jupiter and are signed in your Phantom wallet. Your keys never touch this site. On-chain
        trades are final.
      </div>
    </div>
  );
}
