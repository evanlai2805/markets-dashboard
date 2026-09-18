/**
 * Live.gs — live quote layer for Markets Brief Data (v4, 10 Sep 2026)
 * ===================================================================
 * ADD-ON. Add as a new script file: Apps Script → Files → + → Script → name it "Live".
 * Nothing here duplicates a name in Code.gs or Dashboard.gs.
 *
 * WHAT CHANGED IN v4
 *   1. 12 instruments -> 35, grouped FX majors / FX Asia / rates / equity / commodities /
 *      crypto. EUR_USD was not in the old list at all, which for an FX desk is the first
 *      thing you look for. DXY is derived from the live basket using the same weights
 *      Code.gs uses for the daily column, so the live number and the settled number are
 *      the same index rather than two approximations.
 *
 *   2. THE REFERENCE CLOSE WAS WRONG. v3 compared a live mid to whatever the Latest tab
 *      held, which for Brent on 10 Sep was a FRED close from 1 Sep — so the sheet reported
 *      "+10.08%" for what was a normal day. Every percentage on the tab was measuring a
 *      different length of time depending on how far behind that series' source was.
 *      Now the reference is OANDA's OWN previous completed daily candle for the same
 *      instrument, on the same NY 17:00 alignment fetchOanda_ uses. Like for like.
 *
 *   3. The previous session's close does not move during the session, so it is fetched
 *      once an hour, not every 10 minutes, and cached in Script Properties.
 *      UrlFetchApp.fetchAll() sends the 36 candle requests in parallel — ~1-2s rather than
 *      ~7s sequential, so the 10-minute heartbeat stays where it was.
 *      Consequence, and it is deliberate: there is no day high/low or day-range position on
 *      this tab. Those move all session, so they cannot come from an hourly cache, and
 *      fetching them fresh every 10 minutes is 5,184 URL calls a day — a quarter of the
 *      daily quota for a number you can read off the chart. day_open is cached safely
 *      (an open does not change once set) and from_open covers the same ground.
 *      v3's close_age_days column is gone with it: the reference is now always the previous
 *      session, so prev_close_date IS the age and a separate staleness marker says nothing.
 *
 *   4. LOG NOISE. refreshLive wrote a line every 10 minutes: 144 rows a day. On 10 Sep the
 *      last 70 rows of the Log tab were all live-quote noise and the dailyUpdate lines that
 *      explained the real failure were hundreds of rows further up. It now logs only when
 *      the outcome CHANGES, or on failure.
 *
 * DESIGN — why a separate tab rather than writing into MacroHistory
 *   MacroHistory is one row per day, completed candles only. A live mid is an intraday
 *   observation of a day that has not closed. Writing it there would corrupt every chart,
 *   every moving average and every "previous close" the brief computes, and tomorrow's
 *   FRED pull would silently overwrite it anyway. So live quotes live in their own tab,
 *   are overwritten on each refresh, and are never merged into the history.
 *
 * WHY onOpen HAS TO BE AN INSTALLABLE TRIGGER
 *   A simple onOpen() runs unauthorized and cannot call UrlFetchApp, so it can't reach
 *   OANDA. installLiveTriggers() creates an INSTALLABLE open trigger, which runs with full
 *   authorization and can fetch. The simple onOpen() below only builds the menu.
 *   Caveats: an installable open trigger fires only for the account that installed it,
 *   does not fire in the Sheets mobile app, and lands 1-3 seconds after the sheet opens.
 *
 * SETUP
 *   1. Paste this file, save.
 *   2. Run  refreshLive()  once and authorise.
 *   3. Run  installLiveTriggers()  once — on-open plus every 10 minutes.
 *   4. Reload the sheet. The Live tab fills, and a live strip appears on the Dashboard
 *      at N1:U6, above the charts.
 *   If any row says "no quote returned", run probeLiveInstruments() — not every instrument
 *   is offered on every OANDA entity.
 */

const LIVE_TAB = 'Live';
const LIVE_DASH_ROW = 1, LIVE_DASH_COL = 14;   // N1 — dashRender_ only clears A:M, charts start row 7
const LIVE_ROWS_PER_GROUP = 4;   // 12 strip items / 4 = 3 groups on rows 2-5; charts start at row 7

// The board. [group, OANDA instrument, label, short, MacroHistory series_id, decimals]
//   group       — section heading on the Live tab
//   short       — used on the Dashboard strip, where columns are only 72px
//   series_id   — joins to a Dashboard panel row via liveWritePanelCols_. Blank means the
//                 instrument has no daily counterpart in MacroHistory; it still shows here.
// All 35 confirmed present on account 101-XXX-XXXXXXXX-XXX (probeOanda, 127 instruments).
const LIVE_INSTRUMENTS = [
  ['FX majors',   'EUR_USD',    'EURUSD',            'EURUSD', 'DEXUSEU', 4],
  ['FX majors',   'GBP_USD',    'GBPUSD',            'GBPUSD', 'DEXUSUK', 4],
  ['FX majors',   'USD_JPY',    'USDJPY',            'USDJPY', 'DEXJPUS', 3],
  ['FX majors',   'USD_CHF',    'USDCHF',            'USDCHF', 'DEXSZUS', 4],
  ['FX majors',   'AUD_USD',    'AUDUSD',            'AUDUSD', 'DEXUSAL', 4],
  ['FX majors',   'NZD_USD',    'NZDUSD',            'NZDUSD', '',        4],
  ['FX majors',   'USD_CAD',    'USDCAD',            'USDCAD', 'DEXCAUS', 4],
  ['FX Asia',     'USD_SGD',    'USDSGD',            'USDSGD', 'DEXSIUS', 4],
  ['FX Asia',     'USD_CNH',    'USDCNH',            'USDCNH', 'DEXCHUS', 4],
  ['FX Asia',     'USD_HKD',    'USDHKD',            'USDHKD', '',        4],
  ['FX Asia',     'EUR_SGD',    'EURSGD',            'EURSGD', '',        4],
  ['FX Asia',     'GBP_SGD',    'GBPSGD',            'GBPSGD', '',        4],
  ['Rates',       'USB02Y_USD', 'US 2y future',      'US2y',   '',        3],
  ['Rates',       'USB05Y_USD', 'US 5y future',      'US5y',   '',        3],
  ['Rates',       'USB10Y_USD', 'US 10y future',     'US10y',  '',        3],
  ['Rates',       'USB30Y_USD', 'US 30y future',     'US30y',  '',        3],
  ['Rates',       'DE10YB_EUR', 'Bund future',       'Bund',   '',        3],
  ['Rates',       'UK10YB_GBP', 'Gilt future',       'Gilt',   '',        3],
  ['Equity',      'SPX500_USD', 'S&P 500',           'S&P',    '',        1],
  ['Equity',      'NAS100_USD', 'Nasdaq 100',        'Nasdaq', '',        1],
  ['Equity',      'US2000_USD', 'Russell 2000',      'Russell','',        1],
  ['Equity',      'DE30_EUR',   'DAX',               'DAX',    '',        1],
  ['Equity',      'UK100_GBP',  'FTSE 100',          'FTSE',   '',        1],
  ['Equity',      'JP225_USD',  'Nikkei 225',        'Nikkei', '',        1],
  ['Equity',      'HK33_HKD',   'Hang Seng',         'HSI',    '',        1],
  ['Equity',      'SG30_SGD',   'STI (CFD)',         'STI',    'STI',     2],
  ['Commodities', 'XAU_USD',    'Gold $/oz',         'Gold',   'GOLD',    2],
  ['Commodities', 'XAG_USD',    'Silver $/oz',       'Silver', '',        3],
  ['Commodities', 'XAU_XAG',    'Gold/Silver ratio', 'XAUXAG', '',        2],
  ['Commodities', 'XCU_USD',    'Copper $/lb',       'Copper', 'COPPER',  4],
  ['Commodities', 'BCO_USD',    'Brent $/bbl',       'Brent',  'DCOILBRENTEU', 2],
  ['Commodities', 'WTICO_USD',  'WTI $/bbl',         'WTI',    'DCOILWTICO',   2],
  ['Commodities', 'NATGAS_USD', 'Nat gas $/MMBtu',   'NatGas', '',        3],
  ['Crypto',      'BTC_USD',    'Bitcoin',           'BTC',    'BTCUSD',  0],
  ['Crypto',      'ETH_USD',    'Ether',             'ETH',    'ETHUSD',  1],
];

// Quoted but not shown as its own row: the sixth leg of the dollar basket. Without it the
// live DXY cannot be computed, and a five-leg dollar index is not a dollar index.
const LIVE_EXTRA_INSTRUMENTS = ['USD_SEK'];

// The Dashboard strip is 12 items in three groups of four — the board is the Live tab.
// Matched on `short`, plus the derived DXY.
const LIVE_STRIP = ['EURUSD','USDJPY','GBPUSD','USDSGD','USDCNH','DXY',
                    'S&P','Nasdaq','US10y','Gold','Brent','BTC'];

const LIVE_GROUP_ORDER = ['FX majors','FX Asia','Rates','Equity','Commodities','Crypto'];
const LIVE_REF_CACHE_KEY = 'LIVE_REF_CACHE';
const LIVE_LOG_KEY       = 'LIVE_LAST_LOG';

// Menu only. A simple onOpen runs unauthorized, so it must not fetch anything.
function onOpen(){
  SpreadsheetApp.getUi().createMenu('Markets')
    .addItem('Refresh live quotes', 'refreshLive')
    .addItem('Rebuild dashboard',   'refreshDashboard')
    .addSeparator()
    .addItem('Fetch latest daily data', 'catchUp')
    .addItem('Rebuild everything downstream', 'finalizeNow')
    .addItem('Check data freshness',    'healthCheck')
    .addSeparator()
    .addItem('Rebuild ratios tab (GOOGLEFINANCE)', 'rebuildRatios')
    .addToUi();
}

// v4: log only when the outcome changes, or on failure. A steady state writes one line and
// then stays quiet, instead of 144 identical rows a day burying everything else in the tab.
function liveLog_(msg, force){
  try{
    const props = PropertiesService.getScriptProperties();
    if(!force && props.getProperty(LIVE_LOG_KEY) === msg) return;
    props.setProperty(LIVE_LOG_KEY, msg);
  }catch(e){ /* fall through and log anyway */ }
  log_(msg);
}

function liveAccount_(){
  let acct = getCfg_('OANDA_ACCOUNT_ID','');
  if(acct) return acct;
  const a = fetchJson_(oandaBase_() + '/v3/accounts', oandaHeaders_());
  const ids = (a.accounts || []).map(x => x.id);
  if(!ids.length) throw new Error('no OANDA account available');
  setCfg_('OANDA_ACCOUNT_ID', ids[0]);
  return ids[0];
}

// --- v4 FIX 2 + 3: the previous completed daily candle, per instrument, from OANDA itself.
// This is the number a live mid should be measured against. The old code used the Latest
// tab, whose Brent close was 9 days old — so "+10.08%" was a nine-day move being read as a
// daily one. Cached hourly: a settled close does not change during the session.
function liveRefCloses_(instruments){
  const props = PropertiesService.getScriptProperties();
  const stamp = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH');
  try{
    const raw = props.getProperty(LIVE_REF_CACHE_KEY);
    if(raw){ const c = JSON.parse(raw); if(c && c.stamp === stamp && c.data) return c.data; }
  }catch(e){ /* corrupt cache — refetch */ }

  const base = oandaBase_(), headers = oandaHeaders_();
  const reqs = instruments.map(inst => ({
    url: base + '/v3/instruments/' + encodeURIComponent(inst) +
         '/candles?granularity=D&price=M&count=2' +
         '&alignmentTimezone=' + encodeURIComponent('America/New_York') + '&dailyAlignment=17',
    headers: headers, muteHttpExceptions: true
  }));

  let res;
  try{ res = UrlFetchApp.fetchAll(reqs); }
  catch(e){ diag_('refreshLive','reference closes','ERROR','fetchAll: ' + e.message); return {}; }

  const data = {};
  res.forEach((r, i) => {
    if(r.getResponseCode() >= 400) return;
    let js; try{ js = JSON.parse(r.getContentText()); }catch(e){ return; }
    // count=2 returns the previous COMPLETE candle plus the one still forming. Only the
    // complete one is a close; the forming one is today, which is what we are measuring.
    const done = (js.candles || []).filter(c => c.complete && c.mid);
    if(!done.length) return;
    const last = done[done.length - 1];
    const c = parseFloat(last.mid.c);
    if(!isFinite(c)) return;
    // same +12h shift fetchOanda_ applies, so the stamped date matches MacroHistory's
    const t = Date.parse(last.time);
    const d = new Date(t + 12 * 3600000); d.setUTCHours(0, 0, 0, 0);
    // Today's open comes from the candle still forming. If there isn't one the session has
    // not started, so there is no open — leave it blank. Falling back to the previous
    // candle's open would silently measure today's mid against YESTERDAY's open, which is
    // the same class of mistake as the stale Brent reference this release exists to fix.
    const forming = (js.candles || []).filter(x => !x.complete && x.mid);
    const dayOpen = forming.length ? parseFloat(forming[forming.length - 1].mid.o) : NaN;
    data[instruments[i]] = { c: c, d: ymd_(d), o: isFinite(dayOpen) ? dayOpen : '' };
  });
  try{ props.setProperty(LIVE_REF_CACHE_KEY, JSON.stringify({ stamp: stamp, data: data })); }catch(e){}
  return data;
}

function refreshLive(){
  const t0 = Date.now();
  const acct    = liveAccount_();
  const headers = oandaHeaders_(), base = oandaBase_();

  const quoted = LIVE_INSTRUMENTS.map(r => r[1]).concat(LIVE_EXTRA_INSTRUMENTS);
  // v4: chunked. v3 asked for 12 instruments in one URL; this asks for 36, and some OANDA
  // entities cap the pricing endpoint per request. A rejected call would blank the whole
  // tab, so ask in batches of 15 — three round trips instead of one, still under a second.
  const byInst = {};
  for(let i = 0; i < quoted.length; i += 15){
    const batch = quoted.slice(i, i + 15);
    const js = fetchJson_(base + '/v3/accounts/' + encodeURIComponent(acct) +
                          '/pricing?instruments=' + encodeURIComponent(batch.join(',')), headers);
    (js.prices || []).forEach(p => { byInst[p.instrument] = p; });
  }

  const midOf = inst => {
    const p = byInst[inst]; if(!p) return null;
    const bid = parseFloat((p.bids && p.bids[0] && p.bids[0].price) || p.closeoutBid);
    const ask = parseFloat((p.asks && p.asks[0] && p.asks[0].price) || p.closeoutAsk);
    return (isFinite(bid) && isFinite(ask)) ? (bid + ask) / 2 : null;
  };

  const refs = liveRefCloses_(quoted);
  const now  = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  const rows = [];

  LIVE_INSTRUMENTS.forEach(([group, inst, label, short, seriesId, dec]) => {
    const p = byInst[inst];
    if(!p){
      rows.push([group, label, '', '', '', '', '', '', '', '', '', 'no quote returned — run probeLiveInstruments()', '', inst, seriesId, short, dec]);
      return;
    }
    const bid = parseFloat((p.bids && p.bids[0] && p.bids[0].price) || p.closeoutBid);
    const ask = parseFloat((p.asks && p.asks[0] && p.asks[0].price) || p.closeoutAsk);
    const mid = (isFinite(bid) && isFinite(ask)) ? (bid + ask) / 2 : '';
    const qt  = p.time ? Utilities.formatDate(new Date(Date.parse(p.time)), TZ, 'yyyy-MM-dd HH:mm:ss') : '';
    const ref = refs[inst] || null;
    const prev    = ref && isNum(ref.c) ? ref.c : '';
    const dayOpen = ref && isNum(ref.o) ? ref.o : '';
    const pct     = (isNum(mid) && isNum(prev) && prev !== 0) ? (mid / prev - 1) : '';
    const fromOpen= (isNum(mid) && isNum(dayOpen) && dayOpen !== 0) ? (mid / dayOpen - 1) : '';
    const spread  = (isNum(mid) && isFinite(bid) && isFinite(ask) && mid !== 0) ? (ask - bid) / mid * 10000 : '';
    rows.push([group, label, mid, pct, prev, ref ? ref.d : '', dayOpen, fromOpen, bid, ask, spread,
               (p.tradeable === false ? 'market closed' : 'tradeable'), qt, inst, seriesId, short, dec]);
  });

  // --- derived: the live dollar index, same weights and constant as COMPUTED.DXY in Code.gs.
  const dxyMid  = dxyCompute_(i => midOf(DXY_BASKET[i][1]));
  const dxyPrev = dxyCompute_(i => { const r = refs[DXY_BASKET[i][1]]; return r ? r.c : null; });
  const dxyOpen = dxyCompute_(i => { const r = refs[DXY_BASKET[i][1]]; return r ? r.o : null; });
  const dxyRef  = refs[DXY_BASKET[0][1]];
  rows.push(['FX majors', 'US Dollar Index', dxyMid,
             (isNum(dxyMid) && isNum(dxyPrev) && dxyPrev !== 0) ? (dxyMid / dxyPrev - 1) : '',
             dxyPrev, dxyRef ? dxyRef.d : '', dxyOpen,
             (isNum(dxyMid) && isNum(dxyOpen) && dxyOpen !== 0) ? (dxyMid / dxyOpen - 1) : '',
             '', '', '', isNum(dxyMid) ? 'derived from the 6-leg basket' : 'basket incomplete',
             now, '(computed)', 'DXY', 'DXY', 3]);

  liveWriteTab_(rows, now);

  // The Live tab is written by this point. Never let a formatting error on the Dashboard
  // strip abort the run and make it look as if nothing happened.
  let stripNote = 'strip ok';
  try{ liveWriteDashStrip_(rows, now); liveWritePanelCols_(); }
  catch(e){ stripNote = 'STRIP FAILED: ' + e.message;
            diag_('refreshLive','dashboard strip','ERROR', e.message + ' | ' + (e.stack||'').slice(0,500)); }

  const got = rows.filter(r => isNum(r[2])).length;
  const noRef = rows.filter(r => isNum(r[2]) && !isNum(r[4])).length;
  liveLog_('refreshLive: ' + got + '/' + rows.length + ' quotes' +
           (noRef ? ', ' + noRef + ' without a reference close' : '') + ' — ' + stripNote,
           stripNote !== 'strip ok');
  return got + '/' + rows.length + ' in ' + Math.round((Date.now()-t0)/1000) + 's';
}

// ---------------------------------------------------------------- the Live tab
const LIVE_HEAD = ['group','label','mid','chg_vs_prev','prev_close','prev_close_date','day_open',
                   'from_open','bid','ask','spread_bp','status','quote_time_sgt','instrument',
                   'series_id','short','dec'];
function liveWriteTab_(rows, now){
  const sh = ss_().getSheetByName(LIVE_TAB) || ss_().insertSheet(LIVE_TAB);
  sh.clear();

  // group the rows, in a desk's reading order rather than the order they were fetched
  const byGroup = {}; rows.forEach(r => { (byGroup[r[0]] = byGroup[r[0]] || []).push(r); });
  const out = [LIVE_HEAD]; const groupRows = [], dataRows = [];
  LIVE_GROUP_ORDER.forEach(g => {
    const items = byGroup[g]; if(!items || !items.length) return;
    out.push([g, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
    groupRows.push(out.length);
    items.forEach(it => { out.push(it); dataRows.push({ row: out.length, dec: it[16] }); });
  });

  sh.getRange(1, 1, out.length, LIVE_HEAD.length).setValues(out);
  sh.getRange(1, 1, 1, LIVE_HEAD.length).setFontWeight('bold').setBackground(DC.head).setFontColor(DC.amber);
  sh.setFrozenRows(1); sh.setFrozenColumns(2);

  // one setNumberFormats call for the whole block — per-cell formatting is what made
  // dashRender_ take 172 seconds, and this runs every 10 minutes.
  const fmts = out.map(() => LIVE_HEAD.map(() => 'General'));
  dataRows.forEach(({row, dec}) => {
    const d = Math.max(0, Math.min(6, isNum(dec) ? dec : 4));
    const num = d === 0 ? '#,##0' : '#,##0.' + '0'.repeat(d);
    fmts[row-1][2] = num;                                   // mid
    fmts[row-1][3] = '+0.00%;-0.00%;0.00%';                 // chg vs prev close
    fmts[row-1][4] = num;                                   // prev close
    fmts[row-1][6] = num;                                   // day open
    fmts[row-1][7] = '+0.00%;-0.00%;0.00%';                 // from open
    fmts[row-1][8] = num; fmts[row-1][9] = num;             // bid / ask
    fmts[row-1][10] = '0.0';                                // spread bp
    // v4.2: these two were left on 'General' and rendered as raw serials — prev_close_date
    // showed 46276 and quote_time_sgt 46279.4674653. sh.clear() wipes the auto-format Sheets
    // applies when it parses the ymd_() text, and then this setNumberFormats call overwrites
    // it with General. Any column holding a date has to be named here.
    fmts[row-1][5]  = 'yyyy-mm-dd';                         // prev close date
    fmts[row-1][12] = 'yyyy-mm-dd hh:mm:ss';                // quote time (SGT)
  });
  sh.getRange(1, 1, out.length, LIVE_HEAD.length).setNumberFormats(fmts);

  groupRows.forEach(r => sh.getRange(r, 1, 1, LIVE_HEAD.length)
    .setBackground(DC.panel).setFontWeight('bold').setFontColor(DC.ink2));
  sh.getRange(2, 3, out.length-1, 9).setFontFamily(DASH_FONT_NUM).setHorizontalAlignment('right');

  sh.getRange(1, LIVE_HEAD.length + 2).setValue('refreshed_at');
  sh.getRange(2, LIVE_HEAD.length + 2).setValue(now);
  sh.getRange(3, LIVE_HEAD.length + 2)
    .setValue('Rates rows are bond FUTURES prices — price up means yield down. ' +
              'chg_vs_prev is against OANDA’s own previous daily close (NY 17:00), not a FRED close.');

  [140, 150, 96, 84, 96, 96, 96, 84, 90, 90, 72, 130, 140, 96, 96, 72, 40]
    .forEach((w, i) => sh.setColumnWidth(i + 1, w));
}

// Compact strip on the Dashboard at N1:U6. dashRender_ clears only columns A:M and the
// charts start at row 7, so this block is never trampled by a dashboard rebuild.
function liveWriteDashStrip_(rows, now){
  const dash = ss_().getSheetByName(DASH.tab);
  if(!dash) return;

  // pick the strip in LIVE_STRIP's order, not the board's
  const byShort = {}; rows.forEach(r => { if(r[15]) byShort[r[15]] = r; });
  const picked = LIVE_STRIP.map(s => byShort[s]).filter(Boolean);

  const nGroups = Math.ceil(picked.length / LIVE_ROWS_PER_GROUP);
  const width = Math.max(nGroups * 4, 8);
  dash.getRange(LIVE_DASH_ROW, LIVE_DASH_COL, LIVE_ROWS_PER_GROUP + 1, width).clearContent();

  const block = [];
  for(let r = 0; r < LIVE_ROWS_PER_GROUP; r++){
    const line = [];
    for(let g = 0; g < nGroups; g++){
      const item = picked[g * LIVE_ROWS_PER_GROUP + r];
      if(!item){ line.push('', '', '', ''); continue; }
      line.push(item[15] || item[1],
                isNum(item[2]) ? item[2] : '—',
                isNum(item[3]) ? item[3] : '',
                item[11] !== 'tradeable' && item[11] !== 'derived from the 6-leg basket' ? '·' : '');
    }
    block.push(line);
  }
  dash.getRange(LIVE_DASH_ROW + 1, LIVE_DASH_COL, LIVE_ROWS_PER_GROUP, nGroups * 4).setValues(block);

  // No merge(): merging a range that a dashboard rebuild has already touched is the one
  // operation here that can throw, and it buys nothing.
  dash.getRange(LIVE_DASH_ROW, LIVE_DASH_COL, 1, nGroups * 4).setBackground(DC.head);
  dash.getRange(LIVE_DASH_ROW, LIVE_DASH_COL)
      .setValue('LIVE · OANDA mid vs previous daily close · ' + now + '   (· = market closed)')
      .setFontColor(DC.amber).setFontWeight('bold').setFontSize(9);

  for(let g = 0; g < nGroups; g++){
    const c = LIVE_DASH_COL + g * 4;
    dash.getRange(LIVE_DASH_ROW + 1, c,     LIVE_ROWS_PER_GROUP, 1).setFontSize(9).setFontColor(DC.ink2);
    dash.getRange(LIVE_DASH_ROW + 1, c + 1, LIVE_ROWS_PER_GROUP, 1)
        .setFontFamily(DASH_FONT_NUM).setFontWeight('bold').setHorizontalAlignment('right')
        .setNumberFormat('#,##0.0000');
    dash.getRange(LIVE_DASH_ROW + 1, c + 2, LIVE_ROWS_PER_GROUP, 1)
        .setFontFamily(DASH_FONT_NUM).setHorizontalAlignment('right')
        .setNumberFormat('+0.0%;-0.0%;0.0%');
    dash.getRange(LIVE_DASH_ROW + 1, c + 3, LIVE_ROWS_PER_GROUP, 1)
        .setFontColor(DC.muted).setHorizontalAlignment('center');
  }
}

// On-open (installable, so it may fetch) plus a 10-minute heartbeat.
// 144 runs a day at ~3s each is a rounding error against the 90-min daily quota.
function installLiveTriggers(){
  const ss = ss_();
  ScriptApp.getProjectTriggers().forEach(t => {
    if(t.getHandlerFunction() === 'refreshLive') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('refreshLive').forSpreadsheet(ss).onOpen().create();
  ScriptApp.newTrigger('refreshLive').timeBased().everyMinutes(10).create();
  log_('installLiveTriggers: refreshLive on sheet open + every 10 minutes');
}

// Which of LIVE_INSTRUMENTS your OANDA entity actually prices. Run once if a row shows
// "no quote returned" — some instruments are not offered on every entity.
function probeLiveInstruments(){
  const js = fetchJson_(oandaBase_() + '/v3/accounts/' + liveAccount_() + '/instruments', oandaHeaders_());
  const names = (js.instruments || []).map(i => i.name);
  const want = LIVE_INSTRUMENTS.map(r => r[1]).concat(LIVE_EXTRA_INSTRUMENTS);
  const have = want.filter(w => names.indexOf(w) >= 0);
  const miss = want.filter(w => names.indexOf(w) < 0);
  diag_('probeLiveInstruments', 'coverage', miss.length ? 'WARN' : 'OK',
        'HAVE: ' + have.join(', ') + ' || MISSING: ' + (miss.join(', ') || 'none'));
  liveLog_('probeLiveInstruments: ' + have.length + '/' + want.length +
           ' priced. Remove any MISSING row from LIVE_INSTRUMENTS. See Diagnostics.', true);
}

// Force the cached reference closes to be refetched on the next refreshLive().
function resetLiveRefCache(){
  PropertiesService.getScriptProperties().deleteProperty(LIVE_REF_CACHE_KEY);
  liveLog_('resetLiveRefCache: cleared — the next refreshLive() will refetch every previous close', true);
}

// ---------------------------------------------------------------- panel columns K and L
// Live mid in K, move vs the previous daily close in L, on the same row as each metric.
// Called from refreshLive() AND from the end of dashRender_ (one guarded line in
// Dashboard.gs), so a dashboard rebuild repopulates them instead of blanking them.
//
// Joins on series_id via the Live tab, so it needs nothing from Dashboard.gs but DASH_PANELS
// and DC. Rows are located by matching the metric label in column B — no dependence on
// dashRender_'s row arithmetic, so it survives changes to the panel list.
function liveWritePanelCols_(){
  const dash = ss_().getSheetByName(DASH.tab);
  const live = ss_().getSheetByName(LIVE_TAB);
  if(!dash || !live || live.getLastRow() < 2) return;

  const lv = live.getRange(2, 1, live.getLastRow() - 1, LIVE_HEAD.length).getValues();
  const bySeries = {};
  lv.forEach(r => {
    const sid = String(r[14] || '').trim();
    if(sid) bySeries[sid] = { mid: r[2], pct: r[3], ok: r[11] === 'tradeable' };
  });

  const bySeriesLabel = {}, panelTitles = {};
  DASH_PANELS.forEach(g => {
    panelTitles[g[0]] = true;
    g[1].forEach(it => { bySeriesLabel[it[1]] = it[0]; });
  });

  const lastRow = dash.getLastRow();
  if(lastRow < 8) return;
  const colB = dash.getRange(1, 2, lastRow, 1).getValues();

  // Stop before the rotation block — it uses K and L for the >50d / >200d arrows.
  let endRow = lastRow;
  for(let i = 0; i < lastRow; i++){
    if(String(colB[i][0] || '').indexOf('ROTATION') === 0){ endRow = i; break; }
  }
  if(endRow < 8) return;

  const vals = [], fmts = [], colours = [], backs = [];
  for(let i = 0; i < endRow; i++){
    // v4: a stale panel row carries its date in column B ("UST 10y · 4 Sep"), so match on
    // the part before the separator or every stale row would lose its live columns.
    const lab = String(colB[i][0] || '').split(' · ')[0].trim();

    if(lab === 'Metric'){                                   // panel header row
      vals.push(['Live', 'vs close']);
      fmts.push(['@', '@']);
      colours.push([DC.muted, DC.muted]);
      backs.push([DC.surface, DC.surface]);
      continue;
    }
    if(panelTitles[lab]){                                   // panel title bar — carry the fill across
      vals.push(['', '']);
      fmts.push(['General', 'General']);
      colours.push([DC.amber, DC.amber]);
      backs.push([DC.head, DC.head]);
      continue;
    }

    const sid = bySeriesLabel[lab];
    const d = sid ? bySeries[sid] : null;
    if(d && isNum(d.mid)){
      vals.push([d.mid, isNum(d.pct) ? d.pct : '']);
      fmts.push([Math.abs(d.mid) >= 1000 ? '#,##0' : '#,##0.0000', '+0.0%;-0.0%;0.0%']);
      colours.push([d.ok ? DC.ink : DC.muted,
                    !isNum(d.pct) ? DC.muted : (d.pct > 0 ? DC.up : (d.pct < 0 ? DC.down : DC.muted))]);
    } else {
      vals.push(['', '']);
      fmts.push(['General', 'General']);
      colours.push([DC.ink, DC.ink]);
    }
    backs.push([DC.surface, DC.surface]);
  }

  const rng = dash.getRange(1, 11, endRow, 2);
  rng.setValues(vals).setNumberFormats(fmts).setFontColors(colours).setBackgrounds(backs);
  rng.setFontFamily(DASH_FONT_NUM).setFontSize(9).setHorizontalAlignment('right');
  dash.setColumnWidth(11, 84);
  dash.setColumnWidth(12, 68);
}
