/**
 * Dashboard.gs — Markets Brief Data (v5, 18 Sep 2026)
 * ====================================================
 * v5: the Sheet is public and a static web page (docs/index.html) reads DashStats, DashSeries,
 * Live, RatiosLatest, Notes, Meta and Series through the gviz CSV endpoint. The Sheet's own
 * Dashboard tab is FROZEN — nothing new is added to it — and the contract it depends on is
 * immutable:
 *     DashStats A:P and Q:BX (s1..s60), rows 2..(1+panel rows) in DASH_PANELS order; CA:CD helper
 *     DashSeries A:I
 * Everything the page needs beyond that is an EXTENSION: DashStats rows after the panel rows
 * (panel = "PAGE:<group>", from PAGE_EXTRA) and columns from DASH_EXT_COL onward; DashSeries
 * columns 10+ (DASH_SERIES_EXTRA). selfTest() in Code.gs asserts all of this.
 * The IBKR Log / Runs ingest that used to live here is gone: personal positions never touch
 * a public workbook.
 *
 * Adds to the Markets Brief Data sheet:
 *
 *   1. DASHBOARD  — a Bloomberg-density "at a glance" first tab built from the data already in the
 *      sheet (MacroData (2Y) / MacroHistory, RatiosLatest, Ratios). Light theme, terminal semantics
 *      (green up / red down / amber accents) tuned for legibility.
 *        • headline strip: nine tiles (10y, 2s10s, HY OAS, VIX, DXY, USDSGD, SORA 3M, gold, BTC)
 *        • six panels: US rates & curve · Fed policy & liquidity · credit & risk ·
 *          Singapore rates & SGD · commodities, FX & crypto · US macro prints
 *          columns: last · Δprev · 1W · 1M · YTD · 1Y %ile · 52w range bar · 60-obs sparkline
 *        • six charts (1Y): UST 10y + 2s10s · HY OAS vs VIX · net liquidity · 3M SORA vs Fed funds ·
 *          USDSGD · ranked rotation bars driven by a timeframe selector (1D/5D/20D/60D/YTD)
 *        • full-size rotation heatmap: all 38 ETF/SPY ratios in Evan's eight groups
 *
 * SETUP: deployed with clasp alongside Code.gs (this file uses its helpers). Run buildDashboard() once.
 *        dailyUpdate() calls refreshDashboard() automatically.
 *
 * Helper tabs (kept VISIBLE, parked last, grey — charts cannot read hidden sheets):
 *   DashStats (per-row stats + 60-obs spark data + ranked-rotation helper), DashSeries (1Y chart data).
 */

// ---------------------------------------------------------------- config
const DASH = { tab:'Dashboard', stats:'DashStats', series:'DashSeries' };
const DASH_SPARK_N = 60;
const DASH_TF = ['1D','5D','20D','60D','YTD'];          // rotation selector options (RatiosLatest cols E..I)
const DC = {                                             // palette — light surface, terminal semantics
  ink:'#0b0b0b', ink2:'#52514e', muted:'#898781', grid:'#e1e0d9', surface:'#ffffff', panel:'#f7f7f4',
  head:'#1c1c1c', amber:'#f5a623', amberFill:'#fbe7bf', up:'#137a3a', down:'#c8322b',
  upFill:'#cdeed8', downFill:'#f9d3cf', blue:'#2a78d6', orange:'#eb6834', grey:'#b5b4ad'
};
const DASH_FONT_NUM = 'Roboto Mono', DASH_FONT_TXT = 'Roboto';

// Panel rows: [series_id, label, mode, decimals, scale, transform]
//   mode: 'bp' (Δ shown in basis points) | 'pct' (Δ shown as % change) | 'abs' (Δ in the value's own units)
//   scale: multiply raw values (e.g. $m → $bn); transform: 'yoy' = year-on-year % of an index
const DASH_PANELS = [
  ['US RATES & CURVE', [
    ['DGS3MO','UST 3m','bp',2], ['DGS2','UST 2y','bp',2], ['DGS5','UST 5y','bp',2], ['DGS10','UST 10y','bp',2],
    ['DGS30','UST 30y','bp',2], ['US_10Y_2Y','2s10s','bp',2], ['US_10Y_3M','3m10s','bp',2],
    ['DFII10','10y real (TIPS)','bp',2], ['T10YIE','10y breakeven','bp',2], ['T5YIFR','5y5y fwd infl.','bp',2] ]],
  ['FED POLICY & LIQUIDITY', [
    ['DFF','Fed funds effective','bp',2], ['DFEDTARU','Target range upper','bp',2], ['SOFR','SOFR','bp',2],
    ['WALCL','Fed balance sheet $bn','abs',0,0.001], ['RRPONTSYD','ON RRP $bn','abs',0], ['WTREGEN','TGA $bn','abs',0,0.001],
    ['Net_Liquidity','Net liquidity $bn','abs',0,0.001], ['M2SL','M2 $bn','pct',0] ]],
  ['CREDIT & RISK', [
    ['BAMLH0A0HYM2','HY OAS','bp',2], ['BAMLC0A0CM','IG OAS','bp',2], ['HY_IG_OAS','HY − IG','bp',2],
    ['VIXCLS','VIX','abs',1], ['NFCI','Chicago Fed NFCI','abs',2], ['ANFCI','Adjusted NFCI','abs',2] ]],
  ['SINGAPORE RATES & SGD', [
    ['SORA_ON','SORA overnight','bp',2], ['SORA_1M','1M compounded SORA','bp',2], ['SORA_3M','3M compounded SORA','bp',2],
    ['SORA_6M','6M compounded SORA','bp',2], ['SG_SF_DEPO','MAS SF deposit','bp',2], ['SG_SF_BORR','MAS SF borrow','bp',2],
    ['TBILL_6M','6M T-bill cut-off','bp',2], ['TBILL_1Y','1Y T-bill cut-off','bp',2], ['TBILL_6M_BTC','6M bid-to-cover','abs',2],
    ['SGS_2Y','SGS 2y','bp',2], ['SGS_10Y','SGS 10y','bp',2], ['DEXSIUS','USDSGD','pct',4], ['STI','STI (OANDA CFD)','pct',0] ]],
  // v4: FX split into its own panel. The six new FRED H.10 series (and the DXY they compute)
  // took the old combined panel to 17 rows, and EURUSD had no row anywhere on the board —
  // which is why there was no 1W/1M/YTD for any major.
  ['FX', [
    ['DXY','US Dollar Index','pct',2], ['DTWEXBGS','Broad USD (Fed)','pct',2],
    ['DEXUSEU','EURUSD','pct',4], ['DEXUSUK','GBPUSD','pct',4], ['DEXUSAL','AUDUSD','pct',4],
    ['DEXJPUS','USDJPY','pct',2], ['DEXSZUS','USDCHF','pct',4], ['DEXCAUS','USDCAD','pct',4],
    ['DEXCHUS','USDCNY','pct',3] ]],
  ['COMMODITIES & CRYPTO', [
    ['GOLD','Gold $/oz','pct',0], ['COPPER','Copper $/lb','pct',2], ['CopperGold','Copper/Gold ×1000','pct',3,1000],
    ['DCOILWTICO','WTI $/bbl','pct',2], ['DCOILBRENTEU','Brent $/bbl','pct',2],
    ['BTCUSD','Bitcoin','pct',0], ['ETHUSD','Ether','pct',0], ['ETH_BTC','ETH/BTC','pct',4] ]],
  ['US MACRO PRINTS', [
    ['ICSA','Initial claims (k)','abs',0,0.001], ['PAYEMS','Nonfarm payrolls (k)','abs',0], ['UNRATE','Unemployment %','abs',1],
    ['CPIAUCSL','CPI YoY %','abs',1,1,'yoy'], ['PCEPILFE','Core PCE YoY %','abs',1,1,'yoy'] ]]
];
// Headline tiles (ids must appear in DASH_PANELS)
// v4: the "Broad USD" tile becomes DXY now that there is a real one. DTWEXBGS keeps its
// panel row — it is the better index, but DXY is the number quoted at you all day.
const DASH_TILES = [['DGS10','UST 10y'],['US_10Y_2Y','2s10s'],['BAMLH0A0HYM2','HY OAS'],['VIXCLS','VIX'],['DXY','DXY'],
                    ['DEXSIUS','USDSGD'],['SORA_3M','SORA 3M'],['GOLD','Gold'],['BTCUSD','Bitcoin']];
// Chart data columns written to DashSeries (1Y, forward-filled): [column header, series_id, scale]
const DASH_SERIES = [
  ['UST 10y','DGS10',1], ['2s10s','US_10Y_2Y',1], ['HY OAS','BAMLH0A0HYM2',1], ['VIX','VIXCLS',1],
  ['Net liquidity $bn','Net_Liquidity',0.001], ['3M SORA','SORA_3M',1], ['Fed funds','DFF',1], ['USDSGD','DEXSIUS',1]
];

// ---------------------------------------------------------------- v5: page extension zone
// DashStats extension columns start here (CE). Columns BY:BZ are left blank and CA:CD stays the
// rotation helper, so nothing in dashRender_ moves.
const DASH_EXT_COL = 83;
const DASH_EXT_HEADER = ['v1m','v1y','pct3y','cadence','status'];
// Page-only rows, appended AFTER the DASH_PANELS rows. [series_id, label, group, mode, decimals, scale, transform]
// group is the page's grouping key; the Sheet tab never reads these rows.
const PAGE_EXTRA = [
  // US par + real curve (tenors not on the Sheet tab)
  ['DGS1MO','UST 1m','rates','bp',2], ['DGS6MO','UST 6m','rates','bp',2], ['DGS1','UST 1y','rates','bp',2],
  ['DGS3','UST 3y','rates','bp',2], ['DGS7','UST 7y','rates','bp',2], ['DGS20','UST 20y','rates','bp',2],
  ['DFII5','5y real (TIPS)','inflation','bp',2], ['DFII7','7y real (TIPS)','inflation','bp',2],
  ['DFII20','20y real (TIPS)','inflation','bp',2], ['DFII30','30y real (TIPS)','inflation','bp',2],
  ['T5YIE','5y breakeven','inflation','bp',2], ['BE_5Y','5y BE (calc)','inflation','bp',2],
  ['BE_10Y_CALC','10y BE (calc)','inflation','bp',2], ['BE_30Y','30y BE (calc)','inflation','bp',2],
  // curve spreads
  ['US_5Y_30Y','5s30s','rates','bp',2], ['US_10Y_30Y','10s30s','rates','bp',2],
  ['US_2Y_30Y','2s30s','rates','bp',2], ['US_20Y_30Y','20s30s','rates','bp',2],
  // policy
  ['DFEDTARL','Target range lower','policy','bp',2],
  ['POLICY_PROXY_6M','Policy proxy 6m − funds','policy','bp',2], ['POLICY_PROXY_1Y','Policy proxy 1y − funds','policy','bp',2],
  // credit ladder
  ['BAMLC0A1CAAA','AAA OAS','credit','bp',2], ['BAMLC0A2CAA','AA OAS','credit','bp',2], ['BAMLC0A3CA','A OAS','credit','bp',2],
  ['BAMLC0A4CBBB','BBB OAS','credit','bp',2], ['BAMLC1A0C13Y','IG 1-3y OAS','credit','bp',2],
  ['BAMLH0A1HYBB','BB OAS','credit','bp',2], ['BAMLH0A2HYB','B OAS','credit','bp',2], ['BAMLH0A3HYC','CCC & lower OAS','credit','bp',2],
  ['BAMLHE00EHYIOAS','Euro HY OAS','credit','bp',2], ['BAMLEMCBPIOAS','EM corp OAS','credit','bp',2],
  ['BAMLH0A0HYM2EY','HY effective yield','credit','bp',2], ['BAMLC0A0CMEY','IG effective yield','credit','bp',2],
  // global govies (monthly OECD) + spreads to US
  ['G10Y_US','US 10y (OECD)','global','bp',2], ['G10Y_DE','Germany 10y','global','bp',2], ['G10Y_GB','UK 10y','global','bp',2],
  ['G10Y_JP','Japan 10y','global','bp',2], ['G10Y_AU','Australia 10y','global','bp',2], ['G10Y_CA','Canada 10y','global','bp',2],
  ['G10Y_IT','Italy 10y','global','bp',2], ['G10Y_FR','France 10y','global','bp',2], ['G10Y_CH','Switzerland 10y','global','bp',2],
  ['G10Y_ZA','South Africa 10y','global','bp',2],
  ['G10Y_DE_US','Bund − UST','global','bp',2], ['G10Y_GB_US','Gilt − UST','global','bp',2], ['G10Y_JP_US','JGB − UST','global','bp',2],
  ['G10Y_AU_US','ACGB − UST','global','bp',2], ['G10Y_CA_US','Canada − UST','global','bp',2], ['G10Y_IT_US','BTP − UST','global','bp',2],
  ['G10Y_FR_US','OAT − UST','global','bp',2], ['G10Y_CH_US','Swiss − UST','global','bp',2], ['G10Y_ZA_US','SAGB − UST','global','bp',2],
  // macro
  ['CPILFESL','Core CPI YoY %','macro','abs',1,1,'yoy'],
  // fx / sg extras
  ['DEXSDUS','USDSEK','fx','pct',4], ['USDSGD_OANDA','USDSGD (OANDA)','fx','pct',4],
  ['SORA_INDEX','SORA index','sg','pct',4], ['SORA_VOL','SORA volume','sg','pct',0],
];
// Series ids whose 3-year percentile the page shows (credit ladder). Read from MacroData (5Y).
const PAGE_PCT3Y_IDS = ['BAMLH0A0HYM2','BAMLC0A0CM','HY_IG_OAS','BAMLC0A1CAAA','BAMLC0A2CAA','BAMLC0A3CA','BAMLC0A4CBBB','BAMLC1A0C13Y',
  'BAMLH0A1HYBB','BAMLH0A2HYB','BAMLH0A3HYC','BAMLHE00EHYIOAS','BAMLEMCBPIOAS','VIXCLS','DGS10','DFII10','T10YIE','US_10Y_2Y'];
// DashSeries columns 10+ (1Y, forward-filled). [header, series_id, scale]
const DASH_SERIES_EXTRA = [
  ['UST 2y','DGS2',1], ['UST 5y','DGS5',1], ['UST 30y','DGS30',1], ['5y real','DFII5',1], ['10y real','DFII10',1], ['30y real','DFII30',1],
  ['5y BE','T5YIE',1], ['10y BE','T10YIE',1], ['5s30s','US_5Y_30Y',1], ['10s30s','US_10Y_30Y',1],
  ['IG OAS','BAMLC0A0CM',1], ['BBB OAS','BAMLC0A4CBBB',1], ['BB OAS','BAMLH0A1HYBB',1], ['CCC OAS','BAMLH0A3HYC',1],
  ['DXY','DXY',1], ['Target upper','DFEDTARU',1], ['Fed balance sheet $bn','WALCL',0.001], ['Gold','GOLD',1], ['Bitcoin','BTCUSD',1],
  ['WTI','DCOILWTICO',1], ['Copper/Gold x1000','CopperGold',1000], ['SGS 10y','SGS_10Y',1], ['6M T-bill','TBILL_6M',1], ['STI','STI',1],
  ['USDJPY','DEXJPUS',1], ['EURUSD','DEXUSEU',1], ['Policy proxy 6m','POLICY_PROXY_6M',1],
  ['G10Y US','G10Y_US',1], ['G10Y DE','G10Y_DE',1], ['G10Y GB','G10Y_GB',1], ['G10Y JP','G10Y_JP',1]
];

// ---------------------------------------------------------------- public entry points
function buildDashboard(){ dashRender_(true); log_('buildDashboard: done'); }
function refreshDashboard(){
  if(!ss_().getSheetByName(DASH.tab)) return buildDashboard();
  dashRender_(false); log_('refreshDashboard: done');
}

// ---------------------------------------------------------------- data → stats
function dashLoadHistory_(tabName){
  let sh = ss_().getSheetByName(tabName || 'MacroData (2Y)');
  if(!sh || sh.getLastRow() < 30) sh = sheet_(HIST);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  const cols = {};
  if(lastRow < 2) return cols;
  const vals = sh.getRange(1,1,lastRow,lastCol).getValues(); const header = vals[0];
  for(let c=1;c<lastCol;c++){ const pts=[];
    for(let r=1;r<vals.length;r++){ const d=vals[r][0], v=vals[r][c]; if(d instanceof Date && isNum(v)) pts.push([d,v]); }
    pts.sort((a,b)=>a[0]-b[0]); cols[header[c]] = pts; }
  return cols;
}
function dashIdxAtOrBefore_(pts,t){ let lo=0, hi=pts.length-1, ans=-1; while(lo<=hi){ const m=(lo+hi)>>1; if(pts[m][0]<=t){ ans=m; lo=m+1; } else hi=m-1; } return ans; }
function dashYoY_(pts){
  const out=[]; for(let i=0;i<pts.length;i++){ const t=new Date(pts[i][0].getTime()); t.setUTCFullYear(t.getUTCFullYear()-1);
    const j=dashIdxAtOrBefore_(pts,t); if(j<0||pts[j][1]===0) continue;
    if(pts[i][0]-pts[j][0] > 400*86400000) continue;                 // no obs near a year back
    out.push([pts[i][0],(pts[i][1]/pts[j][1]-1)*100]); }
  return out;
}
function dashStats_(ptsIn, mode, scale, transform){
  let pts = ptsIn || [];
  if(transform==='yoy') pts = dashYoY_(pts);
  if(scale && scale!==1) pts = pts.map(p=>[p[0],p[1]*scale]);
  const n = pts.length; if(!n) return null;
  const last = pts[n-1], prev = n>1 ? pts[n-2] : null, asof = last[0];
  const at = days => { const j=dashIdxAtOrBefore_(pts,new Date(asof.getTime()-days*86400000)); return j>=0?pts[j][1]:null; };
  const back = k => n>k ? pts[n-1-k][1] : null;                    // k observations back
  // native frequency from the median spacing of the last 12 obs: daily → calendar lookback;
  // weekly → 1W = prior print, 1M = 4 prints back; monthly/quarterly → 1W n/a, 1M = prior print
  const gaps=[]; for(let i=Math.max(1,n-12);i<n;i++) gaps.push((pts[i][0]-pts[i-1][0])/86400000); gaps.sort((a,b)=>a-b);
  const spacing = gaps.length ? gaps[Math.floor(gaps.length/2)] : 1;
  const v1w = spacing>=20 ? null : (spacing>=5 ? back(1) : at(7));
  const v1m = spacing>=20 ? back(1) : (spacing>=5 ? back(4) : at(30));
  const jy = dashIdxAtOrBefore_(pts,new Date(Date.UTC(asof.getUTCFullYear()-1,11,31))); const ytdBase = jy>=0?pts[jy][1]:null;
  const yrAgo = new Date(asof.getTime()-365*86400000); const w = pts.filter(p=>p[0]>=yrAgo).map(p=>p[1]);
  const hi = Math.max.apply(null,w), lo = Math.min.apply(null,w);
  const pct = w.filter(x=>x<=last[1]).length/w.length*100;
  const chg = old => { if(!isNum(old)) return ''; if(mode==='bp') return (last[1]-old)*100; if(mode==='pct') return old!==0?(last[1]/old-1):''; return last[1]-old; };
  // v5: the levels themselves, for the page's today / 1m / 1y comparisons
  const j1y = dashIdxAtOrBefore_(pts,new Date(asof.getTime()-365*86400000));
  const v1y = (j1y>=0 && (asof-pts[j1y][0]) <= 400*86400000) ? pts[j1y][1] : null;
  return { asof:asof, last:last[1], prev:prev?prev[1]:'', d1:chg(prev?prev[1]:null), d1w:chg(v1w), d1m:chg(v1m),
           ytd:chg(ytdBase), pct:pct, hi:hi, lo:lo, pos:(hi>lo)?(last[1]-lo)/(hi-lo):0.5, n:n,
           v1m:isNum(v1m)?v1m:'', v1y:isNum(v1y)?v1y:'',
           cadence:spacing,                                   // v4.2.1: needed by dashLate_
           spark:pts.slice(-DASH_SPARK_N).map(p=>p[1]) };
}

// --- v4.2.1: is this series past its OWN publication cadence?
// staleLimitDays_ (Code.gs) is the rule healthCheck already applies, so the board and the log
// cannot disagree about what "stale" means. They did on 14 Sep: the header said "40 of 57
// series >3d old" in the same hour healthCheck said "65 series current, 0 stale".
function dashLate_(id, s){
  if(!s || !s.asof) return false;
  const d = anyDate_(s.asof); if(!d) return false;
  const today = toDate_(Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'));
  const age = Math.round((today.getTime() - d.getTime()) / 86400000);
  return age > staleLimitDays_(id, s.cadence || 1);
}

// --- v4: how far behind the board's newest row may a row sit before it is dated and greyed?
// This is about COMPARABILITY, not health: a 4 Sep FX print next to a 14 Sep MAS rate is a
// perfectly healthy weekly release, but the two must not be read as the same day.
// The header used to print the MAX as-of across every series, so three fresh OANDA series
// made the board read "Data as of 2026-09-09" while the UST 10y tile underneath it showed a
// 4 Sep number. Anything this many days behind the freshest series carries its own date.
const DASH_STALE_DAYS = 3;

// DashStats: one row per panel row, same order as DASH_PANELS. Cols A..P stats, Q.. spark values.
function dashWriteStats_(cols){
  const rows=[], header=['series_id','label','panel','asof','last','prev','d1','d1w','d1m','ytd','pct1y','hi1y','lo1y','pos1y','n','mode'];
  for(let k=0;k<DASH_SPARK_N;k++) header.push('s'+(k+1));
  // v5: legacy rows first, in DASH_PANELS order, then the page-only rows. One loop, one contract.
  const allItems=[];
  DASH_PANELS.forEach(([panel,items])=>items.forEach(it=>allItems.push([panel].concat(it))));
  PAGE_EXTRA.forEach(([id,label,group,mode,dec,scale,transform])=>allItems.push(['PAGE:'+group,id,label,mode,dec,scale,transform]));
  const statsById={}, ext=[];
  allItems.forEach(([panel,id,label,mode,dec,scale,transform])=>{
    const s=dashStats_(cols[id],mode,scale,transform); if(panel.indexOf('PAGE:')!==0 || !statsById[id]) statsById[id]=s;
    const r=[id,label,panel, s?ymd_(s.asof):'', s?s.last:'', s?s.prev:'', s?s.d1:'', s?s.d1w:'', s?s.d1m:'', s?s.ytd:'',
             s?s.pct:'', s?s.hi:'', s?s.lo:'', s?s.pos:'', s?s.n:0, mode];
    const sp = s ? s.spark : []; const pad = DASH_SPARK_N - sp.length;
    for(let k=0;k<DASH_SPARK_N;k++) r.push(k<pad ? '' : sp[k-pad]);
    rows.push(r); ext.push({id:id, s:s}); });
  // v5 extension columns: v1m, v1y, pct3y (credit ids, from the 5Y mirror), cadence, status
  const asofAll = ext.map(e=>e.s&&e.s.asof).filter(Boolean).sort((a,b)=>b-a)[0];
  let cols5 = null;
  const pct3y = id => { if(PAGE_PCT3Y_IDS.indexOf(id)<0) return '';
    if(!cols5){ try{ cols5 = dashLoadHistory_('MacroData (5Y)'); }catch(e){ cols5 = {}; } }
    const pts=(cols5[id]||[]); if(!pts.length) return ''; const last=pts[pts.length-1];
    const cut=new Date(last[0].getTime()-3*365*86400000); const w=pts.filter(p=>p[0]>=cut).map(p=>p[1]); if(!w.length) return '';
    return Math.round(w.filter(x=>x<=last[1]).length/w.length*1000)/10; };
  const extRows = ext.map(({id,s})=>{
    if(!s) return ['','','','', 'MISSING'];
    const cad = s.cadence||1;
    const behind = !!(asofAll && Math.round((asofAll - s.asof)/86400000) > DASH_STALE_DAYS);
    const status = dashLate_(id,s) ? 'LATE' : (cad>=20 ? 'MONTHLY' : (cad>=5 ? 'WEEKLY' : (behind ? 'BEHIND' : 'FRESH')));
    return [s.v1m, s.v1y, pct3y(id), Math.round(cad*10)/10, status]; });
  const sh = ss_().getSheetByName(DASH.stats)||ss_().insertSheet(DASH.stats);
  sh.getRange(1,1,sh.getMaxRows(),Math.max(1,DASH_SPARK_N+16)).clearContent();
  sh.getRange(1,DASH_EXT_COL,sh.getMaxRows(),DASH_EXT_HEADER.length).clearContent();
  sh.getRange(1,1,1,header.length).setValues([header]).setFontWeight('bold');
  sh.getRange(2,1,rows.length,header.length).setValues(rows);
  sh.getRange(2,4,rows.length,1).setNumberFormat('yyyy-mm-dd');
  sh.getRange(1,DASH_EXT_COL,1,DASH_EXT_HEADER.length).setValues([DASH_EXT_HEADER]).setFontWeight('bold');
  sh.getRange(2,DASH_EXT_COL,extRows.length,DASH_EXT_HEADER.length).setValues(extRows);
  return statsById;
}
// DashSeries: Date + DASH_SERIES columns, last 365 days, forward-filled on the union of dates.
function dashWriteSeries_(cols){
  const cutoff = new Date(Date.now()-366*86400000);
  const ALL = DASH_SERIES.concat(DASH_SERIES_EXTRA);      // v5: legacy columns 2..9 first, page columns after
  const dateSet={}; ALL.forEach(([,id])=>(cols[id]||[]).forEach(p=>{ if(p[0]>=cutoff) dateSet[ymd_(p[0])]=p[0]; }));
  const dates = Object.keys(dateSet).sort().map(k=>dateSet[k]);
  const out=[['Date'].concat(ALL.map(s=>s[0]))];
  const ptrs = ALL.map(()=>0), lastVal = ALL.map(()=>'');
  dates.forEach(d=>{ const row=[d];
    ALL.forEach(([,id,scale],i)=>{ const pts=cols[id]||[]; while(ptrs[i]<pts.length && pts[ptrs[i]][0]<=d){ lastVal[i]=pts[ptrs[i]][1]*(scale||1); ptrs[i]++; } row.push(lastVal[i]); });
    out.push(row); });
  const sh = ss_().getSheetByName(DASH.series)||ss_().insertSheet(DASH.series);
  sh.clearContents();
  sh.getRange(1,1,out.length,out[0].length).setValues(out);
  sh.getRange(2,1,Math.max(1,out.length-1),1).setNumberFormat('yyyy-mm-dd');
  return out.length-1;
}

// ---------------------------------------------------------------- number formats
function dashFmtLast_(dec){ return dec<=0 ? '#,##0' : '#,##0.'+'0'.repeat(dec); }
function dashFmtChg_(mode,dec){
  if(mode==='bp')  return '+0" bp";-0" bp";0" bp"';
  if(mode==='pct') return '+0.0%;-0.0%;0.0%';
  const d = dec<=0 ? '#,##0' : '#,##0.'+'0'.repeat(Math.min(dec,2));
  return '+'+d+';-'+d+';'+d;
}

// ---------------------------------------------------------------- render
function dashRender_(build){
  const ss = ss_();
  const cols = dashLoadHistory_();
  const stats = dashWriteStats_(cols);
  const nSeries = dashWriteSeries_(cols);
  const ratios = dashReadRatios_();

  let sh = ss.getSheetByName(DASH.tab);
  if(!sh){ sh = ss.insertSheet(DASH.tab, 0); build = true; }
  if(build){ sh.clear(); sh.clearConditionalFormatRules(); }
  else sh.getRange(1,1,sh.getMaxRows(),13).clearContent();

  const V = [];                               // cell model: V[row-1][col-1] for cols A..M (13 cols)
  const NCOL = 13;
  const put = (r,c,v) => { while(V.length<r) V.push(new Array(NCOL).fill('')); V[r-1][c-1]=v; };
  const fmt = [];                             // [row, col, numberFormat]
  const styles = [];                          // deferred style ops: fn(sh)
  const asofAll = Object.keys(stats).map(k=>stats[k]&&stats[k].asof).filter(Boolean).sort((a,b)=>b-a)[0];

  // ---- row 1: title bar
  // --- v4: "Data as of" is the MAX as-of across every series, so on 10 Sep it read
  // 2026-09-09 (three fresh OANDA series) while the UST 10y tile below showed a 4 Sep number.
  // The date stays, but it now carries a count of how much of the board is behind it —
  // otherwise the one number everyone reads first is the most misleading one on the page.
  // v4.2.1: the headline was answering the wrong question. Counting rows merely dated before
  // the board's newest row made it read "40 of 57 series >3d old" on an afternoon when every
  // series was current — two MAS standing-facility rates published same-day pulled asofAll to
  // the 14th, and the entire healthy US rates block counted as stale against them. LATE (past
  // its own cadence) is the alarm; BEHIND is context, and the row labels already carry it.
  let nLate = 0, nBehind = 0, nDated = 0;
  Object.keys(stats).forEach(k=>{ const s=stats[k]; if(!s||!s.asof) return; nDated++;
    if(dashLate_(k,s)) nLate++;
    if(asofAll && Math.round((asofAll - s.asof)/86400000) > DASH_STALE_DAYS) nBehind++; });
  const freshness = nDated === 0 ? 'no data'
    : (nLate ? nLate+' of '+nDated+' series LATE' : 'all '+nDated+' series within cadence')
      + (nBehind ? ' · '+nBehind+' dated before '+(asofAll?ymd_(asofAll):'—') : '');

  put(1,2,'MARKETS DASHBOARD'); put(1,5,'Data as of'); put(1,6, asofAll?ymd_(asofAll):'—'); fmt.push([1,6,'yyyy-mm-dd']);
  // v4: cfgTrue_, not a second hand-rolled === test. Two different truthiness tests on the
  // same flag is exactly what let the header say "Backfill complete" in v2 while dailyUpdate
  // believed the opposite and re-ran the backfill for two days.
  const bf = cfgTrue_('BACKFILL_DONE');
  // v4.2: LAST_RUN alone lied. It was only written when finalize completed, so a run that
  // paused mid-finalize left it untouched — on the morning of 14 Sep 2026 the header read
  // "last run 2026-09-12 06:27" although the sheet had fetched at 05:55 and 06:24 that day.
  // Two clocks now: LAST_RUN is the last execution, LAST_COMPLETE the last one that finished
  // all six stages. Print the second only when it disagrees, so a healthy board stays quiet.
  const lastRun  = String(getCfg_('LAST_RUN','')  || '—');
  const lastDone = String(getCfg_('LAST_COMPLETE','') || '');
  const runNote  = 'last run '+lastRun +
    ((lastDone && lastDone.slice(0,10) !== lastRun.slice(0,10))
      ? ' · INCOMPLETE — last full rebuild '+lastDone : '');
  put(1,8,(bf?freshness:'BACKFILL INCOMPLETE — run backfill() until Config!BACKFILL_DONE = TRUE')+' · '+runNote+' · refreshed '+Utilities.formatDate(new Date(),TZ,'dd MMM HH:mm'));

  // ---- rows 3-5: headline tiles (B..J)
  DASH_TILES.forEach(([id,short],i)=>{ const c=2+i; const spec=dashFindSpec_(id); const s=stats[id];
    put(3,c,short); put(4,c, s?s.last:'—'); put(5,c, s?s.d1:'');
    if(spec){ fmt.push([4,c,dashFmtLast_(spec[3])]); fmt.push([5,c,dashFmtChg_(spec[2],spec[3])]); } });

  // ---- panels from row 7
  let r = 7; const panelRows=[], chgCells=[], pctCells=[], staleRows=[]; let statsRow = 2;
  DASH_PANELS.forEach(([panel,items])=>{
    put(r,2,panel); panelRows.push(r); r++;
    ['Metric','Last','Δ prev','1W','1M','YTD','1Y %ile','52w range','60-obs trend'].forEach((h,i)=>put(r,2+i,h)); const hdrRow=r; r++;
    items.forEach(([id,label,mode,dec])=>{ const s=stats[id];
      // v4: a row more than DASH_STALE_DAYS behind the freshest series carries its own date
      // in the label and is greyed below. Putting it in column B costs no extra column and
      // stays readable on a phone, which a hover note would not.
      const stale = !!(s && s.asof && asofAll && Math.round((asofAll - s.asof)/86400000) > DASH_STALE_DAYS);
      if(stale) staleRows.push(r);
      put(r,2, stale ? label+' · '+Utilities.formatDate(s.asof,'UTC','d MMM') : label);
      put(r,3, s?s.last:'—'); put(r,4, s?s.d1:''); put(r,5, s?s.d1w:''); put(r,6, s?s.d1m:''); put(r,7, s?s.ytd:''); put(r,8, s?s.pct:'');
      put(r,9, '=IF(DashStats!$N$'+statsRow+'="","",IFERROR(SPARKLINE({DashStats!$N$'+statsRow+',1-DashStats!$N$'+statsRow+'},{"charttype","bar";"color1","'+DC.blue+'";"color2","'+DC.grid+'";"max",1}),""))');
      put(r,10,'=IFERROR(SPARKLINE(DashStats!$Q$'+statsRow+':$'+dashColLetter_(16+DASH_SPARK_N)+'$'+statsRow+',{"charttype","line";"color","'+DC.blue+'";"linewidth",1.5}),"")');
      fmt.push([r,3,dashFmtLast_(dec)]); [4,5,6,7].forEach(c=>fmt.push([r,c,dashFmtChg_(mode,dec)])); fmt.push([r,8,'0']);
      chgCells.push(r); pctCells.push(r); statsRow++; r++; });
    r++; });
  const panelsEnd = r-1;

  // ---- rotation block
  r++; const rotTitle = r;
  put(r,2,'ROTATION — ETF / SPY RELATIVE STRENGTH'); put(r,8,'Rank chart:'); put(r,9,DASH_TF[2]); const selCell = {row:r,col:9};
  put(r,10,'panel '+(ratios.asof||'—')+'  · = earlier date');
  r++; ['Group','Ticker','Ratio','1D','5D','20D','60D','YTD','1Y %ile','>50d','>200d','60-obs ratio trend'].forEach((h,i)=>put(r,2+i,h)); const rotHdr=r; r++;
  const rotGroupRows=[], rotDataRows=[], rotStaleRows=[];
  RATIO_GROUPS.forEach(([g,tickers])=>{
    put(r,2,g); rotGroupRows.push(r); r++;
    tickers.forEach(t=>{ const q=ratios.byTicker[t]||{};
      // v4: a ticker GOOGLEFINANCE has not filled to the panel date is computed at its own
      // last date. Mark it with a dot and grey it, so a 4 Sep ratio is never read as though
      // it ranked against an 8 Sep one. The exact date is on the RatiosLatest tab.
      const rotStale = String(q.status||'').indexOf('STALE') === 0;
      if(rotStale) rotStaleRows.push(r);
      put(r,3, rotStale ? t+' ·' : t); put(r,4,isNum(q.ratio)?q.ratio:'—'); put(r,5,q.rel_1d); put(r,6,q.rel_5d); put(r,7,q.rel_20d); put(r,8,q.rel_60d); put(r,9,q.rel_ytd); put(r,10,q.pct);
      put(r,11, q.above50===true||q.above50==='TRUE'?'▲':(q.above50===false||q.above50==='FALSE'?'▼':'')); put(r,12, q.above200===true||q.above200==='TRUE'?'▲':(q.above200===false||q.above200==='FALSE'?'▼':''));
      const col = ratios.colLetter[t];
      put(r,13, col ? '=IFERROR(SPARKLINE(ARRAYFORMULA(IFERROR(OFFSET(Ratios!$'+col+'$1,COUNT(Ratios!$A:$A)-'+(DASH_SPARK_N-1)+',0,'+DASH_SPARK_N+',1)/OFFSET(Ratios!$'+ratios.spyLetter+'$1,COUNT(Ratios!$A:$A)-'+(DASH_SPARK_N-1)+',0,'+DASH_SPARK_N+',1))),{"charttype","line";"color","'+DC.blue+'";"linewidth",1.5}),"")' : '');
      fmt.push([r,4,'0.0000']); [5,6,7,8,9].forEach(c=>fmt.push([r,c,'+0.0"%";-0.0"%";0.0"%"'])); fmt.push([r,10,'0']);
      rotDataRows.push(r); r++; }); });
  const rotEnd = r-1;

  // ---- write values + formats (one call each — hundreds of per-cell calls would take 20s+ in Apps Script)
  sh.getRange(1,1,V.length,NCOL).setValues(V);
  const F = V.map(row=>row.map(()=>'General')); fmt.forEach(([rr,cc,f])=>{ F[rr-1][cc-1]=f; });
  sh.getRange(1,1,V.length,NCOL).setNumberFormats(F);

  // ---- ranked-rotation helper (DashStats cols CA:CD) — live formula off the selector cell
  const st = ss.getSheetByName(DASH.stats);
  st.getRange('CA1:CD1').setValues([['ticker','value','up','down']]);
  st.getRange('CA2').setFormula('=ARRAYFORMULA(IFERROR(LET(t,RatiosLatest!$B$2:$B,v,INDEX(RatiosLatest!$E$2:$I,0,MATCH(Dashboard!$'+dashColLetter_(selCell.col)+'$'+selCell.row+',{"1D","5D","20D","60D","YTD"},0)),'+
    'SORT(FILTER({t,v,IF(v>=0,v,0),IF(v<0,v,0)},t<>"",ISNUMBER(v)),2,FALSE)),""))');

  // ---- styling (every run: cheap, keeps the tab self-healing)
  dashStyle_(sh, {panelRows, panelsEnd, chgCells, pctCells, rotTitle, rotHdr, rotGroupRows, rotDataRows, rotEnd, selCell, V, staleRows, rotStaleRows});

  sh.getCharts().forEach(c=>sh.removeChart(c));
  [[7,14],[7,20],[23,14],[23,20],[39,14]].forEach(([rr,cc])=>sh.getRange(rr,cc).clearContent());
  dashCharts_(sh, ss.getSheetByName(DASH.series), st, nSeries+1);
  if(build){
    dashConditionalFormats_(sh, {panelsEnd, rotDataRows, selCell});
    // Helper tabs must stay VISIBLE: Sheets charts skip data on hidden sheets and render blank.
    // Park them at the far right, grey, so they read as internals rather than content.
    [DASH.stats, DASH.series].forEach(n=>{ const h=ss.getSheetByName(n); if(!h) return; if(h.isSheetHidden()) h.showSheet();
      h.setTabColor('#b5b4ad'); ss.setActiveSheet(h); ss.moveActiveSheet(ss.getNumSheets()); });
    ss.setActiveSheet(sh); ss.moveActiveSheet(1);
    sh.setTabColor(DC.amber);
  }
  try{ if(typeof liveWritePanelCols_ === 'function') liveWritePanelCols_(); }catch(e){ diag_('dashRender_','live cols','ERROR',e.message); }
  try{ writeMeta_(); }catch(e){ diag_('dashRender_','meta','ERROR',e.message); }
}
function dashFindSpec_(id){ for(const [,items] of DASH_PANELS) for(const it of items) if(it[0]===id) return it; return null; }
function dashColLetter_(n){ let s=''; while(n>0){ const m=(n-1)%26; s=String.fromCharCode(65+m)+s; n=(n-m-1)/26; } return s; }

// RatiosLatest → {byTicker, colLetter (Ratios tab), spyLetter, asof}
function dashReadRatios_(){
  const out={byTicker:{}, colLetter:{}, spyLetter:'B', asof:''};
  const rl = ss_().getSheetByName(TAB.ratiosLatest);
  if(rl && rl.getLastRow()>1){
    // v4: 20 columns now — updateRatios_ added stale_days beside status. Reading 19 would
    // silently drop it and every ticker would render as though it were on the panel date.
    // ix() is name-based, so the widths only have to be big enough, never exact.
    const vals = rl.getRange(1,1,rl.getLastRow(),20).getValues(); const h=vals[0]; const ix=n=>h.indexOf(n);
    for(let i=1;i<vals.length;i++){ const v=vals[i]; const t=v[ix('ticker')]; if(!t) continue;
      out.byTicker[t]={ ratio:v[ix('ratio')], rel_1d:v[ix('rel_1d')], rel_5d:v[ix('rel_5d')], rel_20d:v[ix('rel_20d')], rel_60d:v[ix('rel_60d')], rel_ytd:v[ix('rel_ytd')],
                        pct:v[ix('pct_rank_1y')], above50:v[ix('above50')], above200:v[ix('above200')],
                        status:v[ix('status')], stale_days:v[ix('stale_days')] };
      // v4: the panel date is the date shared by the "ok" rows, not the max across all rows —
      // a laggard measured to an earlier date must not be allowed to set the header.
      const st = String(v[ix('status')]||'');
      if(st === 'ok' || !out.asof){
        // v4.1: anyDate_ undoes the timezone shift Sheets applies when it parses the
        // ymd_() text updateRatios_ writes. Reading the raw cell with ymd_() reported the
        // rotation block as a day earlier than it actually was.
        const d = anyDate_(v[ix('date')]);
        if(d) out.asof = ymd_(d);
        else if(v[ix('date')]) out.asof = String(v[ix('date')]);
      } }
  }
  const rt = ss_().getSheetByName(TAB.ratios);
  if(rt && rt.getLastColumn()>1){ const hdr=rt.getRange(1,1,1,rt.getLastColumn()).getValues()[0];
    hdr.forEach((t,i)=>{ if(t==='SPY') out.spyLetter=dashColLetter_(i+1); else if(t) out.colLetter[t]=dashColLetter_(i+1); }); }
  return out;
}

// ---------------------------------------------------------------- styling
function dashStyle_(sh, L){
  const lastRow = L.rotEnd + 2;
  sh.setHiddenGridlines(true);
  // v4: setFontStyle('normal') added here so the stale-row italics applied at the end of this
  // function are cleared on every render. One chained call on a bulk range that already runs,
  // rather than a per-row reset loop.
  sh.getRange(1,1,lastRow,24).setBackground(DC.surface).setFontFamily(DASH_FONT_TXT).setFontSize(9).setFontColor(DC.ink).setFontStyle('normal').setVerticalAlignment('middle');
  sh.setRowHeights(1,lastRow,17);
  // column widths: A margin · B labels · C..H numbers · I range · J spark · K/L flags · M spark · N.. chart area
  const widths = {1:8, 2:150, 3:66, 4:66, 5:62, 6:62, 7:62, 8:52, 9:70, 10:92, 11:44, 12:44, 13:92};
  Object.keys(widths).forEach(c=>sh.setColumnWidth(+c, widths[c]));
  for(let c=14;c<=25;c++) sh.setColumnWidth(c,72);
  // title bar
  sh.setRowHeight(1,26);
  sh.getRange(1,1,1,25).setBackground(DC.head);
  sh.getRange(1,2).setFontColor(DC.amber).setFontSize(13).setFontWeight('bold');
  sh.getRange(1,5,1,4).setFontColor('#ffffff').setFontSize(9); sh.getRange(1,6).setFontFamily(DASH_FONT_NUM).setFontWeight('bold');
  sh.getRange(1,8).setFontColor(DC.grey);
  // tiles
  sh.setRowHeight(3,14); sh.setRowHeight(4,24); sh.setRowHeight(5,15);
  sh.getRange(3,2,1,9).setFontColor(DC.muted).setFontSize(8).setHorizontalAlignment('right');
  sh.getRange(4,2,1,9).setFontFamily(DASH_FONT_NUM).setFontSize(13).setFontWeight('bold').setHorizontalAlignment('right');
  sh.getRange(5,2,1,9).setFontFamily(DASH_FONT_NUM).setFontSize(9).setHorizontalAlignment('right');
  sh.getRange(3,2,3,9).setBackground(DC.panel).setBorder(true,true,true,true,true,false,DC.grid,SpreadsheetApp.BorderStyle.SOLID);
  // panels
  sh.getRange(7,3,L.panelsEnd-6,6).setFontFamily(DASH_FONT_NUM).setHorizontalAlignment('right');
  sh.getRange(7,3,L.panelsEnd-6,1).setFontWeight('bold');
  L.panelRows.forEach(pr=>{
    sh.getRange(pr,2,1,9).setBackground(DC.head).setFontColor(DC.amber).setFontWeight('bold').setFontSize(9).setFontFamily(DASH_FONT_TXT);
    sh.getRange(pr+1,2,1,9).setFontColor(DC.muted).setFontSize(8).setFontWeight('normal').setFontFamily(DASH_FONT_TXT).setBorder(null,null,true,null,null,null,DC.grid,SpreadsheetApp.BorderStyle.SOLID);
    sh.getRange(pr+1,3,1,8).setHorizontalAlignment('right'); });
  sh.getRange(7,2,L.panelsEnd-6,9).setBorder(null,null,null,null,null,true,'#efefeb',SpreadsheetApp.BorderStyle.SOLID);   // hairlines between rows
  // rotation block
  sh.getRange(L.rotTitle,2,1,12).setBackground(DC.head).setFontColor(DC.amber).setFontWeight('bold');
  sh.getRange(L.rotTitle,8).setFontColor('#ffffff').setFontWeight('normal').setHorizontalAlignment('right');
  sh.getRange(L.rotTitle,10).setFontColor(DC.grey).setFontWeight('normal');
  const sel = sh.getRange(L.selCell.row,L.selCell.col);
  sel.setBackground(DC.amberFill).setFontColor(DC.ink).setFontWeight('bold').setHorizontalAlignment('center')
     .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(DASH_TF,true).setAllowInvalid(false).build());
  sh.getRange(L.rotHdr,2,1,12).setFontColor(DC.muted).setFontSize(8).setBorder(null,null,true,null,null,null,DC.grid,SpreadsheetApp.BorderStyle.SOLID);
  sh.getRange(L.rotHdr,4,1,9).setHorizontalAlignment('right');
  L.rotGroupRows.forEach(gr=>sh.getRange(gr,2,1,12).setBackground(DC.panel).setFontWeight('bold').setFontColor(DC.ink2));
  if(L.rotDataRows.length){ const r0=L.rotDataRows[0], n=L.rotEnd-r0+1;
    sh.getRange(r0,3,n,1).setFontWeight('bold');
    sh.getRange(r0,4,n,7).setFontFamily(DASH_FONT_NUM).setHorizontalAlignment('right');
    sh.getRange(r0,11,n,2).setHorizontalAlignment('center');
    sh.getRange(r0,2,n,12).setBorder(null,null,null,null,null,true,'#efefeb',SpreadsheetApp.BorderStyle.SOLID); }

  // --- v4: grey anything measured to an older date than the rest of the board. The numbers
  // stay readable — they are real, just not comparable with the rows around them.
  // No un-grey pass is needed: the bulk setFontColor/setFontStyle at the top of this function
  // resets the whole sheet every run, so a row that becomes current again recovers by itself.
  // Doing it that way matters — a per-row reset would be ~87 range calls, and this file
  // already learned the hard way that per-cell styling costs 20s+ in Apps Script.
  (L.staleRows   ||[]).forEach(rr => sh.getRange(rr,2,1,7).setFontColor(DC.muted).setFontStyle('italic'));
  (L.rotStaleRows||[]).forEach(rr => sh.getRange(rr,3,1,8).setFontColor(DC.muted).setFontStyle('italic'));

  sh.setFrozenRows(5);
}

function dashConditionalFormats_(sh, L){
  const rules=[]; const N=SpreadsheetApp.InterpolationType.NUMBER;
  const chgRange = [sh.getRange(5,2,1,9), sh.getRange(7,4,L.panelsEnd-6,4)];      // tile Δ row + Δ columns D..G
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor(DC.up).setRanges(chgRange).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor(DC.down).setRanges(chgRange).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().setGradientMinpointWithValue('#ffffff',N,'0').setGradientMaxpointWithValue(DC.amberFill,N,'100')
             .setRanges([sh.getRange(7,8,L.panelsEnd-6,1)]).build());
  if(L.rotDataRows.length){ const r0=L.rotDataRows[0], n=L.rotDataRows[L.rotDataRows.length-1]-r0+1;
    const span = {5:2, 6:4, 7:8, 8:15, 9:30};                                     // ±% span per column: 1D 5D 20D 60D YTD
    Object.keys(span).forEach(c=>rules.push(SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpointWithValue(DC.downFill,N,String(-span[c])).setGradientMidpointWithValue('#ffffff',N,'0').setGradientMaxpointWithValue(DC.upFill,N,String(span[c]))
      .setRanges([sh.getRange(r0,+c,n,1)]).build()));
    rules.push(SpreadsheetApp.newConditionalFormatRule().setGradientMinpointWithValue('#ffffff',N,'0').setGradientMaxpointWithValue(DC.amberFill,N,'100').setRanges([sh.getRange(r0,10,n,1)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('▲').setFontColor(DC.up).setRanges([sh.getRange(r0,11,n,2)]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('▼').setFontColor(DC.down).setRanges([sh.getRange(r0,11,n,2)]).build()); }
  sh.setConditionalFormatRules(rules);
}

// ---------------------------------------------------------------- charts
function dashCharts_(sh, ds, st, N){                 // N = DashSeries rows incl. header (exact — charts are rebuilt every refresh)
  const vals = N>1 ? ds.getRange(1,1,N,ds.getLastColumn()).getValues() : [];
  const hasData = c => vals.length>1 && vals.slice(1).some(r=>typeof r[c-1]==='number');
  const base = b => b.setOption('backgroundColor','#ffffff').setOption('fontName','Roboto').setOption('titleTextStyle',{fontSize:11,bold:true,color:DC.ink})
    .setOption('legend',{position:'top',textStyle:{fontSize:9,color:DC.ink2}}).setOption('hAxis',{format:'MMM yy',textStyle:{fontSize:8,color:DC.muted},gridlines:{color:'#ffffff'}})
    .setOption('vAxis',{textStyle:{fontSize:8,color:DC.muted},gridlines:{color:DC.grid,count:4}})
    .setOption('width',432).setOption('height',250).setOption('interpolateNulls',true).setOption('useFirstColumnAsDomain',true);
    // NOTE: chartArea (with % sizes), gridlines 'transparent' and baselineColor make Sheets render a BLANK chart — confirmed 7 Sep 2026. Do not add back.
  const line = (title, colsIdxAll, dual, anchorRow, anchorCol) => {
    const colsIdx = colsIdxAll.filter(hasData);
    if(!colsIdx.length){ sh.getRange(anchorRow,anchorCol).setValue('⏳ '+title+' — no data yet (finish backfill)').setFontColor(DC.muted).setFontSize(8); return; }
    let b = sh.newChart().setChartType(Charts.ChartType.LINE).addRange(ds.getRange(1,1,N,1));
    colsIdx.forEach(c=>b.addRange(ds.getRange(1,c,N,1)));
    b = b.setNumHeaders(1);
    b = base(b).setOption('title',title).setOption('lineWidth',2).setOption('curveType','none').setPosition(anchorRow,anchorCol,0,0);
    const series = {0:{color:DC.blue,targetAxisIndex:0}}; if(colsIdx.length>1) series[1]={color:DC.orange,targetAxisIndex:dual?1:0};
    b.setOption('series',series); if(dual) b.setOption('vAxes',{0:{textStyle:{fontSize:8}},1:{textStyle:{fontSize:8},gridlines:{color:'#ffffff'}}});
    sh.insertChart(b.build()); };
  // DashSeries columns: 1 Date · 2 UST10y · 3 2s10s · 4 HY OAS · 5 VIX · 6 NetLiq · 7 3M SORA · 8 Fed funds · 9 USDSGD
  const A=14, B=20;                                   // anchor columns N and T (two chart columns)
  line('UST 10y (L) & 2s10s (R) — 1Y',     [2,3], true,  7, A);
  line('HY OAS (L) vs VIX (R) — 1Y',        [4,5], true,  7, B);
  line('Net liquidity $bn — 1Y',            [6],   false, 23, A);
  line('3M compounded SORA vs Fed funds — 1Y',[7,8],false, 23, B);
  line('USDSGD — 1Y',                       [9],   false, 39, A);
  // ranked rotation bars (selector-driven helper in DashStats CA:CD)
  let rb = sh.newChart().setChartType(Charts.ChartType.BAR).addRange(st.getRange('CA1:CA39')).addRange(st.getRange('CC1:CD39')).setNumHeaders(1);
  rb = base(rb).setOption('title','Rotation — relative return vs SPY, ranked (timeframe from selector)').setOption('isStacked',true)
    .setOption('width',432).setOption('height',560).setOption('legend',{position:'none'})
    .setOption('series',{0:{color:DC.up},1:{color:DC.down}}).setOption('hAxis',{format:'+0.0"%";-0.0"%"',textStyle:{fontSize:8,color:DC.muted},gridlines:{color:DC.grid}})
    .setOption('vAxis',{textStyle:{fontSize:8,color:DC.ink}}).setPosition(39,B,0,0);
  sh.insertChart(rb.build());
}

// ---------------------------------------------------------------- debug
function debugCharts(){
  const ss=ss_(); const ds=ss.getSheetByName(DASH.series); if(!ds||ds.getLastRow()<3) throw new Error('DashSeries is empty — run refreshDashboard() first');
  const N=ds.getLastRow();
  let t=ss.getSheetByName('ChartTest'); if(t){ t.getCharts().forEach(c=>t.removeChart(c)); t.clear(); } else t=ss.insertSheet('ChartTest');
  t.getRange('A1').setValue('Chart test — which of these show a line? A = bare · B = +domain/headers · C = +styling · D = +chartArea/gridlines (production)');
  // A: bare — one contiguous range, nothing else
  t.insertChart(t.newChart().setChartType(Charts.ChartType.LINE).addRange(ds.getRange(1,1,N,2))
    .setOption('title','A: bare, contiguous A:B').setOption('width',420).setOption('height',220).setPosition(3,1,0,0).build());
  // B: separate ranges + first column as domain + explicit header row (how production adds data)
  t.insertChart(t.newChart().setChartType(Charts.ChartType.LINE).addRange(ds.getRange(1,1,N,1)).addRange(ds.getRange(1,2,N,1)).addRange(ds.getRange(1,3,N,1))
    .setNumHeaders(1).setOption('useFirstColumnAsDomain',true).setOption('interpolateNulls',true)
    .setOption('title','B: separate ranges, domain, headers').setOption('width',420).setOption('height',220).setPosition(3,8,0,0).build());
  // C: B + colours, legend, fonts, series/axes (no chartArea, no gridline colours)
  t.insertChart(t.newChart().setChartType(Charts.ChartType.LINE).addRange(ds.getRange(1,1,N,1)).addRange(ds.getRange(1,2,N,1)).addRange(ds.getRange(1,3,N,1))
    .setNumHeaders(1).setOption('useFirstColumnAsDomain',true).setOption('interpolateNulls',true)
    .setOption('backgroundColor','#ffffff').setOption('fontName','Roboto').setOption('titleTextStyle',{fontSize:11,bold:true,color:DC.ink})
    .setOption('legend',{position:'top',textStyle:{fontSize:9,color:DC.ink2}}).setOption('lineWidth',2).setOption('curveType','none')
    .setOption('series',{0:{color:DC.blue,targetAxisIndex:0},1:{color:DC.orange,targetAxisIndex:1}}).setOption('vAxes',{0:{textStyle:{fontSize:8}},1:{textStyle:{fontSize:8}}})
    .setOption('hAxis',{format:'MMM yy',textStyle:{fontSize:8,color:DC.muted}}).setOption('vAxis',{textStyle:{fontSize:8,color:DC.muted}})
    .setOption('title','C: + colours/legend/fonts/axes').setOption('width',420).setOption('height',220).setPosition(17,1,0,0).build());
  // D: C + chartArea + gridline colours (= production)
  t.insertChart(t.newChart().setChartType(Charts.ChartType.LINE).addRange(ds.getRange(1,1,N,1)).addRange(ds.getRange(1,2,N,1)).addRange(ds.getRange(1,3,N,1))
    .setNumHeaders(1).setOption('useFirstColumnAsDomain',true).setOption('interpolateNulls',true)
    .setOption('backgroundColor','#ffffff').setOption('fontName','Roboto').setOption('titleTextStyle',{fontSize:11,bold:true,color:DC.ink})
    .setOption('legend',{position:'top',textStyle:{fontSize:9,color:DC.ink2}}).setOption('lineWidth',2).setOption('curveType','none')
    .setOption('series',{0:{color:DC.blue,targetAxisIndex:0},1:{color:DC.orange,targetAxisIndex:1}}).setOption('vAxes',{0:{textStyle:{fontSize:8}},1:{textStyle:{fontSize:8},gridlines:{color:'transparent'}}})
    .setOption('hAxis',{format:'MMM yy',textStyle:{fontSize:8,color:DC.muted},gridlines:{color:'transparent'}})
    .setOption('vAxis',{textStyle:{fontSize:8,color:DC.muted},gridlines:{color:DC.grid,count:4},baselineColor:DC.grid})
    .setOption('chartArea',{left:48,top:36,width:'78%',height:'68%'})
    .setOption('title','D: + chartArea + gridlines (production)').setOption('width',420).setOption('height',220).setPosition(17,8,0,0).build());
  ss.setActiveSheet(t); log_('debugCharts: 4 test charts on ChartTest');
}
