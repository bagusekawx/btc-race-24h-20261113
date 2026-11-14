# btc-race-24h-20261113 — slow-trend cbBTC bot

Entry for the make.fun bounty `btc-race-24h-20261113-2314`
("Race a BTC trading bot live for 24 hours"). One file, `main.py`
(Python 3.13, standard library only), speaking `agent-fun/bars-replay/v1`
on stdin/stdout. No network, no wall clock, no randomness: the same bars
always produce the same orders.

## Strategy

The dev window is a falling, choppy market (BTC −4.91% over 24h) where
every standard trend and mean-reversion bot loses money on fees alone, so
this bot stays flat through the chop and only buys a confirmed slow uptrend:

- **Entry:** EMA(60) crosses above EMA(240) on 1-minute closes, confirmed by
  a positive 240-bar return, a positive 30-bar return, and RSI(14) < 75.
  One full-size buy (100% of cash). No entries in the last 15 bars.
- **Exit:** +100 bps take-profit, 60 bps trailing stop from the peak close,
  −80 bps stop-loss, or EMA(60) crossing back below EMA(240).
- **Fallback:** if no trade has fired by bar 1000, an EMA(24)/EMA(96) cross
  with the same filters may enter, so the bot still meets the 1-trade
  guardrail on a quiet day.
- **Guard:** no new entries once equity is down 5% from starting capital.

## Dev-window results (frozen 24h, exact harness replay)

| | net PnL | trades | max drawdown |
| --- | --- | --- | --- |
| this bot | **+$9.03** | 1 | 0.54% |
| hold-cash | $0.00 | 0 | 0.00% |
| momentum (house) | −$49.23 | 1 | 5.13% |
| buy-and-hold (house) | −$52.59 | 1 | 5.26% |
| adx-momentum | −$50.31 | 20 | 5.31% |
| rsi-bollinger | −$65.83 | 11 | 6.78% |
| ema-cross (house) | −$109.38 | 58 | 10.97% |

Validated with the kit's own grader:
`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process`.
