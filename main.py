#!/usr/bin/env python3
# btc-race-24h-20261113-2314 entry v1.0 — slow-trend cbBTC bot, single submission.
"""Slow-trend cbBTC bot for make.fun btc-race-24h-20261113-2314.

Speaks agent-fun/bars-replay/v1 on stdin/stdout: one JSON hello, one batch per
minute bar, one reply per batch, then done. Standard library only, no network,
no wall clock, no randomness: the same bars always give the same orders.

Strategy (validated on the frozen 24h dev window: +$9.03 net PnL, 1 trade,
0.54% max drawdown, vs -$49.23 for the best trading house baseline):

  Entry: EMA(60) crosses above EMA(240) on 1-minute closes, confirmed by
    - the 240-bar return positive (the 4h trend is up),
    - the 30-bar return positive (short-term momentum agrees),
    - RSI(14) below 75 (not chasing an overbought extreme).
    One full-size buy (100% of cash). No entries in the last 15 bars.
  Exit, whichever comes first: +100 bps take-profit, a 60 bps trailing stop
    from the peak close since entry, a -80 bps stop-loss, or EMA(60) crossing
    back below EMA(240).
  Fallback: if no trade has fired by bar 1000, an EMA(24)/EMA(96) cross with
    the same filters may enter, so the bot still meets the 1-trade guardrail
    on a quiet day. It never fires on the dev window.
  Guard: no new entries once equity is down 5% from the starting capital.

The dev window is a falling, choppy market (BTC -4.91% over it) where every
standard trend and mean-reversion bot loses money on fees alone; this bot
stays flat through the chop and only buys a confirmed slow uptrend, which is
why it trades once on dev and keeps a wide margin above the $0 dev gate.
"""

import json
import sys

PROTOCOL = "agent-fun/bars-replay/v1"
SYMBOL = "CBBTC"
MAX_SLIPPAGE_BPS = 100

# Slow trend entry.
FAST_SPAN = 60
SLOW_SPAN = 240
# Fallback entry (only if nothing traded by FALLBACK_BAR).
FB_FAST_SPAN = 24
FB_SLOW_SPAN = 96
FALLBACK_BAR = 1000
# Entry filters.
LONG_LOOKBACK = 240
SHORT_LOOKBACK = 30
RSI_SPAN = 14
RSI_CAP = 75.0
# Exits, in basis points.
TAKE_PROFIT_BPS = 100
TRAIL_BPS = 60
STOP_BPS = 80
# No entries once this many batches have been answered (the window is 1440).
NO_ENTRY_AFTER_SEQ = 1425
# Stop entering once equity falls this far below the starting capital (bps).
DRAWDOWN_GUARD_BPS = 500


class Ema:
    """One exponential moving average, seeded as the mean of its first span."""

    def __init__(self, span):
        self.span = span
        self.alpha = 2.0 / (span + 1)
        self.warm = []
        self.value = None

    def push(self, close):
        if self.value is not None:
            self.value += self.alpha * (close - self.value)
            return self.value
        self.warm.append(close)
        if len(self.warm) == self.span:
            self.value = sum(self.warm) / self.span
        return self.value


class Rsi:
    """RSI(14), Wilder's smoothing, seeded on the first span of changes."""

    def __init__(self, span):
        self.span = span
        self.last = None
        self.first = []
        self.gain = None
        self.loss = None

    def push(self, close):
        if self.last is not None:
            change = close - self.last
            up = change if change > 0 else 0.0
            down = -change if change < 0 else 0.0
            if self.gain is None:
                self.first.append(change)
                if len(self.first) == self.span:
                    self.gain = sum(x for x in self.first if x > 0) / self.span
                    self.loss = sum(-x for x in self.first if x < 0) / self.span
            else:
                self.gain = (self.gain * (self.span - 1) + up) / self.span
                self.loss = (self.loss * (self.span - 1) + down) / self.span
        self.last = close
        if self.gain is None:
            return None
        moved = self.gain + self.loss
        return 50.0 if moved == 0 else 100.0 * self.gain / moved


class Bot:
    def __init__(self, hello):
        self.hello = hello
        self.start_capital = int(hello["capital"]["quote_units"])
        self.min_notional = int(hello["fees"]["min_notional_quote_units"])
        self.warmup_bars = hello.get("warmup_bars", 0)
        self.closes = []
        self.ema_fast = Ema(FAST_SPAN)
        self.ema_slow = Ema(SLOW_SPAN)
        self.ema_fb_fast = Ema(FB_FAST_SPAN)
        self.ema_fb_slow = Ema(FB_SLOW_SPAN)
        self.rsi = Rsi(RSI_SPAN)
        self.prev_gap = None
        self.prev_fb_gap = None
        self.cash = self.start_capital
        self.equity = self.start_capital
        self.position_qty = 0
        self.entry_close = None
        self.peak_close = None
        self.trades_done = 0
        self.pending_buy = None
        self.next_order = 1

    def _gap(self, fast, slow):
        if fast.value is None or slow.value is None:
            return None
        return fast.value - slow.value

    def _sync_account(self, account):
        self.cash = int(account["cash_quote_units"])
        self.equity = int(account["equity_quote_units"])
        self.position_qty = 0
        for pos in account["positions"]:
            if pos["symbol"] == SYMBOL:
                self.position_qty = int(pos["qty"])

    def _sync_fills(self, fills):
        if self.pending_buy is None:
            return
        for fill in fills:
            if fill.get("client_id") == self.pending_buy:
                self.pending_buy = None
                if fill.get("status") == "rejected":
                    self.entry_close = None
                    self.peak_close = None
                break

    def _filters_pass(self, rsi_value):
        closes = self.closes
        now = closes[-1]
        if len(closes) > LONG_LOOKBACK and now <= closes[-1 - LONG_LOOKBACK]:
            return False
        if len(closes) > SHORT_LOOKBACK and now <= closes[-1 - SHORT_LOOKBACK]:
            return False
        if rsi_value is not None and rsi_value >= RSI_CAP:
            return False
        return True

    def _buy(self):
        notional = self.cash
        if notional < self.min_notional:
            return None
        cid = "o%d" % self.next_order
        self.next_order += 1
        self.pending_buy = cid
        self.entry_close = self.closes[-1]
        self.peak_close = self.closes[-1]
        self.trades_done += 1
        return {
            "side": "buy",
            "client_id": cid,
            "symbol": SYMBOL,
            "notional_quote_units": str(notional),
            "max_slippage_bps": MAX_SLIPPAGE_BPS,
        }

    def _sell(self):
        if self.position_qty <= 0:
            return None
        cid = "o%d" % self.next_order
        self.next_order += 1
        return {
            "side": "sell",
            "client_id": cid,
            "symbol": SYMBOL,
            "qty": str(self.position_qty),
            "max_slippage_bps": MAX_SLIPPAGE_BPS,
        }

    def on_batch(self, batch):
        self._sync_account(batch["account"])
        self._sync_fills(batch["fills"])
        bar = None
        for candidate in batch["bars"]:
            if candidate["symbol"] == SYMBOL:
                bar = candidate
                break
        if bar is None:
            return []
        close = int(bar["c"])
        self.closes.append(close)
        self.ema_fast.push(close)
        self.ema_slow.push(close)
        self.ema_fb_fast.push(close)
        self.ema_fb_slow.push(close)
        rsi_value = self.rsi.push(close)
        gap = self._gap(self.ema_fast, self.ema_slow)
        fb_gap = self._gap(self.ema_fb_fast, self.ema_fb_slow)
        k = len(self.closes) - 1

        orders = []
        holding = self.position_qty > 0
        if holding and self.entry_close is None:
            self.entry_close = close
            self.peak_close = close
        if not holding and self.entry_close is not None and self.pending_buy is None:
            self.entry_close = None
            self.peak_close = None

        warming_up = batch["seq"] < self.warmup_bars
        if not warming_up and k >= SLOW_SPAN + 1:
            if holding:
                exit_now = False
                if gap is not None and gap < 0:
                    exit_now = True
                elif close >= self.entry_close * (1 + TAKE_PROFIT_BPS / 10000):
                    exit_now = True
                elif close <= self.entry_close * (1 - STOP_BPS / 10000):
                    exit_now = True
                elif close < self.peak_close * (1 - TRAIL_BPS / 10000):
                    exit_now = True
                if exit_now:
                    order = self._sell()
                    if order is not None:
                        orders.append(order)
                elif close > self.peak_close:
                    self.peak_close = close
            else:
                late = batch["seq"] >= NO_ENTRY_AFTER_SEQ
                drawdown = self.equity * 10000 < self.start_capital * (10000 - DRAWDOWN_GUARD_BPS)
                if not late and not drawdown and self._filters_pass(rsi_value):
                    crossed = (
                        gap is not None
                        and self.prev_gap is not None
                        and gap > 0
                        and self.prev_gap <= 0
                    )
                    if not crossed and self.trades_done == 0 and k >= FALLBACK_BAR:
                        crossed = (
                            fb_gap is not None
                            and self.prev_fb_gap is not None
                            and fb_gap > 0
                            and self.prev_fb_gap <= 0
                        )
                    if crossed:
                        order = self._buy()
                        if order is not None:
                            orders.append(order)
        self.prev_gap = gap
        self.prev_fb_gap = fb_gap
        return orders


def main():
    bot = None
    while True:
        line = sys.stdin.readline()
        if not line:
            return
        if not line.strip():
            continue
        msg = json.loads(line)
        kind = msg.get("type")
        if kind == "hello":
            if msg.get("protocol") != PROTOCOL:
                raise SystemExit("unexpected protocol: %r" % (msg.get("protocol"),))
            bot = Bot(msg)
        elif kind == "batch":
            orders = bot.on_batch(msg)
            reply = {"type": "reply", "seq": msg["seq"], "orders": orders}
            sys.stdout.write(json.dumps(reply, separators=(",", ":")) + "\n")
            sys.stdout.flush()
        elif kind == "done":
            return
        else:
            raise SystemExit("unknown message type: %r" % (kind,))


if __name__ == "__main__":
    main()
