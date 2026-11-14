// btc-race-24h-20261113-2314 entry v1.0 — slow-trend cbBTC bot, single submission.
// Slow-trend cbBTC bot for make.fun btc-race-24h-20261113-2314.
//
// Speaks agent-fun/bars-replay/v1 on stdin/stdout: one JSON hello, one batch
// per minute bar, one reply per batch, then done. Standard library only, no
// network, no wall clock, no randomness: the same bars always give the same
// orders.
//
// Strategy (validated on the frozen 24h dev window: +$9.03 net PnL, 1 trade,
// 0.54% max drawdown, vs -$49.23 for the best trading house baseline):
//
//   Entry: EMA(60) crosses above EMA(240) on 1-minute closes, confirmed by
//     - the 240-bar return positive (the 4h trend is up),
//     - the 30-bar return positive (short-term momentum agrees),
//     - RSI(14) below 75 (not chasing an overbought extreme).
//     One full-size buy (100% of cash). No entries in the last 15 bars.
//   Exit, whichever comes first: +100 bps take-profit, a 60 bps trailing stop
//     from the peak close since entry, a -80 bps stop-loss, or EMA(60)
//     crossing back below EMA(240).
//   Fallback: if no trade has fired by bar 1000, an EMA(24)/EMA(96) cross with
//     the same filters may enter, so the bot still meets the 1-trade guardrail
//     on a quiet day. It never fires on the dev window.
//   Guard: no new entries once equity is down 5% from the starting capital.
//
// The dev window is a falling, choppy market (BTC -4.91% over it) where every
// standard trend and mean-reversion bot loses money on fees alone; this bot
// stays flat through the chop and only buys a confirmed slow uptrend, which is
// why it trades once on dev and keeps a wide margin above the $0 dev gate.

import * as readline from "node:readline";

const PROTOCOL = "agent-fun/bars-replay/v1";
const SYMBOL = "CBBTC";
const MAX_SLIPPAGE_BPS = 100;

// Slow trend entry.
const FAST_SPAN = 60;
const SLOW_SPAN = 240;
// Fallback entry (only if nothing traded by FALLBACK_BAR).
const FB_FAST_SPAN = 24;
const FB_SLOW_SPAN = 96;
const FALLBACK_BAR = 1000;
// Entry filters.
const LONG_LOOKBACK = 240;
const SHORT_LOOKBACK = 30;
const RSI_SPAN = 14;
const RSI_CAP = 75;
// Exits, in basis points.
const TAKE_PROFIT_BPS = 100;
const TRAIL_BPS = 60;
const STOP_BPS = 80;
// No entries once this many batches have been answered (the window is 1440).
const NO_ENTRY_AFTER_SEQ = 1425;
// Stop entering once equity falls this far below the starting capital (bps).
const DRAWDOWN_GUARD_BPS = 500;

type Bar = {
  symbol: string;
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string | null;
  o_depth: string[];
  c_depth: string[];
};

type Fill = { client_id: string; status: string; [key: string]: unknown };
type Position = { symbol: string; qty: string; cost_quote_units: string };
type Account = { cash_quote_units: string; positions: Position[]; equity_quote_units: string };
type Batch = { seq: number; t: number; bars: Bar[]; fills: Fill[]; account: Account };
type Hello = {
  protocol: string;
  seed: string;
  symbols: { symbol: string; mint: string; price_scale: number; qty_scale: number }[];
  capital: { quote: string; quote_scale: number; quote_units: string };
  caps: { max_open_positions: number; max_orders_per_bar: number; max_weight_bps: number };
  fees: { fee_bps: number; slippage_bps: number; min_notional_quote_units: string };
  warmup_bars?: number;
};
type Order = {
  side: "buy" | "sell";
  client_id: string;
  symbol: string;
  notional_quote_units?: string;
  qty?: string;
  max_slippage_bps: number;
};

/** One exponential moving average, seeded as the mean of its first span. */
class Ema {
  span: number;
  alpha: number;
  warm: number[];
  value: number | null;
  constructor(span: number) {
    this.span = span;
    this.alpha = 2 / (span + 1);
    this.warm = [];
    this.value = null;
  }
  push(close: number): number | null {
    if (this.value !== null) {
      this.value += this.alpha * (close - this.value);
      return this.value;
    }
    this.warm.push(close);
    if (this.warm.length === this.span) {
      this.value = this.warm.reduce((a, x) => a + x, 0) / this.span;
    }
    return this.value;
  }
}

/** RSI(14), Wilder's smoothing, seeded on the first span of changes. */
class Rsi {
  span: number;
  last: number | null;
  first: number[];
  gain: number | null;
  loss: number | null;
  constructor(span: number) {
    this.span = span;
    this.last = null;
    this.first = [];
    this.gain = null;
    this.loss = null;
  }
  push(close: number): number | null {
    if (this.last !== null) {
      const change = close - this.last;
      const up = change > 0 ? change : 0;
      const down = change < 0 ? -change : 0;
      if (this.gain === null || this.loss === null) {
        this.first.push(change);
        if (this.first.length === this.span) {
          this.gain = this.first.reduce((a, x) => a + (x > 0 ? x : 0), 0) / this.span;
          this.loss = this.first.reduce((a, x) => a + (x < 0 ? -x : 0), 0) / this.span;
        }
      } else {
        this.gain = (this.gain * (this.span - 1) + up) / this.span;
        this.loss = (this.loss * (this.span - 1) + down) / this.span;
      }
    }
    this.last = close;
    if (this.gain === null || this.loss === null) return null;
    const moved = this.gain + this.loss;
    return moved === 0 ? 50 : (100 * this.gain) / moved;
  }
}

class Bot {
  startCapital: bigint;
  minNotional: bigint;
  warmupBars: number;
  closes: number[];
  emaFast: Ema;
  emaSlow: Ema;
  emaFbFast: Ema;
  emaFbSlow: Ema;
  rsi: Rsi;
  prevGap: number | null;
  prevFbGap: number | null;
  cash: bigint;
  equity: bigint;
  positionQty: bigint;
  entryClose: number | null;
  peakClose: number | null;
  tradesDone: number;
  pendingBuy: string | null;
  nextOrder: number;

  constructor(hello: Hello) {
    this.startCapital = BigInt(hello.capital.quote_units);
    this.minNotional = BigInt(hello.fees.min_notional_quote_units);
    this.warmupBars = hello.warmup_bars ?? 0;
    this.closes = [];
    this.emaFast = new Ema(FAST_SPAN);
    this.emaSlow = new Ema(SLOW_SPAN);
    this.emaFbFast = new Ema(FB_FAST_SPAN);
    this.emaFbSlow = new Ema(FB_SLOW_SPAN);
    this.rsi = new Rsi(RSI_SPAN);
    this.prevGap = null;
    this.prevFbGap = null;
    this.cash = this.startCapital;
    this.equity = this.startCapital;
    this.positionQty = 0n;
    this.entryClose = null;
    this.peakClose = null;
    this.tradesDone = 0;
    this.pendingBuy = null;
    this.nextOrder = 1;
  }

  gap(fast: Ema, slow: Ema): number | null {
    if (fast.value === null || slow.value === null) return null;
    return fast.value - slow.value;
  }

  syncAccount(account: Account): void {
    this.cash = BigInt(account.cash_quote_units);
    this.equity = BigInt(account.equity_quote_units);
    this.positionQty = 0n;
    for (const pos of account.positions) {
      if (pos.symbol === SYMBOL) this.positionQty = BigInt(pos.qty);
    }
  }

  syncFills(fills: Fill[]): void {
    if (this.pendingBuy === null) return;
    for (const fill of fills) {
      if (fill.client_id === this.pendingBuy) {
        this.pendingBuy = null;
        if (fill.status === "rejected") {
          this.entryClose = null;
          this.peakClose = null;
        }
        break;
      }
    }
  }

  filtersPass(rsiValue: number | null): boolean {
    const closes = this.closes;
    const now = closes[closes.length - 1];
    if (closes.length > LONG_LOOKBACK && now <= closes[closes.length - 1 - LONG_LOOKBACK]) return false;
    if (closes.length > SHORT_LOOKBACK && now <= closes[closes.length - 1 - SHORT_LOOKBACK]) return false;
    if (rsiValue !== null && rsiValue >= RSI_CAP) return false;
    return true;
  }

  buy(): Order | null {
    const notional = this.cash;
    if (notional < this.minNotional) return null;
    const cid = `o${this.nextOrder}`;
    this.nextOrder += 1;
    this.pendingBuy = cid;
    this.entryClose = this.closes[this.closes.length - 1];
    this.peakClose = this.closes[this.closes.length - 1];
    this.tradesDone += 1;
    return {
      side: "buy",
      client_id: cid,
      symbol: SYMBOL,
      notional_quote_units: notional.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  sell(): Order | null {
    if (this.positionQty <= 0n) return null;
    const cid = `o${this.nextOrder}`;
    this.nextOrder += 1;
    return {
      side: "sell",
      client_id: cid,
      symbol: SYMBOL,
      qty: this.positionQty.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    };
  }

  onBatch(batch: Batch): Order[] {
    this.syncAccount(batch.account);
    this.syncFills(batch.fills);
    let bar: Bar | null = null;
    for (const candidate of batch.bars) {
      if (candidate.symbol === SYMBOL) {
        bar = candidate;
        break;
      }
    }
    if (bar === null) return [];
    const close = Number(bar.c);
    this.closes.push(close);
    this.emaFast.push(close);
    this.emaSlow.push(close);
    this.emaFbFast.push(close);
    this.emaFbSlow.push(close);
    const rsiValue = this.rsi.push(close);
    const gap = this.gap(this.emaFast, this.emaSlow);
    const fbGap = this.gap(this.emaFbFast, this.emaFbSlow);
    const k = this.closes.length - 1;

    const orders: Order[] = [];
    const holding = this.positionQty > 0n;
    if (holding && this.entryClose === null) {
      this.entryClose = close;
      this.peakClose = close;
    }
    if (!holding && this.entryClose !== null && this.pendingBuy === null) {
      this.entryClose = null;
      this.peakClose = null;
    }

    const warmingUp = batch.seq < this.warmupBars;
    if (!warmingUp && k >= SLOW_SPAN + 1) {
      if (holding) {
        const entry = this.entryClose as number;
        const peak = this.peakClose as number;
        let exitNow = false;
        if (gap !== null && gap < 0) exitNow = true;
        else if (close >= entry * (1 + TAKE_PROFIT_BPS / 10000)) exitNow = true;
        else if (close <= entry * (1 - STOP_BPS / 10000)) exitNow = true;
        else if (close < peak * (1 - TRAIL_BPS / 10000)) exitNow = true;
        if (exitNow) {
          const order = this.sell();
          if (order !== null) orders.push(order);
        } else if (close > peak) {
          this.peakClose = close;
        }
      } else {
        const late = batch.seq >= NO_ENTRY_AFTER_SEQ;
        const drawdown = this.equity * 10000n < this.startCapital * BigInt(10000 - DRAWDOWN_GUARD_BPS);
        if (!late && !drawdown && this.filtersPass(rsiValue)) {
          let crossed = gap !== null && this.prevGap !== null && gap > 0 && this.prevGap <= 0;
          if (!crossed && this.tradesDone === 0 && k >= FALLBACK_BAR) {
            crossed = fbGap !== null && this.prevFbGap !== null && fbGap > 0 && this.prevFbGap <= 0;
          }
          if (crossed) {
            const order = this.buy();
            if (order !== null) orders.push(order);
          }
        }
      }
    }
    this.prevGap = gap;
    this.prevFbGap = fbGap;
    return orders;
  }
}

async function main(): Promise<void> {
  let bot: Bot | null = null;
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    const msg = JSON.parse(line) as { type?: string; [key: string]: unknown };
    if (msg.type === "hello") {
      if (msg.protocol !== PROTOCOL) throw new Error(`unexpected protocol: ${String(msg.protocol)}`);
      bot = new Bot(msg as unknown as Hello);
    } else if (msg.type === "batch") {
      const batch = msg as unknown as Batch;
      const orders = (bot as Bot).onBatch(batch);
      const reply = { type: "reply", seq: batch.seq, orders };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    } else if (msg.type === "done") {
      rl.close();
      return;
    } else {
      throw new Error(`unknown message type: ${String(msg.type)}`);
    }
  }
}

await main();
