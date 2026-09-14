/**
 * Markets Brief Data — Google Apps Script (v4.2, 14 Sep 2026)
 * ==========================================================
 * WHAT CHANGED IN v4.2 — and why Latest and the Dashboard were a day stale on 13 and 14 Sep
 *
 *   The fetch was never the problem. MacroHistory was current both mornings. dailyUpdate ran,
 *   fetched everything, entered finalizeBackfill_ with seconds left on a clock it SHARES with
 *   the fetch loop, and paused. There is no third trigger, so nothing picked it up.
 *   14 Sep: "06:30:12 finalising paused before computed". 13 Sep: paused before "latest".
 *
 *   That skipped rebuildRolling_, so MacroData (1Y/2Y/5Y/10Y) never got the newest row. And
 *   updateLatest_ and dashLoadHistory_ both READ the 2Y mirror, not MacroHistory. So Latest,
 *   Dashboard, DashStats and DashSeries were all a day behind the raw data while carrying a
 *   fresh updated_at — wrong, and stamped as if it were right.
 *
 *   1. dailyContinue / scheduleContinue_ — every pause schedules a one-off trigger 2 minutes
 *                        out, so a run drives itself to completion instead of waiting for a
 *                        scheduled clock that may never come. Capped at 8/day, date-stamped
 *                        like every other cursor. A bigger budget could NOT have fixed this:
 *                        the cap is 6 min per execution and "sort" alone took 132s.
 *   2. LAST_RUN / LAST_COMPLETE — two clocks. LAST_RUN advances on every execution that did
 *                        work; LAST_COMPLETE only when all six finalize stages finished. The
 *                        header printed LAST_RUN and read "last run 2026-09-12 06:27" on the
 *                        morning of the 14th. The "already ran today" guard now tests
 *                        LAST_COMPLETE — testing LAST_RUN would abort the first continuation.
 *   3. healthCheck()  — reports both clocks and, out loud, how far MacroData (2Y) trails
 *                        MacroHistory. Nothing on the board said so before.
 *   4. withSheetLock_ — continuations every 2 min can overlap the 06:00 trigger; two scheduled
 *                        runs 25 min apart never could. One writer at a time.
 *   5. live.gs        — prev_close_date and quote_time_sgt were left on 'General' and rendered
 *                        as raw serials (46276, 46279.4674653).
 *
 *   ALSO SHIPPED HERE, written for v4.1 but never pasted into the Sheet — the deployed script
 *   was still running the v4 versions of both:
 *   6. FETCH_WINDOW_MIN_DAYS 21 -> 90. On 14 Sep the log still read "window 21d" and M2SL and
 *                        PCEPILFE both returned "0 obs" — dated before the window and, because
 *                        the window only moves forward, unreachable forever.
 *   7. anyDate_ timezone correction, used by healthCheck and dashReadRatios_. RatiosLatest said
 *                        the panel was 2026-09-11 and the Dashboard header said 2026-09-10.
 *
 * -------------------------------------------------------------------------------
 * WHAT CHANGED IN v4 — and why 20 series stopped updating on 10 Sep
 *
 *   dailyUpdate cannot finish 55 series inside the 6-minute cap, so it wrote a resume
 *   bookmark to Config!DAILY_STAGE and returned. That bookmark carried no date.
 *   On 9 Sep 13:45 it paused at "BAMLC0A0CM". catchUp() + finalizeNow() were then run by
 *   hand; both write LAST_RUN but neither cleared DAILY_STAGE. So the bookmark survived
 *   the night, and the 10 Sep 04:00 run resumed at series #21 of 55 — never fetching
 *   DGS2..BAMLH0A0HYM2 at all. Diagnostics proves it: the first line of the 10 Sep run is
 *   "04:38:32 | dailyUpdate | BAMLC0A0CM", with no DGS row anywhere above it.
 *
 *   The reason it runs out of time is lastDateFor_: one 26,554-row column read per series.
 *   whyNoUpdate() measured 3,939 ms (DGS10) and 4,832 ms (SORA_VOL). 55 x ~4s is the entire
 *   4-minute budget spent working out where it left off, before fetching a single byte.
 *   catchUp(), which skips lastDateFor_ entirely, did 52 series in 248s.
 *
 *   1. fetchWindowYmd_()  — ONE 5-row read sizes the window for the whole run.
 *                           window = max(21d, (today - newest row) + 5d), so it widens
 *                           by itself after an outage instead of leaving a permanent hole.
 *   2. runFetch_()        — one flat-window fetch loop, shared by dailyUpdate and catchUp.
 *                           lastDateFor_ is off the hot path. Re-reading the last 3 weeks
 *                           every run also means FRED REVISIONS finally land; the old
 *                           forward-only fetch could never overwrite a printed number.
 *   3. readCursor_ / writeCursor_ — every cursor is stamped "yyyy-MM-dd|SERIES_ID".
 *                           A cursor that isn't from today is discarded, not obeyed.
 *   4. catchUp / finalizeNow now clear DAILY_STAGE. Running either by hand is what
 *                           planted the landmine on 9 Sep.
 *   5. installTriggers    — 04:00 SGT is 16:00 ET, minutes BEFORE FRED H.15 publishes at
 *                           ~16:15 ET. Moved to 05:00 + 06:00, presentation 06:30.
 *   6. updateRatios_      — the 90% coverage rule dragged all 37 tickers back to 4 Sep
 *                           because only 21 of 37 had an 8 Sep price. Now 60% sets the
 *                           panel date and laggards are computed at their own date and
 *                           flagged, instead of everything being thrown away.
 *   7. DXY                — was a dead registry row ("no free daily source"). Six FRED FX
 *                           series give the real ICE basket, so DXY is now COMPUTED with
 *                           history back to 1971. Those six also finally put EURUSD,
 *                           GBPUSD, AUDUSD, USDCHF and USDCAD into the daily history.
 *   8. healthCheck()      — per-series staleness vs what that series should look like.
 *   9. trimLog_()         — the Log tab was 144 refreshLive rows a day and unreadable.
 *
 * RUN ORDER AFTER PASTING THIS FILE (see the plan; each is once, not daily):
 *   probeGoogleFinance() -> set GF_EXCHANGE -> buildRatiosTab_()
 *   resyncSeries() -> backfill() with BACKFILL_ONLY for the 6 new FX ids
 *   catchUp() -> finalizeNow() -> healthCheck() -> installTriggers()
 *
 * -------------------------------------------------------------------------------
 * WHAT CHANGED IN v3 — and why the sheet had been frozen since 7 Sep
 *
 *   setCfg_('BACKFILL_DONE','TRUE') writes the STRING "TRUE" with Range.setValue().
 *   Sheets coerces that to a BOOLEAN on entry, exactly as if you had typed it.
 *   getCfg_ reads it back as JS boolean true and returns String(true) === "true".
 *   dailyUpdate tested   getCfg_('BACKFILL_DONE','FALSE') !== 'TRUE'
 *   and "true" !== "TRUE" — so every run since the backfill completed at
 *   2026-09-07 16:23:49 believed it was incomplete, re-ran backfill() from the top,
 *   and RETURNED before ever reaching updateLatest_ / updateRatios_ / refreshDashboard.
 *   That is why Latest.updated_at and RatiosLatest.updated_at were both stuck at
 *   exactly 2026-09-07 16:23 while the triggers fired correctly twice a day.
 *   (dashRender_ uppercases before comparing, which is why the Dashboard header
 *   said "Backfill complete" while dailyUpdate disagreed. Same flag, two tests.)
 *
 *   1. cfgTrue_()  — tolerant truthiness. Never compare a Config flag with === again.
 *   2. setFlag_()  — writes flags as TEXT so Sheets cannot coerce them.
 *   3. dailyUpdate — always runs the presentation layer, even mid-backfill.
 *   4. refreshPresentation() — Latest + Ratios + Dashboard on its own 06:00 trigger,
 *      so a stuck fetch phase can never freeze the sheet again.
 *   5. updateRatios_ — was mixing as-of dates across tickers (GOOGLEFINANCE fills its
 *      trailing rows at different times; on 8 Sep only 21 of 37 tickers had a value,
 *      so XLK was measured to 8 Sep against RSP measured to 4 Sep). Now cuts the whole
 *      panel at the last date >=90% of tickers share.
 *   6. upsertHistory_ — drops future-dated rows. OANDA's daily candle is stamped +12h
 *      off the NY 17:00 alignment, which pushed a 2026-09-10 row into the sheet and
 *      made the Dashboard header read "Data as of 2026-09-10".
 *   7. backfill fetch budget 2.5 -> 4.5 min. On a pause the function RETURNS before
 *      finalize, so the reserved 3.5 minutes were simply thrown away.
 *   8. repairSheet() — one-off cleanup of damage already done.
 *   9. probeGoogleFinance() — SPMO and IGV are empty in all 2,937 Ratios rows; their
 *      GF_EXCHANGE prefix is wrong and GOOGLEFINANCE fails silently. This finds the
 *      prefix that works instead of guessing.
 *
 * (v3 run order superseded by the v4 block above.)
 *
 * -------------------------------------------------------------------------------
 * DESIGN (unchanged)
 *   MacroHistory        the master: full backfill + a new row appended each day.
 *   MacroData (1Y/2Y/5Y/10Y)  trailing-window mirrors, regenerated each day.
 *   Latest              one row per series: latest value, previous, changes.
 *   Series              registry: series_id | label | source | source_id | field | group | notes
 *   Ratios              GOOGLEFINANCE price matrix (SPY + the ETF/SPY watch list).
 *   RatiosLatest        ETF/SPY relative-strength stats, recomputed daily.
 *   Config              API keys + flags.   Log / Diagnostics   script + fetch logs.
 *   Dashboard           first tab (Dashboard.gs).  Runs / IBKR Log   the brief's run CSVs.
 *
 * SOURCES
 *   FRED   api.stlouisfed.org  (key)   — rates, liquidity, credit, macro prints
 *   MAS    apimg-gw keyed gateway      — SORA, standing facilities; MAS_V1 for T-bills
 *   OANDA  api-fxpractice.oanda.com    — gold, copper, BTC, ETH, USDSGD, STI CFD
 *   (IBKR ETF/SPY ratios are computed by the brief at runtime; the Ratios tab is a
 *    GOOGLEFINANCE convenience mirror, IBKR remains the source of record.)
 */

// ---------------------------------------------------------------- constants
const TZ = 'Asia/Singapore';
const HIST = 'MacroHistory';
const ROLLING = [['MacroData (1Y)', 1], ['MacroData (2Y)', 2], ['MacroData (5Y)', 5], ['MacroData (10Y)', 10]];
const TAB = { config: 'Config', series: 'Series', latest: 'Latest', ratios: 'Ratios', ratiosLatest: 'RatiosLatest', log: 'Log', diag: 'Diagnostics' };
const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const MAS_LEGACY = 'https://eservices.mas.gov.sg/api/action/datastore/search.json';
const MAS_V1 = 'https://eservices.mas.gov.sg/statistics/api/v1';
const STOOQ_BASE = 'https://stooq.com/q/d/l/';
const OANDA_HOSTS = { practice:'https://api-fxpractice.oanda.com', live:'https://api-fxtrade.oanda.com' };
const MAS_RES_RATES = '9a0bf149-308c-4bd2-832d-76c8e6cb47ed';
const MAS_RES_FX    = '95932927-c8bc-4e7a-b484-68a66a24edfe';
const MAS_V1_BENCHMARK_CANDIDATES = [
  'bondsandbills/m/listbenchmarkpricesandyields',
  'bondsandbills/m/benchmarkpricesandyields',
  'bondsandbills/m/listbondsandbills',
];
const MAS_V1_TBILL_CANDIDATES = [
  'bondsandbills/m/listsgssecsauctionresults',
  'bondsandbills/m/listbillsauctionresults',
  'bondsandbills/m/treasurybillauctions',
];

// Series registry seed. Columns: id, label, source, source_id, field, group, notes.
const DEFAULT_SERIES = [
  // --- FRED: US rates & curve
  ['DGS2','UST 2y yield %','FRED','DGS2','','US rates',''],
  ['DGS5','UST 5y yield %','FRED','DGS5','','US rates',''],
  ['DGS10','UST 10y yield %','FRED','DGS10','','US rates',''],
  ['DGS30','UST 30y yield %','FRED','DGS30','','US rates',''],
  ['DGS3MO','UST 3m yield %','FRED','DGS3MO','','US rates',''],
  ['DFII10','UST 10y real (TIPS) %','FRED','DFII10','','US rates',''],
  ['DFII5','UST 5y real (TIPS) %','FRED','DFII5','','US rates',''],
  ['T10YIE','10y breakeven inflation %','FRED','T10YIE','','US rates',''],
  ['T5YIFR','5y5y forward inflation %','FRED','T5YIFR','','US rates',''],
  // --- FRED: policy & money-market rates
  ['DFF','Fed funds effective %','FRED','DFF','','US policy',''],
  ['DFEDTARU','Fed target upper %','FRED','DFEDTARU','','US policy',''],
  ['DFEDTARL','Fed target lower %','FRED','DFEDTARL','','US policy',''],
  ['SOFR','SOFR %','FRED','SOFR','','US policy',''],
  // --- FRED: liquidity
  ['WALCL','Fed balance sheet $m','FRED','WALCL','','Liquidity',''],
  ['RRPONTSYD','Fed ON RRP $bn','FRED','RRPONTSYD','','Liquidity',''],
  ['WTREGEN','Treasury General Account $m','FRED','WTREGEN','','Liquidity','FRED publishes in $ millions'],
  ['M2SL','US M2 $bn (SA)','FRED','M2SL','','Liquidity',''],
  // --- FRED: risk, credit, conditions
  ['VIXCLS','VIX close','FRED','VIXCLS','','Risk',''],
  ['DTWEXBGS','Broad USD index (Fed)','FRED','DTWEXBGS','','Risk','DXY proxy'],
  ['BAMLH0A0HYM2','US HY OAS %','FRED','BAMLH0A0HYM2','','Credit','3y rolling history from Apr 2026'],
  ['BAMLC0A0CM','US IG OAS %','FRED','BAMLC0A0CM','','Credit','3y rolling history from Apr 2026'],
  ['NFCI','Chicago Fed NFCI','FRED','NFCI','','Conditions',''],
  ['ANFCI','Chicago Fed adj NFCI','FRED','ANFCI','','Conditions',''],
  // --- FRED: commodities & FX (daily)
  ['DCOILWTICO','WTI $/bbl','FRED','DCOILWTICO','','Commodities',''],
  ['DCOILBRENTEU','Brent $/bbl','FRED','DCOILBRENTEU','','Commodities',''],
  ['DEXSIUS','USDSGD (Fed H.10)','FRED','DEXSIUS','','FX',''],
  ['DEXJPUS','USDJPY (Fed H.10)','FRED','DEXJPUS','','FX',''],
  ['DEXCHUS','USDCNY (Fed H.10)','FRED','DEXCHUS','','FX',''],
  // v4: the DXY basket. These six also give EURUSD/GBPUSD/AUDUSD/USDCHF/USDCAD a daily
  // history for the first time — without them the dashboard has no 1W/1M/YTD for any major.
  // Watch the quote direction: FRED publishes EUR, GBP and AUD as USD-per-unit and the rest
  // as units-per-USD. The DXY exponents in COMPUTED depend on exactly that.
  ['DEXUSEU','EURUSD (Fed H.10)','FRED','DEXUSEU','','FX','USD per EUR'],
  ['DEXUSUK','GBPUSD (Fed H.10)','FRED','DEXUSUK','','FX','USD per GBP'],
  ['DEXUSAL','AUDUSD (Fed H.10)','FRED','DEXUSAL','','FX','USD per AUD'],
  ['DEXCAUS','USDCAD (Fed H.10)','FRED','DEXCAUS','','FX','CAD per USD'],
  ['DEXSZUS','USDCHF (Fed H.10)','FRED','DEXSZUS','','FX','CHF per USD'],
  ['DEXSDUS','USDSEK (Fed H.10)','FRED','DEXSDUS','','FX','SEK per USD — DXY basket only'],
  // --- FRED: macro prints
  ['ICSA','Initial jobless claims','FRED','ICSA','','US macro',''],
  ['PAYEMS','Nonfarm payrolls (k)','FRED','PAYEMS','','US macro',''],
  ['UNRATE','Unemployment rate %','FRED','UNRATE','','US macro',''],
  ['CPIAUCSL','CPI index','FRED','CPIAUCSL','','US macro',''],
  ['PCEPILFE','Core PCE index','FRED','PCEPILFE','','US macro',''],
  // --- OANDA
  ['GOLD','Gold $/oz','OANDA','XAU_USD','c','Commodities','OANDA daily mid close, NY 17:00 alignment'],
  ['USDSGD_OANDA','USDSGD (OANDA NY close)','OANDA','USD_SGD','c','FX','timelier than DEXSIUS; run probeOanda() to see other instruments'],
  ['STI','Straits Times Index (OANDA SG30 CFD)','OANDA','SG30_SGD','c','SG equities','CFD tracking the STI — confirmed on account 7 Sep 2026'],
  ['COPPER','Copper $/lb','OANDA','XCU_USD','c','Commodities','OANDA copper CFD; confirmed on account 7 Sep 2026'],
  // v4: was source=NONE, "no free daily source". It is computed now — see COMPUTED.DXY.
  // The registry row stays so the column keeps its position; the value comes from COMPUTED.
  ['DXY','US Dollar Index (ICE basket)','NONE','','','FX','computed from the 6 FRED H.10 basket rates — see COMPUTED.DXY'],
  ['BTCUSD','Bitcoin USD','OANDA','BTC_USD','c','Crypto','OANDA; confirmed on account 7 Sep 2026'],
  ['ETHUSD','Ether USD','OANDA','ETH_USD','c','Crypto','OANDA; confirmed on account 7 Sep 2026'],
  // --- MAS keyed API gateway (apimg-gw)
  ['SORA_ON','SORA overnight %','MAS_GW','SORA','sora','SG rates','gateway - probeMasGw() to confirm'],
  ['SORA_1M','1M compounded SORA %','MAS_GW','SORA','comp_sora_1m','SG rates','gateway - probeMasGw() to confirm'],
  ['SORA_3M','3M compounded SORA %','MAS_GW','SORA','comp_sora_3m','SG rates','gateway - probeMasGw() to confirm'],
  ['SORA_6M','6M compounded SORA %','MAS_GW','SORA','comp_sora_6m','SG rates','gateway - probeMasGw() to confirm'],
  ['SORA_INDEX','SORA compounding index','MAS_GW','SORA','sora_index','SG rates','confirmed'],
  ['SG_SF_DEPO','MAS standing facility deposit %','MAS_GW','SORA','standing_facility_deposit','SG rates','confirmed - policy corridor floor'],
  ['SG_SF_BORR','MAS standing facility borrow %','MAS_GW','SORA','standing_facility_borrow','SG rates','confirmed - policy corridor ceiling'],
  ['SORA_VOL','SORA aggregate volume','MAS_GW','SORA','aggregate_volume','SG rates','confirmed - depth of the fixing'],
  ['SOR_AVG','SOR average % (discontinued 2024)','MAS_GW','SORA','sor_average','SG rates','confirmed - history only, ends 1 Jan 2024'],
  // --- MAS v1 bondsandbills
  ['TBILL_6M','6M T-bill cut-off yield %','MAS_V1','bondsandbills/m/listbondsandbills|bill_bond_ind:"bill" AND auction_tenor:0.5|auction_date','cutoff_yield','SG rates','confirmed'],
  ['TBILL_1Y','1Y T-bill cut-off yield %','MAS_V1','bondsandbills/m/listbondsandbills|bill_bond_ind:"bill" AND auction_tenor:1|auction_date','cutoff_yield','SG rates','confirmed'],
  ['TBILL_6M_BTC','6M T-bill bid-to-cover','MAS_V1','bondsandbills/m/listbondsandbills|bill_bond_ind:"bill" AND auction_tenor:0.5|auction_date','bid_to_cover','SG rates','confirmed'],
  ['SGS_2Y','SGS 2y benchmark yield %','MAS_V1','TODO','yield_2yr','SG rates','endpoint not found - run probeMasPaths()'],
  ['SGS_10Y','SGS 10y benchmark yield %','MAS_V1','TODO','yield_10yr','SG rates','endpoint not found - run probeMasPaths()'],
];

// --- v4: the ICE dollar index basket, defined once and shared.
// COMPUTED.DXY uses the FRED column (daily history); live.gs uses the OANDA instrument
// (intraday). Same weights, same constant, so the live number and the settled number are
// the same index rather than two different approximations.
//
// The exponent sign follows the QUOTE DIRECTION, not the currency. FRED publishes EUR, GBP
// and AUD as USD-per-unit (so a rising number is a WEAKER dollar -> negative exponent) and
// the rest as units-per-USD (rising = stronger dollar -> positive). Get one sign wrong and
// the index still looks plausible, which is why this table is explicit.
const DXY_CONST  = 50.14348112;
const DXY_BASKET = [
  ['DEXUSEU', 'EUR_USD', -0.576],   // USD per EUR
  ['DEXJPUS', 'USD_JPY',  0.136],   // JPY per USD
  ['DEXUSUK', 'GBP_USD', -0.119],   // USD per GBP
  ['DEXCAUS', 'USD_CAD',  0.091],   // CAD per USD
  ['DEXSDUS', 'USD_SEK',  0.042],   // SEK per USD
  ['DEXSZUS', 'USD_CHF',  0.036],   // CHF per USD
];
// rate(i) returns the quote for basket entry i, or anything non-numeric if unavailable.
// A partial basket is not a dollar index, so one missing leg returns '' rather than a number.
function dxyCompute_(rate){
  let x = DXY_CONST;
  for(let i = 0; i < DXY_BASKET.length; i++){
    const v = rate(i);
    if(!isNum(v) || v <= 0) return '';
    x *= Math.pow(v, DXY_BASKET[i][2]);
  }
  return x;
}

// Computed columns: derived each row from raw columns. id -> f(rowMap).
const COMPUTED = {
  'US_10Y_2Y':      m => sub(m.DGS10, m.DGS2),
  'US_10Y_3M':      m => sub(m.DGS10, m.DGS3MO),
  'HY_IG_OAS':      m => sub(m.BAMLH0A0HYM2, m.BAMLC0A0CM),
  'CopperGold':     m => div(m.COPPER, m.GOLD),
  'ETH_BTC':        m => div(m.ETHUSD, m.BTCUSD),
  'Net_Liquidity':  m => (isNum(m.WALCL) && isNum(m.RRPONTSYD) && isNum(m.WTREGEN)) ? (m.WALCL - m.RRPONTSYD * 1000 - m.WTREGEN) : '',
  'DXY':            m => dxyCompute_(i => m[DXY_BASKET[i][0]]),
};

// ETF/SPY relative-strength universe (Evan's groups) — GOOGLEFINANCE mirror.
const RATIO_GROUPS = [
  ['Breadth', ['RSP']],
  ['Size', ['IWM','IJH','MDY']],
  ['Growth', ['QQQ','SPYG','VUG','IWF','RPG']],
  ['Value', ['SPYV','VTV','IWD','RPV']],
  ['Sector', ['XLK','XLF','XLE','XLV','XLY','XLP','XLI','XLB','XLU','XLRE','XLC']],
  ['Factor', ['MTUM','SPMO','SPHB','SPLV','USMV','QUAL']],
  ['International', ['EFA','VEA','VXUS','EEM']],
  ['Book', ['IGV','SMH']],
];
// GOOGLEFINANCE needs the right exchange prefix or the ticker silently returns blank.
// SPMO and IGV are STILL empty in all 2,937 rows as of 10 Sep 2026. v4 stops them dragging
// the whole rotation panel backwards (updateRatios_ excludes never-populated tickers from
// its coverage count), but that is damage control, not a fix — you still have no momentum
// or software factor line.
//   RUN probeGoogleFinance(), read the GFTest grid, put the prefix that returns a NUMBER
//   here, then run buildRatiosTab_(). Do not guess: guessing is how they ended up wrong.
//   If every prefix shows "—", the ticker is not in GOOGLEFINANCE and should be deleted
//   from RATIO_GROUPS instead.
// Settled by probeGoogleFinance() on 11 Sep 2026 — read off the GFTest grid, not guessed:
//   SPMO  BATS -> NYSEARCA   (BATS returned nothing; that is why it was blank in 2,937 rows)
//   IGV   NASDAQ -> BATS     (NASDAQ returned nothing; same)
// The rest of the grid confirmed the existing entries, and one of them matters more than it
// looks: bare "MTUM" resolves to 27.98 while BATS:MTUM is 303.15 — two different securities.
// Same for QUAL (60.34 bare vs 218.42 on BATS). So the prefix is not cosmetic and the bare
// ticker is not a safe fallback; a wrong prefix either blanks the column or silently prices
// something else entirely. Never drop an entry from this table to "let it default".
const GF_EXCHANGE = { QQQ:'NASDAQ', VXUS:'NASDAQ', SMH:'NASDAQ',
                      IGV:'BATS', MTUM:'BATS', QUAL:'BATS', USMV:'BATS',
                      SPMO:'NYSEARCA', SPHB:'NYSEARCA' };
const RATIOS_START = '2015-01-01';
const LOG_FOLDER_NAME = 'Markets Brief Log';

// ---------------------------------------------------------------- small helpers
function isNum(v){ return typeof v === 'number' && isFinite(v); }
function sub(a,b){ return (isNum(a) && isNum(b)) ? a - b : ''; }
function div(a,b){ return (isNum(a) && isNum(b) && b !== 0) ? a / b : ''; }
function ss_(){ return SpreadsheetApp.getActiveSpreadsheet(); }
function sheet_(n){ const s = ss_().getSheetByName(n); if(!s) throw new Error('Missing tab '+n+' — run setupSheets()'); return s; }
function ymd_(d){ return Utilities.formatDate(d,'UTC','yyyy-MM-dd'); }
function toDate_(s){ const m=String(s).match(/^(\d{4})-(\d{2})-(\d{2})/); return m ? new Date(Date.UTC(+m[1],+m[2]-1,+m[3])) : null; }
// v3.1: Sheets parses a cell whose text starts with = + - @ as a FORMULA. dailyUpdate's
// detail string began "+13 obs, wrote 13" and every Diagnostics row came back #ERROR!.
function cellSafe_(v){ const s=String(v); return /^[=+\-@]/.test(s) ? "'"+s : s; }
function log_(msg){ const s=ss_().getSheetByName(TAB.log)||ss_().insertSheet(TAB.log); s.appendRow([Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm:ss'),cellSafe_(String(msg).slice(0,49000))]); }
function diag_(fn,series,status,detail){ const s=ss_().getSheetByName(TAB.diag)||ss_().insertSheet(TAB.diag); s.appendRow([Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm:ss'),fn,series,status,cellSafe_(String(detail).slice(0,4000))]); }
function getCfg_(k,dflt){ const p=PropertiesService.getScriptProperties().getProperty(k); if(p) return p; const s=ss_().getSheetByName(TAB.config); if(!s) return dflt; for(const r of s.getDataRange().getValues()) if(String(r[0]).trim()===k && String(r[1]).trim()!=='') return String(r[1]).trim(); return dflt; }
function setCfg_(k,v){ const s=sheet_(TAB.config); const vals=s.getDataRange().getValues(); for(let i=0;i<vals.length;i++) if(String(vals[i][0]).trim()===k){ s.getRange(i+1,2).setValue(v); return; } s.appendRow([k,v]); }

// --- v3 FIX 1: tolerant truthiness. A Config flag may be boolean TRUE, "TRUE", "true",
// "yes" or 1 depending on how it was written. NEVER compare one with === again.
function cfgTrue_(key){
  const v = getCfg_(key,'');
  if(v === true) return true;
  const s = String(v).trim().toUpperCase();
  return s==='TRUE' || s==='YES' || s==='1';
}
// --- v3 FIX 2: write a flag as TEXT so Sheets cannot coerce it to a boolean or a date.
function setFlag_(key, val){
  const s = sheet_(TAB.config);
  const vals = s.getDataRange().getValues();
  for(let i=0;i<vals.length;i++){
    if(String(vals[i][0]).trim()===key){ s.getRange(i+1,2).setNumberFormat('@').setValue(String(val)); return; }
  }
  s.appendRow([key, String(val)]);
  s.getRange(s.getLastRow(),2).setNumberFormat('@').setValue(String(val));
}

// --- v4 FIX 3: date-stamped cursors. A resume bookmark is only valid for the day that wrote
// it. The 10 Sep run obeyed a bookmark left behind on 9 Sep and skipped the first 20 series.
// Stored as "yyyy-MM-dd|SERIES_ID"; a bare id (written by an older version) is treated as
// stale, which is the safe direction — starting from the top costs a few minutes, skipping
// 20 series costs a day of data.
function todayYmd_(){ return Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd'); }
function readCursor_(key){
  const raw = String(getCfg_(key,'') || '').trim();
  if(!raw) return '';
  const bar = raw.indexOf('|');
  if(bar > 0 && raw.slice(0,bar) === todayYmd_()) return raw.slice(bar+1);
  setFlag_(key,'');
  log_(key+': discarded stale cursor "'+raw+'" — starting from the first series');
  return '';
}
function writeCursor_(key,seriesId){ setFlag_(key, seriesId ? todayYmd_()+'|'+seriesId : ''); }

// --- v4 FIX 1: size the fetch window ONCE for the whole run.
// sortHistory_ runs at the end of every finalize, so the newest date is the last row — a
// 5-row read, not the 55 full-column reads (~4s each) that used to eat the entire budget.
// The window widens by itself when the sheet has fallen behind, which is the one real
// weakness of a fixed window: after an outage a flat 21 days would leave a permanent hole.
// v4.1: was 21, and 21 was WRONG — it could lose a monthly print permanently.
// FRED dates a monthly observation on the 1st of the month it covers, but releases it weeks
// later: July's Core PCE is dated 2026-07-01 and published around 28 August. With a 21-day
// window the sheet asks FRED for "everything since 21 Aug", the July observation is dated
// before that, so it is never returned — and because the window only ever moves forward, it
// is never returned tomorrow either. The print is missed for good, silently.
// Evan's 11 Sep run showed exactly this: CPIAUCSL, PCEPILFE and M2SL all reported
// "0 obs since 2026-08-21, newest (none)" while sitting on a 1 July value.
// 90 days covers the longest observation-to-release lag here (Core PCE, ~60 days) plus a
// month of revisions. The cost is small: a wider range is the same ONE http call per series,
// and monthly series return 3 rows instead of 0. Only the daily series write more cells.
const FETCH_WINDOW_MIN_DAYS = 90;
function fetchWindowYmd_(){
  const sh = sheet_(HIST), lastRow = sh.getLastRow();
  let newest = null;
  if(lastRow > 1){
    const n = Math.min(5, lastRow-1);
    const tail = sh.getRange(lastRow-n+1, 1, n, 1).getValues();
    for(let i = tail.length-1; i >= 0; i--) if(tail[i][0] instanceof Date){ newest = tail[i][0]; break; }
  }
  let days = FETCH_WINDOW_MIN_DAYS;
  if(newest){
    const behind = Math.ceil((Date.now() - newest.getTime()) / 86400000);
    if(behind + 5 > days) days = behind + 5;
  }
  return { ymd: ymd_(new Date(Date.now() - days*86400000)), days: days,
           newest: newest ? ymd_(newest) : '(empty sheet)' };
}

// --- v4 FIX 2: the one fetch loop, shared by dailyUpdate and catchUp.
// Flat window for every series. No lastDateFor_, no per-series state. Re-reading the same
// three weeks each run is what makes FRED REVISIONS land — the old forward-only fetch could
// never overwrite a number it had already written, so a revised payroll print never arrived.
// Returns true when it got through the whole list, false when it paused on the clock.
function runFetch_(startYmd, fnName, cursorKey, t0, budget){
  const series = readSeries_();
  const resume = readCursor_(cursorKey);
  let started = !resume, done = 0, wrote = 0, failed = 0, skipped = 0;
  syncHeader_(sheet_(HIST));
  for(const s of series){
    if(!started){ if(s.id === resume) started = true; else continue; }
    if(Date.now() - t0 > budget){
      writeCursor_(cursorKey, s.id);
      log_(fnName+': paused before '+s.id+' (time) — the retry trigger will continue');
      return false;
    }
    writeCursor_(cursorKey, s.id);
    const skip = seriesSkipReason_(s);
    if(skip){ diag_(fnName, s.id, 'SKIP', skip); skipped++; continue; }
    const s0 = Date.now();
    try{
      const rows   = fetchSeries_(s, startYmd);
      const newest = rows.length ? ymd_(rows[rows.length-1][0]) : '(none)';
      const n      = upsertHistory_(s.id, rows);
      wrote += n; done++;
      diag_(fnName, s.id, rows.length ? 'OK' : 'WARN',
            rows.length+' obs since '+startYmd+', newest '+newest+', wrote '+n+
            ' | '+Math.round((Date.now()-s0)/1000)+'s');
    }catch(e){
      failed++;
      diag_(fnName, s.id, 'ERROR', e.message+' | '+Math.round((Date.now()-s0)/1000)+'s');
    }
  }
  writeCursor_(cursorKey, '');
  log_(fnName+': '+done+' fetched, '+failed+' failed, '+skipped+' skipped, '+wrote+
       ' cells written in '+Math.round((Date.now()-t0)/1000)+'s');
  return true;
}

function fetchJson_(url,headers){ const r=UrlFetchApp.fetch(url,{muteHttpExceptions:true,headers:headers||{}}); const c=r.getResponseCode(); if(c>=400) throw new Error('HTTP '+c+' :: '+r.getContentText().slice(0,200)); return JSON.parse(r.getContentText()); }
function readSeries_(){ return sheet_(TAB.series).getDataRange().getValues().slice(1).filter(r=>r[0]).map(r=>({id:String(r[0]).trim(),label:r[1],source:String(r[2]).trim().toUpperCase(),sourceId:String(r[3]).trim(),field:String(r[4]).trim(),group:r[5],notes:r[6]})); }
// v4: DEDUPE. DXY is now both a registry row (so the column keeps its position) and a
// COMPUTED key (so it gets a value). Without this, fullHeader_ lists it twice and
// syncHeader_ appends a SECOND DXY column — the same failure that produced the duplicate
// "Date" column repairSheet() had to delete. First occurrence wins, so registry order holds.
function seriesOrder_(){
  const out = [], seen = {};
  readSeries_().map(s=>s.id).concat(Object.keys(COMPUTED)).forEach(id=>{
    if(!id || seen[id]) return; seen[id] = 1; out.push(id);
  });
  return out;
}
function fullHeader_(){ return ['Date'].concat(seriesOrder_()); }

// ---------------------------------------------------------------- setup
function setupSheets(){
  const ss=ss_(); const mk=n=>ss.getSheetByName(n)||ss.insertSheet(n);
  const cfg=mk(TAB.config);
  const seed=[
    ['key','value'],['FRED_API_KEY',''],
    ['MAS_KEY_SORA',''],['MAS_KEY_FX',''],['MAS_KEY_BANKRATES',''],['MAS_KEY_RESERVES',''],['MAS_API_KEY',''],
    ['MAS_GW_BASE','https://eservices.mas.gov.sg/apimg-gw'],['MAS_KEY_HEADER','keyid'],
    ['MAS_GW_FILTER','between'],['MAS_GW_START','1970-01-01'],
    ['OANDA_API_KEY',''],['OANDA_ACCOUNT_ID',''],['OANDA_ENV','practice'],
    ['BACKFILL_DONE','FALSE'],['BACKFILL_CURSOR',''],['LAST_RUN','']];
  if(cfg.getLastRow()===0) cfg.getRange(1,1,seed.length,2).setValues(seed);
  const ser=mk(TAB.series);
  if(ser.getLastRow()===0){ ser.getRange(1,1,1,7).setValues([['series_id','label','source','source_id','field','group','notes']]).setFontWeight('bold'); ser.getRange(2,1,DEFAULT_SERIES.length,7).setValues(DEFAULT_SERIES); ser.setFrozenRows(1); }
  else resyncSeries();
  const h=mk(HIST); if(h.getLastRow()===0){ writeHeader_(h,fullHeader_()); h.setFrozenRows(1); h.setFrozenColumns(1); }
  ROLLING.forEach(([n])=>{ const s=mk(n); if(s.getLastRow()===0){ writeHeader_(s,fullHeader_()); s.setFrozenRows(1); s.setFrozenColumns(1);} });
  mk(TAB.latest); mk(TAB.ratiosLatest); mk(TAB.log); mk(TAB.diag);
  buildRatiosTab_();
  log_('setupSheets: done — '+readSeries_().length+' series seeded');
}
function writeHeader_(sh,header){ sh.getRange(1,1,1,header.length).setValues([header]).setFontWeight('bold'); sh.getRange('A:A').setNumberFormat('yyyy-mm-dd'); }

// Ensure the history/rolling header matches the current Series registry (adds new columns).
// NOTE: if A1 is ever blank this will append a SECOND "Date" column. repairSheet() fixes that.
function syncHeader_(sh){
  const want=fullHeader_(); const have=sh.getRange(1,1,1,Math.max(sh.getLastColumn(),1)).getValues()[0];
  const missing=want.filter(c=>have.indexOf(c)<0);
  if(missing.length){ sh.getRange(1,have.length+1,1,missing.length).setValues([missing]).setFontWeight('bold'); }
}

// ---------------------------------------------------------------- fetchers (return [[Date,value],...] asc)
function fetchFred_(id,startYmd){
  const key=getCfg_('FRED_API_KEY',''); if(!key) throw new Error('FRED_API_KEY missing');
  const js=fetchJson_(FRED_BASE+'?series_id='+encodeURIComponent(id)+'&api_key='+key+'&file_type=json&sort_order=asc&observation_start='+(startYmd||'1776-07-04'));
  const out=[]; for(const o of (js.observations||[])){ if(o.value==='.'||o.value===''||o.value==null) continue; const d=toDate_(o.date),v=parseFloat(o.value); if(d&&isFinite(v)) out.push([d,v]); }
  Utilities.sleep(600); return out;
}
function fetchStooq_(ticker,startYmd){
  let url=STOOQ_BASE+'?s='+encodeURIComponent(ticker)+'&i=d';
  if(startYmd) url+='&d1='+startYmd.replace(/-/g,'')+'&d2='+ymd_(new Date()).replace(/-/g,'');
  const r=UrlFetchApp.fetch(url,{muteHttpExceptions:true}); if(r.getResponseCode()>=400) throw new Error('HTTP '+r.getResponseCode());
  const body=r.getContentText().trim(); if(!body || /exceeded|limit|denied/i.test(body.slice(0,200))) throw new Error('Stooq returned no data (throttled?): '+body.slice(0,80));
  const lines=body.split('\n'); if(lines.length<2||lines[0].indexOf('Date')<0) throw new Error('Stooq: no CSV for '+ticker+' — '+body.slice(0,60).replace(/\s+/g,' '));
  const h=lines[0].split(','); const di=h.indexOf('Date'), ci=h.indexOf('Close'); const out=[];
  for(let i=1;i<lines.length;i++){ const p=lines[i].split(','); const d=toDate_(p[di]); const v=parseFloat(p[ci]); if(d&&isFinite(v)) out.push([d,v]); }
  Utilities.sleep(300); return out;
}
function fetchMasLegacy_(resourceId,field,startYmd){
  if(!resourceId||resourceId==='TODO') throw new Error('resource id not set');
  const out=[]; let from=startYmd||'2000-01-01'; const today=ymd_(new Date());
  while(from<=today){
    const tD=new Date(toDate_(from).getTime()); tD.setUTCFullYear(tD.getUTCFullYear()+2); tD.setUTCDate(tD.getUTCDate()-1);
    let to=ymd_(tD); if(to>today) to=today; let offset=0; const limit=1000;
    while(true){
      const url=MAS_LEGACY+'?resource_id='+resourceId+'&limit='+limit+'&offset='+offset+'&between[end_of_day]='+from+','+to+'&sort=end_of_day+asc'+(field?'&fields=end_of_day,'+encodeURIComponent(field):'');
      const js=fetchJson_(url); const recs=(js.result&&js.result.records)||[];
      for(const rec of recs){ const d=toDate_(rec.end_of_day); const v=parseFloat(rec[field]); if(d&&isFinite(v)) out.push([d,v]); }
      if(recs.length<limit) break; offset+=limit;
    }
    const nx=new Date(toDate_(to).getTime()); nx.setUTCDate(nx.getUTCDate()+1); from=ymd_(nx); Utilities.sleep(300);
  }
  return out;
}
function fetchMasV1_(spec,field,startYmd){
  if(!spec||spec==='TODO') throw new Error('v1 path not set');
  const parts=String(spec).split('|');
  const path=parts[0].trim(), filters=(parts[1]||'').trim(), dateKey=(parts[2]||'').trim();
  const dateKeys=dateKey?[dateKey]:['end_of_day','end_of_period','auction_date','issue_date','date','as_of'];
  const out=[]; let offset=0; const rows=2000;
  while(true){
    let url=MAS_V1.replace(/\/$/,'')+'/'+path.replace(/^\//,'')+'?rows='+rows+'&offset='+offset;
    if(filters) url+='&filters='+encodeURIComponent(filters);
    const js=fetchJson_(url); const recs=(js.result&&js.result.records)||js.records||[];
    if(!recs.length) break;
    const dk=dateKeys.find(k=>recs[0][k]!=null); const todayYmd=ymd_(new Date());
    for(const rec of recs){ if(!dk) continue; const d=toDate_(rec[dk]); const v=parseFloat(rec[field]);
      if(d&&ymd_(d)>todayYmd) continue;
      if(d&&isFinite(v)&&(!startYmd||ymd_(d)>=startYmd)) out.push([d,v]); }
    if(recs.length!==rows) break; offset+=rows; Utilities.sleep(300);
  }
  const byDate={}; out.forEach(([d,v])=>{ byDate[ymd_(d)]=[d,v]; });
  return Object.keys(byDate).sort().map(k=>byDate[k]);
}

// ---------------------------------------------------------------- MAS keyed API gateway (apimg-gw)
var MAS_GW_VIEWS = {
  SORA: {
    label:'Domestic Interest Rates - Daily (SORA)', dateKey:'end_of_day',
    path:'server/monthly_statistical_bulletin_non610mssql/domestic_interest_rates_daily/views/domestic_interest_rates_daily' },
  FX: {
    label:'Exchange Rates - End of Period - Daily', dateKey:'end_of_day',
    path:'server/monthly_statistical_bulletin_non610ora/exchange_rates_end_of_period_daily/views/exchange_rates_end_of_period_daily' },
  BANKRATES: {
    label:'Interest Rates of Banks & Finance Cos - Monthly (ends Jun 2021)', dateKey:'end_of_period',
    path:'server/monthly_statistical_bulletin_non610ora/interest_rates_of_banks_and_finance_companies_monthly/views/interest_rates_of_banks_and_finance_companies_monthly' },
  RESERVES: {
    label:'IV.7 Official Foreign Reserves - Monthly', dateKey:'end_of_period',
    path:'server/monthly_statistical_bulletin_hist/iv_7_official_foreign_reserves_monthly/views/iv_7_official_foreign_reserves_monthly' }
};

var MASGW_CACHE_ = {};

function masGwView_(alias){
  var v = MAS_GW_VIEWS[String(alias).trim().toUpperCase()];
  if(!v) throw new Error('unknown MAS_GW alias "'+alias+'" — expected one of: '+Object.keys(MAS_GW_VIEWS).join(', '));
  return v;
}
function masGwHeaders_(alias){
  var key = getCfg_('MAS_KEY_'+String(alias).toUpperCase(),'') || getCfg_('MAS_API_KEY','');
  if(!key) throw new Error('no key for '+alias+' — set Script Property MAS_KEY_'+String(alias).toUpperCase());
  var hdr = getCfg_('MAS_KEY_HEADER','keyid') || 'keyid';
  var h={}; h[hdr]=key; return h;
}
function masGwFilter_(shape,dateKey,from,to){
  if(shape==='none')    return '';
  if(shape==='filters') return 'filters='+encodeURIComponent(dateKey+':['+from+' TO '+to+']');
  if(shape==='range')   return encodeURIComponent(dateKey+'_start')+'='+from+'&'+encodeURIComponent(dateKey+'_end')+'='+to;
  return 'between['+dateKey+']='+from+','+to;
}
function masGwRecords_(alias,dateKey,from,to){
  var ck = alias+'|'+from+'|'+to;
  if(MASGW_CACHE_[ck]) return MASGW_CACHE_[ck];
  var v       = masGwView_(alias);
  var base    = (getCfg_('MAS_GW_BASE','https://eservices.mas.gov.sg/apimg-gw')||'').replace(/\/$/,'');
  var shape   = getCfg_('MAS_GW_FILTER','between') || 'between';
  var headers = masGwHeaders_(alias);
  var byDate={}, offset=0, rows=1000, pages=0;
  while(pages++ < 60){
    var url = base+'/'+v.path+'?rows='+rows+'&offset='+offset;
    var f = masGwFilter_(shape,dateKey,from,to); if(f) url += '&'+f;
    var js = fetchJson_(url,headers);
    var recs = (js.result&&js.result.records)||js.records||js.elements||js.data||[];
    if(!recs.length) break;
    var before = Object.keys(byDate).length;
    for(var i=0;i<recs.length;i++){ var d=toDate_(recs[i][dateKey]); if(d) byDate[ymd_(d)]=recs[i]; }
    if(recs.length !== rows || Object.keys(byDate).length === before) break;
    offset += rows; Utilities.sleep(250);
  }
  MASGW_CACHE_[ck] = byDate;
  return byDate;
}
function fetchMasGw_(spec,field,startYmd){
  if(!spec||spec==='TODO') throw new Error('MAS_GW alias not set');
  var parts   = String(spec).split('|');
  var alias   = parts[0].trim().toUpperCase();
  var v       = masGwView_(alias);
  var dateKey = (parts[1]||v.dateKey).trim();
  var from    = startYmd || getCfg_('MAS_GW_START','1970-01-01') || '1970-01-01';
  var to      = ymd_(new Date());
  var byDate  = masGwRecords_(alias,dateKey,from,to);
  var out=[];
  // v3.1: the gateway ignores the date filter exactly as it ignores rows/offset, so a
  // 21-day request returned 5,317 observations and rewrote the whole SORA history every run.
  // Clamp here. startYmd is null during backfill, so full history still loads then.
  Object.keys(byDate).sort().forEach(function(k){
    if(startYmd && k < startYmd) return;
    var val = parseFloat(byDate[k][field]);
    if(isFinite(val)) out.push([toDate_(byDate[k][dateKey]), val]);
  });
  if(!out.length) throw new Error('no numeric values for field "'+field+'" on '+alias+' — run probeMasGw() for the real field names');
  return out;
}

// ---------------------------------------------------------------- MAS gateway discovery
function probeMasGw(){
  var base = (getCfg_('MAS_GW_BASE','https://eservices.mas.gov.sg/apimg-gw')||'').replace(/\/$/,'');
  var to = ymd_(new Date()), from = to.slice(0,4)+'-01-01';

  function hit_(alias,url){
    var headers; try{ headers=masGwHeaders_(alias); }
    catch(e){ return {ok:false, code:0, n:-1, keys:'NO KEY — '+e.message}; }
    try{
      var res=UrlFetchApp.fetch(url,{headers:headers,muteHttpExceptions:true,followRedirects:true});
      var code=res.getResponseCode(), body=res.getContentText(), n=-1, keys='';
      try{
        var js=JSON.parse(body);
        var recs=(js.result&&js.result.records)||js.records||js.elements||js.data||[];
        n=recs.length; if(n) keys=Object.keys(recs[0]).join(', ');
        else keys='(200 but zero records)';
      }catch(e){ keys='NOT JSON: '+body.slice(0,200).replace(/\s+/g,' '); }
      return {ok:(code===200&&n>0), code:code, n:n, keys:keys};
    }catch(e){ return {ok:false, code:0, n:-1, keys:'ERROR '+e.message}; }
  }

  var sora=MAS_GW_VIEWS.SORA, win=null;
  ['between','filters','range','none'].forEach(function(shape){
    if(win) return;
    var f=masGwFilter_(shape,'end_of_day',from,to);
    var r=hit_('SORA', base+'/'+sora.path+'?rows=20'+(f?'&'+f:''));
    if(r.ok) win=shape;
    diag_('probeMasGw','1. shape: '+shape, r.ok?'HIT':'-', 'HTTP '+r.code+' | recs='+r.n+' | '+r.keys.slice(0,600));
    Utilities.sleep(400);
  });
  if(!win){
    log_('probeMasGw: no filter shape worked on SORA. Check MAS_KEY_SORA, the header name (keyid), '+
         'and that your account is subscribed to "API for Domestic Interest Rates - Daily".');
    return;
  }

  Object.keys(MAS_GW_VIEWS).forEach(function(alias){
    var v=MAS_GW_VIEWS[alias], done=false, last={code:0,n:-1,keys:'not attempted'};
    [v.dateKey,'end_of_day','end_of_period','end_of_quarter'].forEach(function(dk){
      if(done) return;
      var f=masGwFilter_(win,dk,'1970-01-01',to);
      var r=hit_(alias, base+'/'+v.path+'?rows=5'+(f?'&'+f:'')); last=r;
      if(r.ok){ diag_('probeMasGw','2. '+alias+' — '+v.label,'HIT','dateKey='+dk+' | FIELDS: '+r.keys.slice(0,1200)); done=true; }
      else if(r.keys.indexOf('NO KEY')===0){ diag_('probeMasGw','2. '+alias,'-',r.keys); done=true; }
      Utilities.sleep(400);
    });
    if(!done) diag_('probeMasGw','2. '+alias+' — '+v.label,'-',
      'last try: HTTP '+last.code+' | recs='+last.n+' | '+String(last.keys).slice(0,400)+
      '  >>> 401/403 = not subscribed (or wrong key); 200 with 0 records = wrong date key or filter');
  });
  log_('probeMasGw done. Winning filter shape = "'+win+'" — put that in Config!MAS_GW_FILTER.');
}

// ---------------------------------------------------------------- OANDA v20
function oandaBase_(){ const e=String(getCfg_('OANDA_ENV','practice')||'practice').toLowerCase(); return OANDA_HOSTS[e]||OANDA_HOSTS.practice; }
function oandaHeaders_(){ const k=getCfg_('OANDA_API_KEY',''); if(!k) throw new Error('OANDA_API_KEY missing — set it in Script Properties'); return {Authorization:'Bearer '+k,'Accept-Datetime-Format':'RFC3339'}; }
function fetchOanda_(instrument,field,startYmd){
  if(!instrument||instrument==='TODO') throw new Error('OANDA instrument not set');
  const f=(field||'c').toLowerCase(); const byDate={};
  let from=(startYmd||'2000-01-01')+'T00:00:00Z', guard=0;
  while(guard++<40){
    const url=oandaBase_()+'/v3/instruments/'+encodeURIComponent(instrument)+'/candles?granularity=D&price=M&count=5000'+
              '&from='+encodeURIComponent(from)+'&alignmentTimezone='+encodeURIComponent('America/New_York')+'&dailyAlignment=17';
    const js=fetchJson_(url,oandaHeaders_()); const cs=js.candles||[]; if(!cs.length) break;
    for(const c of cs){ if(!c.complete||!c.mid) continue;
      const t=Date.parse(c.time); if(!isFinite(t)) continue; const d=new Date(t+12*3600000); d.setUTCHours(0,0,0,0);
      const v=parseFloat(c.mid[f]); if(isFinite(v)) byDate[ymd_(d)]=[d,v]; }
    if(cs.length<5000) break;
    from=cs[cs.length-1].time; Utilities.sleep(200);
  }
  return Object.keys(byDate).sort().map(k=>byDate[k]);
}
function probeOanda(){
  const h=oandaHeaders_(), base=oandaBase_();
  let acct=getCfg_('OANDA_ACCOUNT_ID','');
  try{ const a=fetchJson_(base+'/v3/accounts',h); const ids=(a.accounts||[]).map(x=>x.id);
       log_('probeOanda: env='+getCfg_('OANDA_ENV','practice')+' accounts='+JSON.stringify(ids)); if(!acct&&ids.length) acct=ids[0]; }
  catch(e){ log_('probeOanda: /v3/accounts failed — '+e.message+' (check key + OANDA_ENV)'); return; }
  if(!acct){ log_('probeOanda: no account id'); return; }
  try{ const js=fetchJson_(base+'/v3/accounts/'+acct+'/instruments',h); const names=(js.instruments||[]).map(i=>i.name).sort();
       const want=['XAU_USD','XAG_USD','XCU_USD','XPT_USD','BCO_USD','WTICO_USD','NATGAS_USD','USD_SGD','USD_JPY','USD_CNH','EUR_USD','GBP_USD','AUD_USD','SPX500_USD','NAS100_USD','US30_USD','US2000_USD','JP225_USD','HK33_HKD','SG30_SGD','BTC_USD','ETH_USD','DE10YB_EUR','USB10Y_USD','USB02Y_USD'];
       const have=want.filter(w=>names.indexOf(w)>=0), miss=want.filter(w=>names.indexOf(w)<0);
       diag_('probeOanda','instruments','OK',names.length+' instruments on account '+acct+' | HAVE: '+have.join(', ')+' | MISSING: '+miss.join(', '));
       diag_('probeOanda','all names','-',names.join(', ').slice(0,4000)); }
  catch(e){ diag_('probeOanda','instruments','ERROR',e.message); }
  try{ const rows=fetchOanda_('XAU_USD','c',ymd_(new Date(Date.now()-10*86400000))); diag_('probeOanda','XAU_USD sample','OK',JSON.stringify(rows.slice(-3).map(r=>[ymd_(r[0]),r[1]]))); }
  catch(e){ diag_('probeOanda','XAU_USD sample','ERROR',e.message); }
  log_('probeOanda done — see Diagnostics.');
}

function seriesSkipReason_(s){ if(s.source==='NONE') return 'no source'; if(!s.sourceId&&s.source!=='STOOQ') return 'source_id blank'; if(s.sourceId==='TODO') return 'source_id TODO'; return ''; }
function fetchSeries_(s,startYmd){
  if(s.source==='FRED') return fetchFred_(s.sourceId,startYmd);
  if(s.source==='STOOQ') return fetchStooq_(s.field,startYmd);
  if(s.source==='OANDA') return fetchOanda_(s.sourceId,s.field,startYmd);
  if(s.source==='MAS') return fetchMasLegacy_(s.sourceId,s.field,startYmd);
  if(s.source==='MAS_V1') return fetchMasV1_(s.sourceId,s.field,startYmd);
  if(s.source==='MAS_GW') return fetchMasGw_(s.sourceId,s.field,startYmd);
  throw new Error('unknown source '+s.source);
}

// ---------------------------------------------------------------- MacroHistory upsert (wide)
function colIndexMap_(sh){ const h=sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0]; const m={}; h.forEach((c,i)=>m[c]=i+1); return {header:h,map:m}; }
var HIST_DATES_CACHE_ = null;
function histDateIndex_(sh){
  const lastRow=sh.getLastRow();
  if(HIST_DATES_CACHE_ && HIST_DATES_CACHE_.lastRow===lastRow) return HIST_DATES_CACHE_.index;
  const index={};
  if(lastRow>1) sh.getRange(2,1,lastRow-1,1).getValues().forEach((r,i)=>{ const d=r[0] instanceof Date?ymd_(r[0]):String(r[0]); if(d) index[d]=i; });
  HIST_DATES_CACHE_={lastRow:lastRow,index:index}; return index;
}
function upsertHistory_(seriesId,rows){
  if(!rows.length) return 0;
  const sh=sheet_(HIST); syncHeader_(sh);
  const {map}=colIndexMap_(sh); const col=map[seriesId]; if(!col) throw new Error('no column for '+seriesId);
  const dateRow=histDateIndex_(sh); const lastRow=sh.getLastRow();
  const app=[]; const upd=[]; let minI=Infinity;
  // --- v3 FIX 6: drop future-dated rows. OANDA's daily candle is stamped +12h off the
  // NY 17:00 alignment, which pushed a 2026-09-10 row into the sheet and made the
  // Dashboard header read "Data as of 2026-09-10".
  const todayYmd_=ymd_(new Date());
  for(const [d,v] of rows){ const k=ymd_(d); if(k>todayYmd_) continue; const i=dateRow[k]; if(i!==undefined){ upd.push([i,v]); if(i<minI) minI=i; } else app.push([k,d,v]); }
  if(upd.length){
    const n=lastRow-1-minI; const colVals=sh.getRange(2+minI,col,n,1).getValues();
    for(const [i,v] of upd) colVals[i-minI][0]=v;
    sh.getRange(2+minI,col,n,1).setValues(colVals);
  }
  if(app.length){ app.sort((a,b)=>a[0]<b[0]?-1:1); const start=lastRow+1; const width=sh.getLastColumn();
    const block=app.map(a=>{ const r=new Array(width).fill(''); r[0]=a[1]; r[col-1]=a[2]; return r; });
    sh.getRange(start,1,block.length,width).setValues(block); sh.getRange(start,1,block.length,1).setNumberFormat('yyyy-mm-dd');
    HIST_DATES_CACHE_=null; }
  return upd.length+app.length;
}
function dedupeHistory_(){
  const sh=sheet_(HIST); const n=sh.getLastRow(), w=sh.getLastColumn(); if(n<3) return 0;
  const seen={}; let any=false;
  for(const r of sh.getRange(2,1,n-1,1).getValues()){ const d=r[0]; if(!(d instanceof Date)) continue; const k=ymd_(d); if(seen[k]){ any=true; break; } seen[k]=1; }
  if(!any) return 0;
  const vals=sh.getRange(2,1,n-1,w).getValues(); const byKey={}; const order=[]; let dups=0;
  for(const r of vals){ const d=r[0]; if(!(d instanceof Date)) continue; const k=ymd_(d);
    if(!byKey[k]){ byKey[k]=r.slice(); byKey[k][0]=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())); order.push(k); continue; }
    dups++; const t=byKey[k]; for(let c=1;c<w;c++) if(r[c]!==''&&r[c]!=null) t[c]=r[c]; }
  if(!dups) return 0;
  order.sort(); const out=order.map(k=>byKey[k]);
  sh.getRange(2,1,n-1,w).clearContent();
  sh.getRange(2,1,out.length,w).setValues(out); sh.getRange(2,1,out.length,1).setNumberFormat('yyyy-mm-dd');
  log_('dedupeHistory: merged '+dups+' duplicate date row(s)');
  return dups;
}
function sortHistory_(){ const sh=sheet_(HIST); const n=sh.getLastRow(); if(n>2) sh.getRange(2,1,n-1,sh.getLastColumn()).sort({column:1,ascending:true}); }
// v3.1: was reading a RECTANGLE — every column from A to the target, full height. Measured
// at 3,939 ms (DGS10) and 4,832 ms (SORA_VOL) on a 26,554 x 63 sheet; x55 series is ~4.4
// minutes of a 6-minute execution spent on nothing but this. Two single-column reads instead,
// scanning backwards on a sorted sheet: ~50x less data.
var HIST_DATECOL_CACHE_ = null;
function histDateCol_(sh){
  const lastRow = sh.getLastRow();
  if(HIST_DATECOL_CACHE_ && HIST_DATECOL_CACHE_.lastRow === lastRow) return HIST_DATECOL_CACHE_.dates;
  const dates = lastRow > 1 ? sh.getRange(2,1,lastRow-1,1).getValues() : [];
  HIST_DATECOL_CACHE_ = { lastRow: lastRow, dates: dates };
  return dates;
}
function lastDateFor_(seriesId){
  const sh=sheet_(HIST); const lastRow=sh.getLastRow(); if(lastRow<2) return null;
  const {map}=colIndexMap_(sh); const col=map[seriesId]; if(!col) return null;
  const dates=histDateCol_(sh);
  const vals =sh.getRange(2,col,lastRow-1,1).getValues();
  for(let i=vals.length-1;i>=0;i--){
    const v=vals[i][0];
    if(v!==''&&v!=null&&dates[i][0] instanceof Date) return dates[i][0];
  }
  return null;
}
function recomputeComputed_(sh){
  sh=sh||sheet_(HIST); const lastRow=sh.getLastRow(), lastCol=sh.getLastColumn(); if(lastRow<2) return;
  const {header,map}=colIndexMap_(sh); const compIds=Object.keys(COMPUTED).filter(c=>map[c]);
  if(!compIds.length) return;
  const vals=sh.getRange(2,1,lastRow-1,lastCol).getValues();
  const out={}; compIds.forEach(c=>out[c]=[]);
  for(const row of vals){ const m={}; header.forEach((h,i)=>{ m[h]=row[i]; }); for(const c of compIds){ let v=''; try{ v=COMPUTED[c](m); }catch(e){} out[c].push([(v===''||v==null||(typeof v==='number'&&!isFinite(v)))?'':v]); } }
  compIds.forEach(c=>sh.getRange(2,map[c],vals.length,1).setValues(out[c]));
}

// ---------------------------------------------------------------- rolling windows
function rebuildRolling_(){
  const src=sheet_(HIST); const lastRow=src.getLastRow(), lastCol=src.getLastColumn(); if(lastRow<2) return;
  const header=src.getRange(1,1,1,lastCol).getValues()[0];
  const all=src.getRange(2,1,lastRow-1,lastCol).getValues();
  const today=new Date();
  ROLLING.forEach(([name,years])=>{
    const cut=new Date(today.getTime()); cut.setUTCFullYear(cut.getUTCFullYear()-years);
    const win=all.filter(r=>r[0] instanceof Date && r[0]>=cut);
    let sh=ss_().getSheetByName(name)||ss_().insertSheet(name);
    sh.clearContents();
    sh.getRange(1,1,1,header.length).setValues([header]).setFontWeight('bold');
    if(win.length) sh.getRange(2,1,win.length,header.length).setValues(win);
    // v4: clearContents() empties cells but never removes rows or columns, so each rebuild
    // left the leftovers of the largest version it had ever written — 634 empty rows below
    // the data and a stray 64th column (the ghost of the duplicate "Date" column repairSheet
    // deleted). Trim to exactly what was written.
    const wantRows = win.length + 1, wantCols = header.length;
    if(sh.getMaxRows()    > wantRows) sh.deleteRows(wantRows+1, sh.getMaxRows()-wantRows);
    if(sh.getMaxColumns() > wantCols) sh.deleteColumns(wantCols+1, sh.getMaxColumns()-wantCols);
    sh.getRange('A:A').setNumberFormat('yyyy-mm-dd'); sh.setFrozenRows(1); sh.setFrozenColumns(1);
  });
}

// ---------------------------------------------------------------- Latest
function updateLatest_(){
  let sh=ss_().getSheetByName('MacroData (2Y)'); if(!sh||sh.getLastRow()<30) sh=sheet_(HIST);
  const lastRow=sh.getLastRow(), lastCol=sh.getLastColumn();
  // v4: keep the registry's label and group when a series is ALSO computed (DXY), instead of
  // flattening it to the bare id. Only the source is overridden.
  const meta={}; readSeries_().forEach(s=>meta[s.id]=s);
  Object.keys(COMPUTED).forEach(c=>{ const m=meta[c];
    meta[c] = m ? {label:m.label, group:m.group, source:'computed'} : {label:c, group:'', source:'computed'}; });
  const out=[['series_id','label','group','date','value','prev_date','prev','chg','chg_5obs','chg_20obs','source','updated_at']];
  if(lastRow>1){
    const vals=sh.getRange(1,1,lastRow,lastCol).getValues(); const header=vals[0];
    for(let c=1;c<lastCol;c++){ const id=header[c]; const pts=[];
      for(let r=1;r<vals.length;r++) if(vals[r][c]!==''&&vals[r][c]!=null) pts.push([vals[r][0],vals[r][c]]);
      if(!pts.length) continue; const L=pts.length; const cur=pts[L-1],prev=pts[L-2]||[null,null];
      const p5=pts[L-6]?pts[L-6][1]:null, p20=pts[L-21]?pts[L-21][1]:null; const mt=meta[id]||{};
      out.push([id,mt.label||'',mt.group||'',ymd_(cur[0]),cur[1],prev[0]?ymd_(prev[0]):'',prev[1],
        isNum(prev[1])?cur[1]-prev[1]:'',isNum(p5)?cur[1]-p5:'',isNum(p20)?cur[1]-p20:'',mt.source||'',Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm')]);
    }
  }
  const ls=sheet_(TAB.latest); ls.clearContents(); ls.getRange(1,1,out.length,out[0].length).setValues(out); ls.getRange(1,1,1,out[0].length).setFontWeight('bold');
}

// ---------------------------------------------------------------- backfill (resumable) & daily
function backfill(){
  // --- v3 FIX 7: budget was 2.5 min. On a pause this function RETURNS before finalize,
  // so the 3.5 minutes it reserved were thrown away. 4.5 min roughly doubles throughput.
  const t0=Date.now(), budget=4.5*60*1000;
  let series=readSeries_();
  const only=String(getCfg_('BACKFILL_ONLY','')).split(',').map(x=>x.trim()).filter(Boolean);
  if(only.length){ series=series.filter(s=>only.indexOf(s.id)>=0); log_('backfill: BACKFILL_ONLY → '+series.map(s=>s.id).join(', ')); }
  syncHeader_(sheet_(HIST));
  const cursor=getCfg_('BACKFILL_CURSOR','');
  if(cursor!=='__FINALIZE__'){
    let started=!cursor;
    const inflight=getCfg_('BACKFILL_INFLIGHT','');
    for(const s of series){
      if(!started){ if(s.id===cursor) started=true; else continue; }
      if(Date.now()-t0>budget){ setFlag_('BACKFILL_CURSOR',s.id); log_('backfill paused before '+s.id+' (time) — run again'); return; }
      setFlag_('BACKFILL_CURSOR',s.id);
      const skip=seriesSkipReason_(s); if(skip){ diag_('backfill',s.id,'SKIP',skip); continue; }
      if(inflight===s.id){ setFlag_('BACKFILL_INFLIGHT',''); diag_('backfill',s.id,'ERROR','hit the 6-minute cap last run — skipped this pass; fix the source and re-run backfill()'); continue; }
      setFlag_('BACKFILL_INFLIGHT',s.id);
      const s0=Date.now();
      try{ const rows=fetchSeries_(s,null); const s1=Date.now(); const n=upsertHistory_(s.id,rows);
           diag_('backfill',s.id,rows.length?'OK':'WARN',rows.length+' obs, wrote '+n+' | fetch '+Math.round((s1-s0)/1000)+'s, write '+Math.round((Date.now()-s1)/1000)+'s'); }
      catch(e){ diag_('backfill',s.id,'ERROR',e.message+' | '+Math.round((Date.now()-s0)/1000)+'s'); }
      setFlag_('BACKFILL_INFLIGHT','');
    }
    setFlag_('BACKFILL_CURSOR','__FINALIZE__'); setFlag_('BACKFILL_STAGE','');
    log_('backfill: all series fetched — finalising');
  }
  // --- v3 FIX 2: setFlag_ writes TEXT. setCfg_ wrote the string "TRUE", which Sheets
  // coerced to a boolean, which then failed the === 'TRUE' test in dailyUpdate.
  if(finalizeBackfill_(t0)){ setFlag_('BACKFILL_CURSOR',''); setFlag_('BACKFILL_DONE','TRUE'); setFlag_('BACKFILL_ONLY',''); log_('backfill complete'); }
}
const FINAL_STAGES=['sort','computed','rolling','latest','ratios','dashboard'];
// v4.2.1: beforeDashboard fires immediately before the LAST stage.
// refreshDashboard() READS Config!LAST_RUN and LAST_COMPLETE to print the header, and both
// were stamped after finalizeBackfill_ returned — two seconds too late. On 14 Sep the board
// rendered at 14:19:40 and the clocks were written at 14:19:42, so the header still read
// "last run 2026-09-12 06:27" after a run that had just succeeded. Stamping here is safe:
// a throw in the dashboard stage is caught and not rethrown, so the run completes either way.
function finalizeBackfill_(t0, beforeDashboard){
  let idx=FINAL_STAGES.indexOf(getCfg_('BACKFILL_STAGE','')); if(idx<0) idx=0;
  for(; idx<FINAL_STAGES.length; idx++){
    const st=FINAL_STAGES[idx];
    if(Date.now()-t0 > 4*60*1000){ setFlag_('BACKFILL_STAGE',st); log_('backfill: finalising paused before "'+st+'" (time) — run again'); return false; }
    setFlag_('BACKFILL_STAGE',st); const s0=Date.now();
    try{
      if(st==='sort'){ dedupeHistory_(); sortHistory_(); }
      else if(st==='computed') recomputeComputed_();
      else if(st==='rolling') rebuildRolling_();
      else if(st==='latest') updateLatest_();
      else if(st==='ratios') updateRatios_();
      else if(st==='dashboard'){ if(beforeDashboard) beforeDashboard(); refreshDashboard(); }
      diag_('finalize',st,'OK',Math.round((Date.now()-s0)/1000)+'s');
    }catch(e){ diag_('finalize',st,'ERROR',e.message); if(st==='sort'||st==='computed'||st==='rolling') throw e; }
  }
  setFlag_('BACKFILL_STAGE',''); return true;
}
// --- v4.2 FIX 1: a paused run now continues itself.
// dailyUpdate shares ONE 4-minute clock between the fetch loop and finalizeBackfill_, and the
// only triggers were 05:00 and 06:00. When the 05:00 run finishes the whole fetch, the 06:00
// run skips fetching and has the full budget for the six finalize stages — that path works
// (12 Sep 2026 completed at 06:27). When the 05:00 run pauses mid-fetch, the 06:00 run spends
// its budget finishing the fetch and enters finalize with seconds left, and nothing runs after
// it. 13 and 14 Sep 2026 both ended on "finalising paused before ..." and never resumed.
//
// The damage is not the fetch — MacroHistory was current both days. It is that rebuildRolling_
// never ran, so MacroData (1Y/2Y/5Y/10Y) stayed a day behind, and BOTH updateLatest_ and
// dashLoadHistory_ read the 2Y mirror rather than MacroHistory. Latest and the entire Dashboard
// were a day stale while carrying a fresh updated_at, which is the worst way to be wrong.
//
// A bigger budget cannot fix it. The hard cap is 6 minutes per execution and "sort" alone took
// 132s on 14 Sep, so any budget large enough to guarantee finalize finishes is large enough to
// be killed mid-stage. MORE EXECUTIONS is the fix, and the checkpointing to support them
// already exists. Every pause schedules a one-off trigger a few minutes out, so a run drives
// itself to completion instead of waiting for a scheduled clock that may never come.
const DAILY_CONTINUE_FN   = 'dailyContinue';
const DAILY_CONTINUE_MINS = 2;
const DAILY_CONTINUE_MAX  = 8;   // runaway guard: a stage that always throws must not spawn triggers all day

function clearContinue_(){
  ScriptApp.getProjectTriggers().forEach(t => {
    if(t.getHandlerFunction() === DAILY_CONTINUE_FN) ScriptApp.deleteTrigger(t);
  });
}
// Date-stamped like every other cursor, for the same reason: a count left over from yesterday
// must not decide whether today's run is allowed to continue.
function scheduleContinue_(why){
  const today = todayYmd_();
  const raw   = String(getCfg_('DAILY_CONTINUES','') || '');
  const bar   = raw.indexOf('|');
  const n     = (bar > 0 && raw.slice(0,bar) === today) ? (parseInt(raw.slice(bar+1),10) || 0) : 0;
  if(n >= DAILY_CONTINUE_MAX){
    log_('dailyUpdate: '+why+' — continuation limit ('+DAILY_CONTINUE_MAX+'/day) reached, waiting for the next scheduled trigger');
    return false;
  }
  try{
    clearContinue_();
    ScriptApp.newTrigger(DAILY_CONTINUE_FN).timeBased().after(DAILY_CONTINUE_MINS*60*1000).create();
  }catch(e){
    log_('dailyUpdate: '+why+' — could not schedule a continuation ('+e.message+'); the 06:00 trigger is the fallback');
    return false;
  }
  setFlag_('DAILY_CONTINUES', today+'|'+(n+1));
  log_('dailyUpdate: '+why+' — continuing in '+DAILY_CONTINUE_MINS+' min ('+(n+1)+'/'+DAILY_CONTINUE_MAX+')');
  return true;
}
function dailyContinue(){ clearContinue_(); dailyUpdate(); }

// --- v4.2 FIX 4: one writer at a time.
// With continuations firing every 2 minutes, a continuation started at 05:58 is still running
// when the 06:00 trigger fires, and both would write DAILY_STAGE and the same output tabs.
// Before v4.2 the two scheduled runs were 25 minutes apart on a 6-minute cap, so the race
// could not happen; now it can. tryLock(0) rather than a wait: if another execution holds the
// sheet there is nothing useful for this one to do, and Apps Script releases a lock when the
// execution that took it ends, so a killed run cannot deadlock the next.
function withSheetLock_(name, fn){
  const lock = LockService.getScriptLock();
  if(!lock.tryLock(0)){ log_(name+': another run holds the sheet — skipping this execution'); return; }
  try{ return fn(); } finally { try{ lock.releaseLock(); }catch(e){} }
}

function dailyUpdate(){ return withSheetLock_('dailyUpdate', dailyUpdate_); }
function dailyUpdate_(){
  const t0=Date.now(), budget=4*60*1000;
  const today=todayYmd_();
  // v4.2 FIX 2: stamp the clock on EVERY execution that did work, not only on a completed one.
  const stampRun_ = () => setFlag_('LAST_RUN', Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm'));
  // --- v3 FIX 1 + 3: cfgTrue_ instead of !== 'TRUE', and ALWAYS refresh the presentation
  // layer even mid-backfill. The old code returned here and left Latest / RatiosLatest /
  // Dashboard frozen for two days while the triggers fired perfectly on schedule.
  if(!cfgTrue_('BACKFILL_DONE')){
    log_('dailyUpdate: backfill incomplete — running backfill()');
    backfill();
    refreshPresentation_();   // v4.2: the inner form — a script lock is NOT reentrant, and this
                              // call already runs inside the lock dailyUpdate took.
    return;
  }
  // --- v4 FIX 3: readCursor_ throws away a bookmark that isn't from today. The old code
  // read DAILY_STAGE raw, so a 9 Sep bookmark sent the 10 Sep run straight to series #21.
  const stage = readCursor_('DAILY_STAGE');
  // v4.2 FIX 2: the guard tests LAST_COMPLETE, not LAST_RUN. LAST_RUN now advances on every
  // partial execution, so testing it here would make the first continuation abort the run it
  // was created to finish.
  if(!stage && String(getCfg_('LAST_COMPLETE','')).slice(0,10)===today){
    clearContinue_(); log_('dailyUpdate: already completed today — nothing to do'); return;
  }

  if(stage !== 'finalize'){
    // --- v4 FIX 1 + 2: one window read for the run, then the shared flat-window loop.
    const w = fetchWindowYmd_();
    log_('dailyUpdate: window '+w.days+'d from '+w.ymd+' (newest row in history: '+w.newest+')');
    if(!runFetch_(w.ymd, 'dailyUpdate', 'DAILY_STAGE', t0, budget)){
      stampRun_(); scheduleContinue_('fetch paused'); return;
    }
    writeCursor_('DAILY_STAGE','finalize'); setFlag_('BACKFILL_STAGE','');
  }

  const stamp = Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm');
  const stampDone_ = () => { setFlag_('LAST_RUN', stamp); setFlag_('LAST_COMPLETE', stamp); };
  if(finalizeBackfill_(t0, stampDone_)){
    try{ ingestRunLogs(); }catch(e){ diag_('ingestRunLogs','-','ERROR',e.message); }
    try{ trimLog_(); }catch(e){ diag_('trimLog_','-','ERROR',e.message); }
    setFlag_('DAILY_STAGE','');
    // v4: setFlag_ (TEXT), not setCfg_. Sheets coerces "2026-09-10 06:02" written with
    // setValue into a DATE, and then String(...).slice(0,10) reads "Thu Sep 10" — which
    // never equals today's yyyy-MM-dd, so the "already ran today" guard silently stops
    // working. Same class of bug as BACKFILL_DONE in v3.
    // v4.2: two clocks. LAST_RUN = this execution. LAST_COMPLETE = the last time all six
    // finalize stages actually finished. The Dashboard header used to print LAST_RUN and read
    // "last run 2026-09-12 06:27" on the morning of the 14th, because a run that paused in
    // finalize never reached this line — the one number everyone checks first was two days out
    // while the sheet had in fact run that morning.
    stampDone_();          // idempotent — the dashboard stage already wrote these
    clearContinue_();
    log_('dailyUpdate done');
  } else {
    stampRun_(); scheduleContinue_('finalising paused');
  }
}

// --- v3 FIX 4: the presentation layer, on its own trigger.
// None of these three needs the backfill to be complete — they only read what is already
// in MacroHistory and Ratios. Isolating them means a stuck fetch phase can never again
// leave the brief reading a two-day-old sheet.
// v4.2: same lock. refreshPresentation writes Latest, RatiosLatest and the Dashboard — the last
// three finalize stages. If a dailyUpdate continuation is mid-finalize, this run has nothing to
// add and would only race it; the run that holds the lock does the same work.
function refreshPresentation(){ return withSheetLock_('refreshPresentation', refreshPresentation_); }
function refreshPresentation_(){
  const t0 = Date.now();
  try{ updateLatest_();    diag_('refreshPresentation','latest','OK',    Math.round((Date.now()-t0)/1000)+'s'); }
  catch(e){                diag_('refreshPresentation','latest','ERROR', e.message); }
  const t1 = Date.now();
  try{ updateRatios_();    diag_('refreshPresentation','ratios','OK',    Math.round((Date.now()-t1)/1000)+'s'); }
  catch(e){                diag_('refreshPresentation','ratios','ERROR', e.message); }
  const t2 = Date.now();
  try{ refreshDashboard(); diag_('refreshPresentation','dashboard','OK', Math.round((Date.now()-t2)/1000)+'s'); }
  catch(e){                diag_('refreshPresentation','dashboard','ERROR', e.message); }
  log_('refreshPresentation: done in '+Math.round((Date.now()-t0)/1000)+'s');
}

// ---------------------------------------------------------------- Ratios (GOOGLEFINANCE mirror)

// v4: PUBLIC wrapper. Apps Script hides every function whose name ends in "_" from the Run
// dropdown — that underscore is the language's convention for a private helper. buildRatiosTab_
// has always been one, so there was no way to rebuild the Ratios tab from the UI. Run this.
//
// GOOGLEFINANCE recalculates ASYNCHRONOUSLY. The formulas land instantly, the prices do not,
// so this deliberately does NOT call updateRatios_ afterwards — doing so would read a
// half-filled panel and write a rotation block full of "insufficient". Wait for the tab to
// fill, then run finalizeNow().
function rebuildRatios(){
  buildRatiosTab_();
  const n = ['SPY'].concat(RATIO_GROUPS.reduce((a,g)=>a.concat(g[1]),[])).length;
  log_('rebuildRatios: Ratios tab rebuilt with '+n+' GOOGLEFINANCE columns from '+RATIOS_START+'. '+
       'Prices fill in asynchronously — give it a minute, check the Ratios tab is populated '+
       '(especially SPMO and IGV), THEN run finalizeNow().');
}

function gfTicker_(t){ return (GF_EXCHANGE[t]||'NYSEARCA')+':'+t; }
function buildRatiosTab_(){
  const sh=ss_().getSheetByName(TAB.ratios)||ss_().insertSheet(TAB.ratios); sh.clear();
  const tickers=['SPY'].concat(RATIO_GROUPS.flatMap(g=>g[1]));
  const d=RATIOS_START.split('-').map(Number); const dateExpr='DATE('+d[0]+','+d[1]+','+d[2]+')';
  sh.getRange('A1').setFormula('=INDEX(GOOGLEFINANCE("'+gfTicker_('SPY')+'","close",'+dateExpr+',TODAY(),"DAILY"),0,1)');
  tickers.forEach((t,i)=>{ const col=i+2; sh.getRange(1,col).setValue(t).setFontWeight('bold');
    sh.getRange(2,col).setFormula('=ARRAYFORMULA(IFERROR(VLOOKUP(A2:A,GOOGLEFINANCE("'+gfTicker_(t)+'","close",'+dateExpr+',TODAY(),"DAILY"),2,FALSE),""))'); });
  sh.getRange('A:A').setNumberFormat('yyyy-mm-dd'); sh.setFrozenRows(1); sh.setFrozenColumns(1);
}
function sma_(a,n){ if(a.length<n) return null; let s=0; for(let i=a.length-n;i<a.length;i++) s+=a[i]; return s/n; }
function rel_(a,n){ return a.length>n?(a[a.length-1]/a[a.length-1-n]-1)*100:null; }

// --- v3 FIX 5: two bugs, both visible in the sheet on 9 Sep 2026.
//   1. GOOGLEFINANCE fills its trailing rows at different times per ticker. On 8 Sep only
//      21 of 37 tickers had a value. The old code walked each ticker to ITS OWN last
//      numeric row, so RatiosLatest mixed as-of dates — XLK measured to 8 Sep against RSP
//      measured to 4 Sep. Every cross-sectional comparison was then wrong.
//      Fix: cut the whole panel at the last date >=90% of tickers share.
//   2. The per-ticker alignment used a forward-only cursor that could not rewind, so a
//      ticker with a gap silently misaligned against SPY. Fix: index rows by position.
// --- v4 FIX 6: the 90% rule was throwing away good data.
// GOOGLEFINANCE fills each ticker's column at its own pace. On 8 Sep only 21 of 37 tickers
// had a price, so the panel fell back to the last row where 90% did — 4 Sep — and every
// relative-strength number on the dashboard was four days old, for three days running.
// Two tiers instead: a coverage threshold sets the panel date, tickers that have a price
// there are measured to it and marked "ok", and the laggards are measured to their OWN last
// date and marked STALE with the gap in days. Nothing is silently mixed — v3 was right that
// comparing XLK on 8 Sep against RSP on 4 Sep is meaningless, so the dashboard greys
// anything that isn't on the panel date rather than ranking it as equal.
//
// TWO changes are needed, and each is useless without the other. Measured on the real
// 10 Sep sheet, where 8 Sep is the date we want and 4 Sep is what v3 picked:
//
//   threshold   counted over        need   panel picked
//   90%         all 36 tickers       33    2026-09-04   <- v3
//   60%         all 36 tickers       22    2026-09-04
//   60%         the 34 populated     21    2026-09-04   <- still misses, by ONE ticker
//   50%         the 34 populated     17    2026-09-08   <- correct
//
// SPMO and IGV are blank in all 2,937 rows (wrong GF_EXCHANGE prefix), so counting them
// permanently drags every date's coverage down by two. They are excluded from the
// denominator — a ticker with no data anywhere is a broken ticker, not a missing print,
// and it should not decide which date the whole panel sits on. Fix the prefixes with
// probeGoogleFinance() and they simply rejoin the count.
const RATIO_PANEL_COVERAGE = 0.5;
function updateRatios_(){
  const sh = sheet_(TAB.ratios);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const out = [['group','ticker','date','ratio','rel_1d','rel_5d','rel_20d','rel_60d','rel_ytd',
                'sma20','sma50','sma200','above50','above200','pct_rank_1y','hi_1y','lo_1y','n','status','stale_days']];
  if(lastRow < 30){
    out.push(['','','','','','','','','','','','','','','','','',0,'GOOGLEFINANCE not readable — brief uses IBKR fallback','']);
    return writeRatios_(out);
  }
  const vals = sh.getRange(1,1,lastRow,lastCol).getValues();
  const header = vals[0];
  const spyC = header.indexOf('SPY');
  if(spyC < 0){
    out.push(['','','','','','','','','','','','','','','','','',0,'no SPY column on the Ratios tab','']);
    return writeRatios_(out);
  }
  // v4: count coverage over tickers that are populated SOMEWHERE in the sheet. A column
  // that is blank in every row (SPMO, IGV) is a broken prefix, not a late print, and letting
  // it vote drags the panel date backwards for every other ticker. See the table above.
  const tracked = [], dead = [];
  RATIO_GROUPS.forEach(g => g[1].forEach(t => {
    const c = header.indexOf(t); if(c < 0) return;
    let any = false;
    for(let r = 1; r < vals.length; r++) if(typeof vals[r][c] === 'number'){ any = true; break; }
    if(any) tracked.push(c); else dead.push(t);
  }));
  if(!tracked.length){
    out.push(['','','','','','','','','','','','','','','','','',0,'every ticker column is blank — run probeGoogleFinance()','']);
    return writeRatios_(out);
  }
  const need = Math.ceil(tracked.length * RATIO_PANEL_COVERAGE);

  let cutRow = 0;
  for(let r = vals.length-1; r >= 1; r--){
    if(!(vals[r][0] instanceof Date)) continue;
    if(typeof vals[r][spyC] !== 'number') continue;
    let filled = 0;
    for(let k = 0; k < tracked.length; k++) if(typeof vals[r][tracked[k]] === 'number') filled++;
    if(filled >= need){ cutRow = r; break; }
  }
  if(!cutRow){
    out.push(['','','','','','','','','','','','','','','','','',0,
              'no row with >='+Math.round(RATIO_PANEL_COVERAGE*100)+'% ticker coverage','']);
    return writeRatios_(out);
  }
  const cutDate = ymd_(vals[cutRow][0]);

  const dates = [], spy = [], rowIdx = [];
  for(let r = 1; r <= cutRow; r++){
    const d = vals[r][0], v = vals[r][spyC];
    if(d instanceof Date && typeof v === 'number' && v > 0){ dates.push(d); spy.push(v); rowIdx.push(r); }
  }
  const yr = dates.length ? dates[dates.length-1].getUTCFullYear() : null;

  RATIO_GROUPS.forEach(g => {
    const group = g[0];
    g[1].forEach(t => {
      const c = header.indexOf(t);
      if(c < 0){ out.push([group,t,'','','','','','','','','','','','','','','',0,'no column','']); return; }
      const ratio = [], rd = [];
      for(let i = 0; i < dates.length; i++){
        const v = vals[rowIdx[i]][c];
        if(typeof v === 'number' && v > 0){ ratio.push(v/spy[i]); rd.push(dates[i]); }
      }
      if(ratio.length < 30){
        out.push([group,t,'','','','','','','','','','','','','','','',ratio.length,
                  ratio.length === 0 ? 'BLANK — wrong GF_EXCHANGE? run probeGoogleFinance()' : 'insufficient','']);
        return;
      }
      const last = ratio[ratio.length-1];
      let base = null;
      for(let j = ratio.length-1; j >= 0; j--) if(rd[j].getUTCFullYear() < yr){ base = ratio[j]; break; }
      const w = ratio.slice(-252);
      const rank = w.filter(x => x <= last).length / w.length * 100;
      const s20 = sma_(ratio,20), s50 = sma_(ratio,50), s200 = sma_(ratio,200);
      const asof = ymd_(rd[rd.length-1]);
      // v4: how far this ticker's own last price sits behind the panel date. 0 = measured to
      // the panel and directly comparable; anything else is greyed on the dashboard so a
      // 4 Sep ratio is never ranked against an 8 Sep one as though they were the same day.
      const staleDays = asof === cutDate ? 0
        : Math.round((toDate_(cutDate).getTime() - rd[rd.length-1].getTime()) / 86400000);
      out.push([group, t, asof, last,
                rel_(ratio,1), rel_(ratio,5), rel_(ratio,20), rel_(ratio,60),
                base ? (last/base-1)*100 : '',
                s20, s50, s200, s50?last>s50:'', s200?last>s200:'',
                rank, Math.max.apply(null,w), Math.min.apply(null,w), ratio.length,
                asof === cutDate ? 'ok' : 'STALE '+asof+' vs panel '+cutDate, staleDays]);
    });
  });
  writeRatios_(out);
  const nStale = out.slice(1).filter(r => r[18] && String(r[18]).indexOf('STALE') === 0).length;
  log_('updateRatios_: panel as of '+cutDate+' ('+tracked.length+' live tickers, needs '+need+
       ' populated, '+nStale+' measured to an earlier date'+
       (dead.length ? '; '+dead.length+' blank in every row and excluded from the count: '+dead.join(', ')+
                      ' — run probeGoogleFinance()' : '')+')');
}
function writeRatios_(out){ const ls=sheet_(TAB.ratiosLatest); ls.clearContents(); ls.getRange(1,1,out.length,out[0].length).setValues(out); ls.getRange(1,1,1,out[0].length).setFontWeight('bold'); ls.getRange(1,out[0].length+2).setValue('updated_at'); ls.getRange(2,out[0].length+2).setValue(Utilities.formatDate(new Date(),TZ,'yyyy-MM-dd HH:mm')); }

// --- v3 FIX 9: SPMO and IGV were empty in ALL 2,937 Ratios rows — the GF_EXCHANGE prefix
// is wrong for them and GOOGLEFINANCE fails silently rather than erroring. This writes a
// live test grid so you can read off which prefix resolves instead of guessing. Correct
// GF_EXCHANGE above, then run buildRatiosTab_().
function probeGoogleFinance(){
  const tickers = RATIO_GROUPS.reduce((a,g) => a.concat(g[1]), ['SPY']);
  const prefixes = ['', 'NYSEARCA:', 'NASDAQ:', 'BATS:', 'NYSE:'];
  const ss = ss_();
  const t = ss.getSheetByName('GFTest') || ss.insertSheet('GFTest');
  t.clear();
  const head = ['ticker','current GF_EXCHANGE'].concat(prefixes.map(p => p || '(bare)'));
  t.getRange(1,1,1,head.length).setValues([head]).setFontWeight('bold');
  const rows = tickers.map(tk => {
    const r = [tk, GF_EXCHANGE[tk] || 'NYSEARCA (default)'];
    prefixes.forEach(() => r.push(''));
    return r;
  });
  t.getRange(2,1,rows.length,head.length).setValues(rows);
  tickers.forEach((tk,i) => prefixes.forEach((p,j) =>
    t.getRange(2+i, 3+j).setFormula('=IFERROR(GOOGLEFINANCE("'+p+tk+'","price"),"—")')));
  t.getRange(2,3,rows.length,prefixes.length).setNumberFormat('0.00');
  ss.setActiveSheet(t);
  log_('probeGoogleFinance: GFTest tab written. A number = that prefix works; "—" = it does not.');
}

// --- v3 FIX 8: one-off cleanup of damage already done. Run once after pasting this file.
//   a. Config!BACKFILL_DONE is a boolean      -> rewrite as the text "TRUE"
//   b. MacroHistory!A1 is a single space " "  -> set to "Date". While A1 is blank,
//      syncHeader_ thinks the Date column is missing and appends a SECOND one.
//   c. a stray empty "Date" column at col 60  -> delete it (created by b)
//   d. unsorted history with future-dated rows -> drop, dedupe, sort
function repairSheet(){
  setFlag_('BACKFILL_DONE','TRUE');
  setFlag_('BACKFILL_CURSOR','');
  setFlag_('BACKFILL_STAGE','');
  setFlag_('BACKFILL_INFLIGHT','');
  setFlag_('BACKFILL_ONLY','');
  setFlag_('DAILY_STAGE','');
  log_('repairSheet: flags rewritten as text');

  const sh = sheet_(HIST);

  if(String(sh.getRange(1,1).getValue()).trim() === ''){
    sh.getRange(1,1).setValue('Date');
    log_('repairSheet: MacroHistory!A1 was blank — set to "Date"');
  }
  const hdr = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  for(let c = hdr.length; c >= 2; c--){                    // right to left so indices hold
    if(String(hdr[c-1]).trim() === 'Date'){
      sh.deleteColumn(c);
      log_('repairSheet: deleted duplicate "Date" column at '+c);
    }
  }

  const n = sh.getLastRow(), w = sh.getLastColumn();
  if(n > 2){
    const vals = sh.getRange(2,1,n-1,w).getValues();
    const todayYmd = ymd_(new Date());
    const kept = vals.filter(r => (r[0] instanceof Date) && ymd_(r[0]) <= todayYmd);
    const dropped = (n-1) - kept.length;
    if(dropped > 0){
      sh.getRange(2,1,n-1,w).clearContent();
      sh.getRange(2,1,kept.length,w).setValues(kept);
      log_('repairSheet: dropped '+dropped+' future-dated / non-date row(s)');
    }
  }
  HIST_DATES_CACHE_ = null;
  dedupeHistory_();
  sortHistory_();
  log_('repairSheet: history deduped and sorted — now run refreshPresentation()');
}

// Bring an existing Series tab up to date with DEFAULT_SERIES.
function resyncSeries(){
  const sh=sheet_(TAB.series); const n=sh.getLastRow(); const vals=n>1?sh.getRange(2,1,n-1,7).getValues():[];
  const rowOf={}; vals.forEach((r,i)=>{ if(r[0]) rowOf[String(r[0]).trim()]=i; });
  let updated=0; const add=[];
  DEFAULT_SERIES.forEach(d=>{ const i=rowOf[d[0]]; if(i===undefined){ add.push(d); return; }
    const cur=vals[i]; if(cur[2]!==d[2]||cur[3]!==d[3]||cur[4]!==d[4]){ vals[i]=[d[0],d[1],d[2],d[3],d[4],d[5],d[6]]; updated++; } });
  if(updated&&vals.length) sh.getRange(2,1,vals.length,7).setValues(vals);
  if(add.length) sh.getRange(sh.getLastRow()+1,1,add.length,7).setValues(add);
  syncHeader_(sheet_(HIST));
  log_('resyncSeries: '+updated+' row(s) updated, '+add.length+' added');
}

// ---------------------------------------------------------------- triggers & probes
// --- v4 FIX 5: the 04:00 SGT run was 16:00 ET the previous day. FRED H.15 publishes at
// roughly 16:15 ET, so that trigger was scheduled to arrive minutes BEFORE the data it went
// looking for — even a flawless run came back a day short. 05:00 SGT is 17:00 ET, safely
// after. Apps Script fires within a ~15-min window of the stated hour, so:
//
//   05:00 SGT  dailyUpdate            17:00 ET — after H.15
//   06:00 SGT  dailyUpdate (retry)    continues if the first run paused
//   06:30 SGT  refreshPresentation    Latest + Ratios + Dashboard, ~3 min
//   07:00 SGT  the brief reads the sheet
function installTriggers(){
  ScriptApp.getProjectTriggers().forEach(t=>{
    const f=t.getHandlerFunction();
    // v4.2: sweep stray dailyContinue one-offs too. A run killed mid-execution leaves its
    // continuation behind, and the 20-trigger-per-script quota is not large.
    if(f==='dailyUpdate'||f==='refreshPresentation'||f===DAILY_CONTINUE_FN) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyUpdate').timeBased().everyDays(1).atHour(5).inTimezone(TZ).create();
  ScriptApp.newTrigger('dailyUpdate').timeBased().everyDays(1).atHour(6).inTimezone(TZ).create();
  // nearMinute keeps refreshPresentation clear of the 06:00 retry's +/-15 min window.
  // If it is ever rejected, fall back to the hour rather than leaving no trigger at all —
  // a half-installed schedule is the failure mode that is hard to notice.
  let presentationAt = '06:30';
  try{
    ScriptApp.newTrigger('refreshPresentation').timeBased().everyDays(1).atHour(6).nearMinute(30).inTimezone(TZ).create();
  }catch(e){
    ScriptApp.newTrigger('refreshPresentation').timeBased().everyDays(1).atHour(6).inTimezone(TZ).create();
    presentationAt = '06:00 (nearMinute rejected: '+e.message+')';
  }
  clearContinue_();   // v4.2: drop any orphan one-off left by a killed run
  log_('installTriggers: dailyUpdate 05:00 + 06:00 (each pause self-continues every '+DAILY_CONTINUE_MINS+
       ' min, max '+DAILY_CONTINUE_MAX+'/day), refreshPresentation '+presentationAt+' '+TZ+' (brief reads at 07:00)');
}
function probeMas(){
  const done=new Set();
  for(const s of readSeries_()){ if(s.source!=='MAS'||done.has(s.sourceId)) continue; done.add(s.sourceId);
    try{ const js=fetchJson_(MAS_LEGACY+'?resource_id='+s.sourceId+'&limit=1'); const f=(js.result&&js.result.fields||[]).map(x=>x.id); log_('probeMas '+s.sourceId+' fields: '+JSON.stringify(f)); log_('probeMas '+s.sourceId+' record: '+JSON.stringify((js.result&&js.result.records&&js.result.records[0])||{}).slice(0,1500)); }
    catch(e){ log_('probeMas '+s.sourceId+' ERROR '+e.message); } }
}
function probeMasV1(){
  const cands=MAS_V1_BENCHMARK_CANDIDATES.concat(MAS_V1_TBILL_CANDIDATES);
  for(const path of cands){
    try{
      const js=fetchJson_(MAS_V1.replace(/\/$/,'')+'/'+path+'?rows=1');
      const recs=(js.result&&js.result.records)||js.records||[];
      const keys=recs.length?Object.keys(recs[0]):[];
      log_('probeMasV1 '+path+' → success='+(js.success)+' total='+((js.result&&js.result.total)||'?')+' keys: '+JSON.stringify(keys));
      if(recs.length) log_('probeMasV1 '+path+' record: '+JSON.stringify(recs[0]).slice(0,1500));
    }catch(e){ log_('probeMasV1 '+path+' ERROR '+e.message); }
  }
  log_('probeMasV1 done — copy the working path + key into the Series tab.');
}
const CANDIDATE_PATHS = [
  'bondsandbills/m/listsgsbenchmarkissueprices','bondsandbills/m/listbenchmarkissue',
  'bondsandbills/m/listbondpricesandyields','bondsandbills/m/listsgspricesandyields',
  'bondsandbills/m/listsgsprices','bondsandbills/m/listpricesandyields',
  'bondsandbills/m/benchmarkissue','bondsandbills/m/listsgsbenchmark',
  'bondsandbills/m/listmasbillspricesandyields','bondsandbills/m/listmasbills',
  'bondsandbills/m/listtreasurybillscmtbspricesandyields',
  'dir/m/listdomesticinterestrates','dir/m/domesticinterestrates','dir/listdomesticinterestrates',
  'domesticinterestrates/m/listdomesticinterestrates','m/listdomesticinterestrates',
  'interestrates/m/listinterestrates','sora/m/listsora','dir/m/listsora',
  'exchangerates/m/listexchangerates','fx/m/listexchangerates','dir/m/listexchangerates',
  'bondsandbills/m/issuancecalendar','bondsandbills/m/savingbondsissuancecalendar',
];
function probeMasPaths(){
  let hits=0;
  for(const path of CANDIDATE_PATHS){
    try{
      const js=fetchJson_(MAS_V1.replace(/\/$/,'')+'/'+path+'?rows=1');
      const recs=(js.result&&js.result.records)||js.records||[];
      if(recs.length){ hits++;
        log_('HIT '+path+' total='+((js.result&&js.result.total)||'?')+' keys: '+JSON.stringify(Object.keys(recs[0])));
        log_('HIT '+path+' record: '+JSON.stringify(recs[0]).slice(0,1200));
      } else {
        log_('empty '+path+' success='+js.success);
      }
    }catch(e){
      if(String(e.message).indexOf('HTTP 404')<0) log_('probeMasPaths '+path+' ERROR '+e.message);
    }
    Utilities.sleep(200);
  }
  log_('probeMasPaths done — '+hits+' endpoint(s) returned records.');
}
function firstRun(){ setupSheets(); backfill(); installTriggers(); }
// ---------------------------------------------------------------- v4: log hygiene
// refreshLive fires every 10 minutes and used to write a line each time — 144 rows a day.
// On 10 Sep the last 70 Log rows were all live-quote noise and the dailyUpdate lines that
// would have explained the failure were buried hundreds of rows up.
const LOG_KEEP_ROWS = 500;
function trimLog_(){
  const sh = ss_().getSheetByName(TAB.log);
  if(!sh) return 0;
  const n = sh.getLastRow();
  if(n <= LOG_KEEP_ROWS) return 0;
  sh.deleteRows(1, n - LOG_KEEP_ROWS);          // Log has no header row — log_ just appends
  return n - LOG_KEEP_ROWS;
}

// ---------------------------------------------------------------- v4: healthCheck
// One answer to "is the sheet actually current?", without reading Diagnostics.
//
// The staleness threshold is derived per series rather than hardcoded. Latest already holds
// each series' last two observation dates, so the gap between them IS that series' observed
// cadence — daily, weekly, monthly or auction-driven. Expected age is then two cadences plus
// a few days' slack. Self-calibrating: add a quarterly series tomorrow and this still works.
// A cell that holds a date may come back as a Date OBJECT or as a yyyy-MM-dd STRING,
// depending on whether Sheets coerced it on the way in. updateLatest_ writes ymd_() strings
// and Sheets silently converts them to real dates, so the first version of healthCheck read
// every row as "NO DATE" — toDate_'s regex cannot match "Thu Sep 10 2026 00:00:00 GMT+0800".
// Anything reading a date back out of a sheet has to tolerate both.
function anyDate_(v){
  if(v === '' || v == null) return null;
  // duck-typed rather than `instanceof Date`: a date that arrives from another execution
  // context fails instanceof while behaving like a date in every way that matters here
  if(typeof v === 'object' && typeof v.getTime === 'function' && isFinite(v.getTime())){
    // v4.1: AND IT IS A DAY OUT IF YOU READ IT WITH UTC GETTERS.
    // updateLatest_ and updateRatios_ write dates as ymd_() TEXT. Sheets parses that text in
    // the SPREADSHEET's timezone, so "2026-09-10" is stored as 2026-09-10 00:00 +08:00 —
    // which is 2026-09-09 16:00 UTC. ymd_() then reads it back with getUTC* and reports the
    // 9th. That is why healthCheck said the rotation panel was "as of 2026-09-09" in the
    // same breath as updateRatios_ logging "panel as of 2026-09-10".
    // Re-read it in TZ to recover the calendar date that was actually written, and hand back
    // a clean UTC-midnight Date so ymd_() agrees with it from here on.
    return toDate_(Utilities.formatDate(v, TZ, 'yyyy-MM-dd'));
  }
  return toDate_(v);
}
// Observation spacing is not the same thing as publication frequency, and for one family it
// matters. Fed H.10 (every DEX* rate, and the DTWEXBGS broad dollar index) is RELEASED once a
// week carrying that week's daily observations — so its prints sit one day apart while the
// series itself can be seven days behind and be perfectly healthy.
// Measured on Evan's sheet, 11 Sep 2026: DGS2 (H.15, daily release) was 2 days old; DEXSIUS,
// DEXJPUS, DEXCHUS, DTWEXBGS and the six new basket rates were all 7. Deriving the limit from
// spacing alone would flag nine healthy series every single day — and a check that cries wolf
// daily is one you stop reading, which defeats the point of having it.
// NOTE: this is why the daily DXY column can be up to a week behind while the live DXY on the
// Live tab is current. Both are correct; they are measuring different things.
function publishLagFloor_(id){
  // DXY is computed from the six DEX* basket rates, so it inherits their release lag —
  // a computed series can only be as fresh as its slowest input.
  return (String(id).indexOf('DEX') === 0 || id === 'DTWEXBGS' || id === 'DXY') ? 12 : 0;
}

// How old is this series allowed to get before it is genuinely stale?
// Derived from its own observation spacing, in bands, because a flat multiple does not work
// across four orders of publication frequency:
//   daily   spacing 1d   -> 6d   catches a daily series that has quietly stopped
//   weekly  spacing 7d   -> 18d  one missed release plus slack
//   monthly spacing 30d  -> 95d  an observation dated the 1st of a month is released weeks
//                                later and then stands for a further month. Core PCE dated
//                                1 Jul publishes ~28 Aug and is still the newest print on
//                                28 Sep — 89 days old and perfectly healthy.
// The first version used spacing*2+3, which gave monthlies 63 days and flagged CPI, Core PCE
// and M2 as stale when all three were current. Three false alarms a day is how a check stops
// being read.
function staleLimitDays_(id, cadence){
  let limit;
  if(cadence <= 3)       limit = 6;
  else if(cadence <= 10) limit = 18;
  else                   limit = cadence * 3 + 5;
  return Math.max(limit, publishLagFloor_(id));
}
function healthCheck(){
  const out = [];
  const cur = k => { const v = String(getCfg_(k,'')||''); return v || '(empty)'; };
  out.push('LAST_RUN='+cur('LAST_RUN')+'  LAST_COMPLETE='+cur('LAST_COMPLETE')+
           '  DAILY_STAGE='+cur('DAILY_STAGE')+'  BACKFILL_STAGE='+cur('BACKFILL_STAGE')+
           '  CATCHUP_CURSOR='+cur('CATCHUP_CURSOR')+'  BACKFILL_DONE='+cfgTrue_('BACKFILL_DONE'));
  out.push('DAILY_CONTINUES='+cur('DAILY_CONTINUES')+'  pending continuation trigger: '+
           (ScriptApp.getProjectTriggers().filter(t=>t.getHandlerFunction()===DAILY_CONTINUE_FN).length ? 'yes' : 'no'));

  const w = fetchWindowYmd_();
  out.push('history newest row = '+w.newest+'  ->  next fetch window '+w.days+'d from '+w.ymd);

  // --- v4.2 FIX 3: the mirror lag, stated out loud.
  // updateLatest_ and dashLoadHistory_ both read MacroData (2Y), which only rebuilds inside the
  // finalize "rolling" stage. On 13 and 14 Sep 2026 that stage never ran, so Latest and the
  // whole Dashboard were a day behind MacroHistory while stamped with a fresh updated_at.
  // Nothing on the board said so. Now it does.
  const mirror = ss_().getSheetByName('MacroData (2Y)');
  if(!mirror || mirror.getLastRow() < 30){
    out.push('MacroData (2Y) is missing or too short — Latest and the Dashboard are reading MacroHistory directly');
  }else{
    const md = mirror.getRange(mirror.getLastRow(),1).getValue();
    const mYmd = md instanceof Date ? ymd_(md) : String(md);
    const lag = (w.newest && mYmd) ? Math.round((toDate_(w.newest) - toDate_(mYmd))/86400000) : null;
    out.push('MacroData (2Y) newest row = '+mYmd+(lag ? '   *** '+lag+' DAY(S) BEHIND MacroHistory — run finalizeNow() ***' : '   (in step with MacroHistory)'));
  }

  const sh = ss_().getSheetByName(TAB.latest);
  if(!sh || sh.getLastRow() < 2){ out.push('Latest is empty — run refreshPresentation()'); }
  else{
    const vals = sh.getRange(2,1,sh.getLastRow()-1,11).getValues();
    const today = new Date(); const stale = [];
    let ok = 0;
    vals.forEach(r => {
      const id = String(r[0]||'').trim(); if(!id) return;
      const d = anyDate_(r[3]), p = anyDate_(r[5]);
      if(!d){ stale.push(id+' NO DATE'); return; }
      const age = Math.floor((today.getTime() - d.getTime()) / 86400000);
      const cadence = p ? Math.max(1, Math.round((d.getTime()-p.getTime())/86400000)) : 1;
      const limit = staleLimitDays_(id, cadence);
      if(age > limit) stale.push(id+' '+ymd_(d)+' ('+age+'d, expects <='+limit+'d, '+String(r[10]||'')+')');
      else ok++;
    });
    out.push(ok+' series current, '+stale.length+' stale');
    stale.forEach(s => out.push('   STALE  '+s));
    if(!stale.length) out.push('   every series is within its own publication cadence');
  }

  const rl = ss_().getSheetByName(TAB.ratiosLatest);
  if(rl && rl.getLastRow() > 1){
    const rv = rl.getRange(2,1,rl.getLastRow()-1,19).getValues();
    // same coercion trap — these printed as "Thu Sep 10 2026 00:00:00 GMT+0800" before
    const dates = rv.map(r => anyDate_(r[2])).filter(Boolean).map(ymd_).sort();
    const nStale = rv.filter(r => String(r[18]||'').indexOf('STALE') === 0).length;
    const nBlank = rv.filter(r => String(r[18]||'').indexOf('BLANK') === 0).length;
    out.push('rotation panel as of '+(dates.length ? dates[dates.length-1] : '—')+
             '  ('+nStale+' measured to an earlier date, '+nBlank+' blank — blank means a bad GF_EXCHANGE prefix)');
  }

  out.forEach(l => log_('healthCheck: '+l));
  log_('healthCheck: done — read the lines above in the Log tab');
  return out.join('\n');
}

// ---------------------------------------------------------------- 1. diagnosis
// Answers, with evidence rather than inference: is the flag readable, is the key present,
// how slow is the rectangle read, and does FRED actually have anything newer than 3 Sep.
function whyNoUpdate(){
  const sh = sheet_(HIST);
  const out = [];
  out.push('BACKFILL_DONE raw = ' + JSON.stringify(getCfg_('BACKFILL_DONE','')) +
           '  -> cfgTrue_ = ' + cfgTrue_('BACKFILL_DONE'));
  out.push('LAST_RUN       = ' + JSON.stringify(getCfg_('LAST_RUN','')));
  out.push('DAILY_STAGE    = ' + JSON.stringify(getCfg_('DAILY_STAGE','')));
  out.push('BACKFILL_STAGE = ' + JSON.stringify(getCfg_('BACKFILL_STAGE','')));
  out.push('FRED_API_KEY   = ' + (getCfg_('FRED_API_KEY','') ? 'present' : 'MISSING — every FRED series fails'));
  out.push('OANDA_API_KEY  = ' + (getCfg_('OANDA_API_KEY','') ? 'present' : 'MISSING'));
  out.push('MacroHistory   = ' + (sh.getLastRow()-1) + ' rows x ' + sh.getLastColumn() + ' cols');

  // how expensive is the rectangle read that dailyUpdate makes 55 times?
  let t = Date.now();
  const d1 = lastDateFor_('DGS10');
  out.push('lastDateFor_(DGS10, early col)    = ' + (d1 ? ymd_(d1) : 'null') + '   ' + (Date.now()-t) + ' ms');
  t = Date.now();
  const d2 = lastDateFor_('SORA_VOL');
  out.push('lastDateFor_(SORA_VOL, late col)  = ' + (d2 ? ymd_(d2) : 'null') + '   ' + (Date.now()-t) + ' ms');
  out.push('  >>> multiply the second number by 55. If it exceeds ~6000 ms, dailyUpdate can never finish.');

  // does the upstream actually have anything newer?
  const since = ymd_(new Date(Date.now() - 21*86400000));
  try{
    const r = fetchFred_('DGS10', since);
    out.push('FRED DGS10 probe since ' + since + ': ' + r.length + ' obs, newest ' +
             (r.length ? ymd_(r[r.length-1][0]) + ' = ' + r[r.length-1][1] : 'NONE'));
  }catch(e){ out.push('FRED DGS10 probe FAILED: ' + e.message); }

  out.forEach(l => log_('whyNoUpdate: ' + l));
  log_('whyNoUpdate: done — read the lines above in the Log tab');
}

// ---------------------------------------------------------------- 2. the fetch that works
// Flat FETCH_WINDOW_MIN_DAYS window (90) for every series. No lastDateFor_, no rectangle reads, no per-series
// state machine. Resumable via Config!CATCHUP_CURSOR if it runs out of clock.
// v4: now a thin wrapper over the same runFetch_ loop dailyUpdate uses, with a fixed
// FETCH_WINDOW_MIN_DAYS (90 as of v4.1)
// window. The only difference from dailyUpdate is that it does not finalise — you run
// finalizeNow() after it, which is the existing manual workflow.
// v4.2: both manual entry points take the same lock as the scheduled run. Evan runs these
// from the Markets menu, and a self-continuation can now fire while he is doing it.
function catchUp(){ return withSheetLock_('catchUp', catchUp_); }
function catchUp_(){
  const t0 = Date.now();
  const startYmd = ymd_(new Date(Date.now() - FETCH_WINDOW_MIN_DAYS*86400000));
  if(runFetch_(startYmd, 'catchUp', 'CATCHUP_CURSOR', t0, 4.5*60*1000)){
    // --- v4 FIX 4: clear DAILY_STAGE as well. Running catchUp() by hand on 9 Sep is exactly
    // what left a live bookmark behind for the 10 Sep trigger to obey. A manual catch-up has
    // just fetched every series, so any bookmark the scheduled run left is meaningless.
    setFlag_('DAILY_STAGE','');
    clearContinue_();   // v4.2: a hand-run catch-up supersedes whatever the scheduled run was resuming
    log_('catchUp: complete — DAILY_STAGE cleared. Now run finalizeNow().');
  } else {
    log_('catchUp: paused on the clock — run catchUp() again to continue.');
  }
}

// ---------------------------------------------------------------- 3. rebuild everything downstream
// Runs the same six checkpointed stages the backfill uses: sort, computed, rolling, latest,
// ratios, dashboard. Resumes from Config!BACKFILL_STAGE, so just run it again if it pauses.
function finalizeNow(){ return withSheetLock_('finalizeNow', finalizeNow_); }
function finalizeNow_(){
  const t0 = Date.now();
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm');
  const stampDone_ = () => { setFlag_('LAST_RUN', stamp); setFlag_('LAST_COMPLETE', stamp); };
  if(finalizeBackfill_(t0, stampDone_)){
    // --- v4 FIX 4: clear BOTH cursors. finalizeNow() used to write LAST_RUN and leave
    // DAILY_STAGE pointing at whichever series the scheduled run had paused on — which is
    // how a 9 Sep bookmark survived to misdirect the 10 Sep run.
    setFlag_('DAILY_STAGE','');
    setFlag_('CATCHUP_CURSOR','');
    // v4.2: a manual finalize IS a completion — stamp both clocks and cancel any pending
    // self-continuation, or the trigger fires two minutes later on work already done.
    stampDone_();
    clearContinue_();
    log_('finalizeNow: complete — computed columns, rolling windows, Latest, Ratios and Dashboard all rebuilt; both cursors cleared');
  } else {
    log_('finalizeNow: paused mid-stage — run finalizeNow() again');
  }
}

