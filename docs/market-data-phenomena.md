# Market-data phenomena — field notes

What market data actually does, why naive handling breaks, and how atm3
models each case. Every example is a real instrument in this database — open
the Instruments page and try them. Principle underneath all of it: **facts
are the tape as printed; everything else is a computed view at a time T.**

## 1. Tickers change (renames)

A company keeps existing but its ticker changes. Naive systems keyed by
ticker split one instrument into two series and lose history across the
change. atm3 keys everything by `instrument_id` (anchored on FIGI), so bars,
actions, and events flow across the rename; the ticker is a time-ranged
label in `facts.symbols`.

Try (2026 renames, bars on both sides of the change):

| old | new | first bar under new ticker | who |
|---|---|---|---|
| SATS | ECHO | 2026-06-24 | EchoStar |
| LC | HAPN | 2026-06-22 | Happen, Inc. |
| SKLZ | FIRY | 2026-06-22 | Firy Inc. |
| SCVL | SHOE | 2026-06-12 | Shoe Station Group |
| IAC | PPLI | 2026-06-04 | People Incorporated |
| DMAT | EART | 2026-03-02 | Global X Rare Earth ETF |

Search the OLD ticker: the instrument appears with its usage window labeled.
Open it: one chart spans both tickers; Symbol history shows the ranges.

## 2. Tickers get reused by other companies

After a rename or delisting, the freed ticker can be assigned to a
completely different security. A date is required to resolve a ticker.

- `FB` meant Meta Platforms from 2012-05-18 to 2022-06-09; today it is a
  ProShares ETF. Search FB: both appear, each labeled.
- Resolution rule: `(market_scope, symbol, date)` → the usage whose
  `[valid_from, valid_to)` covers the date. Current lookups use
  `valid_to is null`.

## 3. Splits and reverse splits

On the ex date the price gaps by the split ratio without any economic
change. Comparing prices across a split without adjusting is meaningless —
but overwriting history with adjusted prices destroys the real tape.

- atm3 stores bars exactly as traded; adjustment is a **function**:
  `computed.adjusted_bars(policy, as_of)`. Toggle the chart policy between
  `none` and `split` on SMCI (10:1 on 2024-10-01) — the pre-split cliff is
  real tape, the smooth series is the computed view. Split markers (red
  arrows) show the ex dates.
- Reverse-split serials exist: MULN/BINI compounded 100:1, 60:1, 100:1,
  100:1, 250:1, 250:1 within two years. Adjusted early prices reach absurd
  magnitudes — that is correct math over an absurd corporate history.

## 4. Dividends

On the ex date the price drops by roughly the cash amount. Total-return
comparisons need dividend adjustment; price-level rules must NOT use it.

- Factor per event: `1 − cash / previous raw close`, computed from our own
  tape — never vendor factors (see §10).
- Same-day multiple distributions (regular + special) SUM their cash before
  the factor — they reduce one previous close once.
- The chart shows dividends as blue dots (SPY: quarterly). The
  `split_dividend` policy folds them in; the first-bar factor readout shows
  the cumulative effect (SPY ≈ ×0.99 over two years — small but real).
- Rule of thumb: a strategy predicate like "price > 10 at date T" evaluates
  the RAW close (policy `none`); return math over a holding window uses
  adjusted views or explicit in-window actions.

## 5. One instrument, two concurrent tape lines

Around reverse splits, a when-issued line (ticker + `w`-ish suffixes) can
trade at the same time as the regular line — one instrument, two prices on
one day. atm3 keys bars by `(instrument, date, symbol_as_traded)` and the
computed layer picks the canonical line (max volume) per day.

- Seen in this window: AAP/AAPW, AZZ/AZZW; MBGLw → MBGL (2026-07-01) is a
  when-issued line becoming the regular one.

## 6. Ticker case is significant

Polygon notation encodes share class/kind in case: `INNpF` is Summit Hotel
Properties' Series F preferred; `INNPF` (all caps) is a different OTC
security. Case-folding merges different securities — atm3 never folds case.
(A 65:1 OTC consolidation once landed on the preferred because of an
`upper()`; the fix is encoded as a rule in AGENTS.md.)

## 7. Vendors state one action twice around a rename

The MULN → BINI 1-for-100 split of 2025-06-02 appears in the vendor's splits
feed under BOTH tickers with different ids. Compounding both statements
would square the factor (100 → 10,000). atm3 collapses duplicate same-day
statements per instrument to one factor.

## 8. Actions are published before they execute

SOXS carried a 10:1 split with a FUTURE ex date while still trading normally.
Applying it early misstates today's prices. Rule: an event applies only where
the series has bars after it — each series anchors to its own latest tape.
The factor exists in `computed.adjustment_factor_events` immediately but
takes effect the day post-event bars arrive.

## 9. Actions continue after an instrument goes dark

FOXO stopped trading (2025), then the vendor recorded a 3000:1 consolidation
(2026-07-01). The action never resolves onto the traded series (no bars
after it) — and mathematically a post-final-bar factor scales every bar
equally, changing no return. It sits in quarantine, visible, not guessed.

## 10. Vendor "adjusted" data is not a fact

Two lessons baked into the design:

- Polygon's dividend rows ship a CUMULATIVE `historical_adjustment_factor`;
  treating it as per-event and compounding destroys multi-dividend
  histories. atm3 never ingests vendor factors — they are derivable, and we
  derive them.
- Vendor-adjusted bars (`adjusted=true` files) adjust per TICKER and only
  for executed splits — they never span renames. atm3 keeps them solely as a
  parity check: `npm run verify:adjustments` (100.000% close match on
  active instruments, by construction of the differences elsewhere).

## 11. Not everything on the tape is an investable security

- Exchange test tickers print bars every day: ZTEST, ZBZX, NTEST.A…
  They have no identity and land in quarantine (`ops.unresolved`), never in
  facts.
- The dividends feed includes mutual funds (AAAAX…) and CUSIP-keyed rows
  that are outside the listed-stocks universe — quarantined, not guessed.
- Warrants, rights, units, preferreds and SPAC shells are instruments with
  `security_form` set; research universes filter on
  `is_clean_common_stock`.

## 12. Vendors forget to say when things ended

Renames often leave the old reference row inactive with no `delisted_utc`
(ISDR → ACCS). An open-ended old usage would leak current lookups into the
prior user; atm3 ends such usages at the row's `last_updated_utc` as the
best evidence of end-of-usage.

## 13. One market, two vendor tapes that disagree — by design

Daily bars and minute flat files are different vendor products with
different aggregation rules. Verified across 35,642 instrument-days
(2026-07-06…08):

- Intraday aggregation excludes condition-coded prints (blocks, late
  reports), so summed minute volume is a SUBSET of daily volume — median
  ~91%, sometimes 45–75% (NVDA, T, CLVT on 2026-07-06). The inequality
  `sum(minute) <= daily` is a hard invariant: zero violations observed.
- The closing auction prints FIRST inside the 16:00 ET minute: that bar's
  OPEN is the official close, while the bar's close drifts on a few late
  shares (CAT 2026-07-07: the 16:00 bar opened 940.12 — exactly the daily
  close — then "closed" at 929.573 on 8k shares).
- Micro-caps often have no auction print on the minute tape at all; their
  official daily close cannot be derived from minutes (LGCL, DVLT, COSM…).

Doctrine: **daily bars are authoritative for official OHLC; minute bars for
intraday paths.** Never derive one from the other. `npm run verify:intraday`
enforces the volume invariant and monitors close-agreement baselines by
segment.

## The general lesson

Every phenomenon above is a reason adjusted/normalized data cannot be the
source of truth: it changes retroactively (new splits), varies by policy
(price rules vs return math), varies by time T (as-of views), and vendors
get it wrong in ways you can only detect from raw. Store the tape as
printed, keep identity separate from labels, and make everything else a
deterministic, versioned function. When something cannot be resolved,
quarantine it visibly — never guess.
