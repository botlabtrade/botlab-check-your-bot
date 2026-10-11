# Check your bot

A free, open-source tool that scores a trading bot's trade log against six statistical gates. Drop in a CSV of closed trades and it tells you whether the results are big enough, strong enough, recent enough and broad enough to be worth a small live trial, or whether they could easily be noise.

Everything runs locally: in your browser (`index.html`) or in Node (`cli.mjs`). No data is uploaded, there are no analytics and no network calls.

These are the same gates and thresholds BOTLAB uses for its own bots before any of them is allowed near real money.

## Why

Most crypto bots that look profitable in a backtest or a short live run are not. The usual reasons:

- **Fees, slippage and funding.** A thin edge per trade disappears once real costs are charged.
- **Beta, not skill.** A long-only bot in a bull market makes money because the market went up.
- **Small samples.** 40 trades with a 70% win rate is easy to get by chance.
- **Many tries.** Test 50 variants and the best one looks great even if none has an edge.
- **Look-ahead bias.** The backtest used information that was not available at the time of the trade.
- **Concentration.** One coin or one lucky day carries the whole result.

This tool checks the statistical part of that list from the trades alone. It cannot read your code, so it cannot catch look-ahead bias or wrong cost modelling. See [Limitations](#limitations).

## The six gates

Notation: `x` is the list of per-trade results in time order, `n` its length, `mean` its average, `sd` its sample standard deviation (n-1), `SR = mean / sd` the per-trade Sharpe ratio, `skew` and `kurt` the sample skewness and (non-excess) kurtosis, `z = Φ⁻¹(0.95) ≈ 1.645`.

| Gate | Name | Passes when |
|---|---|---|
| G1 | Sufficient sample | `n ≥ max(100, MinTRL)` |
| G2 | Not just luck | `PSR(0) ≥ 0.95` and `DSR ≥ 0.5` |
| G3 | Still working recently | `mean(last 100) > 0` and `mean(last 30) > -0.1` |
| G4 | Not reliant on a few coins or days | top-3 coins `< 50%` of gross profit and best-2 days `< 50%` of net profit |
| G5 | No losing side | neither longs nor shorts have `≥ 50` trades with a negative average |
| G6 | Acceptable drawdown | max peak-to-trough drawdown of cumulative R `< 15R` |

### G1 Sufficient sample (MinTRL)

Minimum Track Record Length (Bailey and Lopez de Prado, 2012): the number of trades needed to be 95% confident the true Sharpe is above zero.

```
MinTRL = ceil( 1 + (1 - skew·SR + (kurt - 1)/4 · SR²) · (z / SR)² )     if SR > 0
MinTRL = ∞                                                             if SR ≤ 0
need   = max(100, MinTRL)
```

The floor of 100 trades is BOTLAB's own rule: below that, regime changes and clustering make even a "significant" result fragile.

### G2 Not just luck (PSR and DSR)

Probabilistic Sharpe Ratio, the probability that the true Sharpe exceeds a benchmark `SR*`:

```
PSR(SR*) = Φ( (SR - SR*) · sqrt(n - 1) / sqrt(1 - skew·SR + (kurt - 1)/4 · SR²) )
```

Deflated Sharpe Ratio (Bailey and Lopez de Prado, 2014) uses as benchmark the Sharpe you would expect from the best of `N` unskilled variants, where `N` is the number of variants you tested (the "trials" input, default 20):

```
SR*(N) = sqrt(1 / (n - 1)) · ( (1 - γ) · Φ⁻¹(1 - 1/N) + γ · Φ⁻¹(1 - 1/(N·e)) ),   γ = 0.5772 (Euler-Mascheroni)
DSR    = PSR(SR*(N))          (with N = 1, SR* = 0 and DSR = PSR(0))
```

Be honest about `N`. Every parameter set, coin list or filter you tried and discarded counts.

### G3 Still working recently

```
mean(last 100 trades) > 0   and   mean(last 30 trades) > -0.1
```

If you have fewer than 100 (or 30) trades, the window is all trades. The `-0.1` threshold is in the unit of your result column (meant for R).

### G4 Not reliant on a few coins or days

```
coin share = Σ max(0, net profit of top-3 coins by net profit) / Σ (all winning trades)
day share  = Σ max(0, net profit of best-2 days)               / |net profit of all trades|
pass if coin share < 0.5 and day share < 0.5
```

Each part is scored only if the matching column (`symbol`, `date`) is present. Note that the day share is measured against net profit, so a strategy with a small net result and a couple of big days fails easily. That is intended.

### G5 No losing side

Trades are split by the `side` column into longs and shorts. The gate fails if either side has at least 50 trades and a negative average. A bot whose profit comes from one side while the other quietly bleeds is usually just riding market direction.

Scored only if a `side` column is present (see differences below).

### G6 Acceptable drawdown

```
equity_i = Σ_{k ≤ i} x_k,   maxDD = max_i ( max_{j ≤ i} equity_j - equity_i )
pass if maxDD < 15R
```

Scored only when the input is in R multiples (at 1% risk per trade, 15R is about 15% of capital). For USD input the gate is shown as not scored.

### Verdict

- **Ready**: every gate that could be scored passed. Worth a small live trial alongside paper trading, not a full allocation.
- **Watch**: G2 and G3 pass but something else does not. There is a signal; keep collecting trades.
- **Not passed**: otherwise.

Gates that cannot be scored (missing column, non-R unit) are left out of the verdict.

Extra red flags are printed for a win rate of 80% or more (classic look-ahead/overfit sign), fewer than 30 trades, profit concentrated in a few coins, and "passes PSR but fails DSR" (likely overfit).

## CSV format

One row per closed trade, in time order (oldest first), with a header row. Comma, semicolon or tab separated. Column names are case-insensitive; extra columns are ignored.

| Purpose | Accepted names | Required |
|---|---|---|
| Result in R | `r`, `r_after`, `pnl_r`, `r_mult`, `rmult`, `r_multiple`, `realized_r` | one result column |
| Result in money | `pnl`, `pnl_usd`, `profit`, `pnl$`, `net_pnl`, `realized_pnl`, `return`, `ret` | (used only if no R column) |
| Coin | `symbol`, `sym`, `coin`, `pair`, `ticker`, `market` | for G4 |
| Date / time | `date`, `exit_time`, `closed_at`, `close_time`, `exit_ts`, `time`, `ts`, `timestamp`, `entry_time`, `opened_at` | for G4 |
| Side | `side`, `direction`, `dir`, `position_side`, `pos_side` (values `long/buy/l` or `short/sell/s`) | for G5 |

Dates can be ISO strings (`2026-09-01`, `2026-09-01 14:30`) or Unix timestamps in seconds or milliseconds. They are bucketed by day.

```csv
symbol,date,side,r
BTCUSDT,2026-09-01,long,1.2
ETHUSDT,2026-09-02,short,-1
```

Use **net** results (after fees and funding). R is the result divided by the amount risked on that trade.

## How to run

**Browser:** open `index.html` (double-click it, or serve the folder with any static server, or enable GitHub Pages). It loads `gates.js` from the same folder and nothing else.

**Command line** (Node 18+, no dependencies):

```sh
node cli.mjs examples/synthetic_640_trades_passes.csv
node cli.mjs my_trades.csv --trials 50
node cli.mjs my_trades.csv --json
```

Exit code: `0` = ready, `1` = not ready, `2` = input error.

**Library:**

```js
// Node (CommonJS)
const { check, formatReport } = require('./gates.js');
console.log(formatReport(check(csvText, 20)));

// Node (ESM)
import { createRequire } from 'node:module';
const gates = createRequire(import.meta.url)('./gates.js');

// Browser: <script src="gates.js"></script> exposes window.BotlabGates
```

`grade(parsed, trials, overrides)` accepts threshold overrides (see `DEFAULTS` in `gates.js`).

**Tests:**

```sh
node --test        (or: npm test)
```

## Examples

Both files in `examples/` are **synthetic**: generated by a seeded random number generator for demonstration. They are not real trades and say nothing about any real strategy. Every row carries `source=synthetic`.

- `synthetic_640_trades_passes.csv`: 640 trades, 12 coins, both sides. Passes all six gates.
- `synthetic_42_trades_small_lucky.csv`: 42 trades, 67% win rate, mostly one meme coin. Looks fine at a glance; fails G1, G2 and G4.

## Differences from the online version

The math and thresholds are the same as the tool on botlab.org.uk (a test in `test/gates.test.mjs` checks G1 to G4 and G6 against a transcription of the site's function on 200 random logs). Differences:

- **G5 is scored when a `side` column exists.** The online CSV tool does not read a side column and leaves G5 out. Here G5 uses the rule BOTLAB applies to its own bots (50+ trades on one side with a negative average fails). Without a `side` column G5 is not scored, which matches the online tool.
- The online tool reads `G1_MIN_N` from BOTLAB's live gate configuration (currently 100). Here it is the constant 100.
- No site-specific data (such as random-entry baselines or BOTLAB's bot results) is used by the gates, so nothing else had to be re-implemented.

## Limitations

- **It only sees trades.** It cannot detect look-ahead bias, survivorship bias, wrong fee/slippage/funding modelling or fills that could not have happened. A backtest that cheats can pass every gate.
- **Trades are treated as independent.** Overlapping or correlated positions overstate the effective sample size, which makes G1 and G2 too lenient.
- **Per-trade Sharpe**, not annualised. Comparable across logs only when trade frequency is similar.
- **Normal approximations** are used for Φ and Φ⁻¹ (accurate to about 1e-7 and 1e-9).
- **Simple CSV parser.** Quoted fields that contain the separator are not supported. Decimal commas work only when the separator is `;` or tab.
- **Thresholds are judgement calls.** 100 trades, 15R and 50% shares are BOTLAB's rules, not universal truths.
- Passing means "not obviously noise". It does not mean the strategy will make money.

## Disclaimer

**Educational tool. Not financial advice. Past results don't predict future results.** Trading crypto derivatives can lose more than your initial capital. You are responsible for your own decisions.

## About

Made by BOTLAB, an independent crypto bot lab that publishes every result: https://botlab.org.uk (online version + live paper results).

## License

MIT. See [LICENSE](LICENSE).
