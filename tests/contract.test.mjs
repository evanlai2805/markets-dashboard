// Sheet → page contract tests. Run: node --test tests/
//   SHEET_ID=<id> node --test tests/          against the live public sheet (default: the canonical id)
//   FIXTURES=fixtures node --test tests/      against local CSV fixtures (offline)
// Asserts the immutable legacy zone, the v5 extension zone, schema version, and that nothing
// on the public workbook looks like a credential. Fails loudly; never "warns".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const SHEET_ID = process.env.SHEET_ID || '1xaAF9PcQm51QEUD-6nGWGHNSrRzK3AVyA1PN_Rk4YY4';
const FIXTURES = process.env.FIXTURES || '';
const SCHEMA_VERSION = '5';

const LEGACY_STATS_HEADER = 'series_id,label,panel,asof,last,prev,d1,d1w,d1m,ytd,pct1y,hi1y,lo1y,pos1y,n,mode';
const LEGACY_SERIES_HEADER = 'Date,UST 10y,2s10s,HY OAS,VIX,Net liquidity $bn,3M SORA,Fed funds,USDSGD';
const EXT_HEADER = 'v1m,v1y,pct3y,cadence,status';
const EXT_COL = 83;                       // CE (1-based) — DASH_EXT_COL in dashboard.gs
// rows 2..59 of DashStats, in DASH_PANELS order (dashboard.gs). Change here == contract change.
const LEGACY_IDS = ['DGS3MO','DGS2','DGS5','DGS10','DGS30','US_10Y_2Y','US_10Y_3M','DFII10','T10YIE','T5YIFR',
  'DFF','DFEDTARU','SOFR','WALCL','RRPONTSYD','WTREGEN','Net_Liquidity','M2SL',
  'BAMLH0A0HYM2','BAMLC0A0CM','HY_IG_OAS','VIXCLS','NFCI','ANFCI',
  'SORA_ON','SORA_1M','SORA_3M','SORA_6M','SG_SF_DEPO','SG_SF_BORR','TBILL_6M','TBILL_1Y','TBILL_6M_BTC','SGS_2Y','SGS_10Y','DEXSIUS','STI',
  'DXY','DTWEXBGS','DEXUSEU','DEXUSUK','DEXUSAL','DEXJPUS','DEXSZUS','DEXCAUS','DEXCHUS',
  'GOLD','COPPER','CopperGold','DCOILWTICO','DCOILBRENTEU','BTCUSD','ETHUSD','ETH_BTC',
  'ICSA','PAYEMS','UNRATE','CPIAUCSL','PCEPILFE'];
const REQUIRED_PAGE_IDS = ['DGS1','DGS3','DGS7','DGS20','DFII5','DFII30','T5YIE','US_5Y_30Y','BAMLC0A4CBBB','BAMLH0A1HYBB','BAMLH0A3HYC',
  'BAMLH0A0HYM2EY','G10Y_US','G10Y_DE','G10Y_JP','POLICY_PROXY_6M','CPILFESL'];
const PUBLIC_TABS = ['Dashboard','DashStats','DashSeries','Live','Ratios','RatiosLatest','MacroHistory','MacroData (1Y)','MacroData (2Y)',
  'MacroData (5Y)','MacroData (10Y)','Latest','Series','Config','Log','Diagnostics','Notes','Meta','Health','GFTest'];
const SECRET_PAT = /api_key=(?!\*\*\*)[^&\s"']{8,}|Bearer\s+(?!\*\*\*)\S{8,}|101-\d{3}-\d{7,}-\d{3}/;
const KEY_ROW = /(_API_KEY|_KEY|_SECRET|_TOKEN)$/;

// --- minimal RFC-4180 parser (gviz quotes every field)
export function parseCsv(text){
  const rows=[]; let row=[], f='', q=false;
  for(let i=0;i<text.length;i++){ const c=text[i];
    if(q){ if(c==='"'){ if(text[i+1]==='"'){ f+='"'; i++; } else q=false; } else f+=c; }
    else if(c==='"') q=true;
    else if(c===','){ row.push(f); f=''; }
    else if(c==='\n'){ row.push(f); rows.push(row); row=[]; f=''; }
    else if(c!=='\r') f+=c; }
  if(f!==''||row.length){ row.push(f); rows.push(row); }
  return rows;
}
async function tab(name, tq){
  if(FIXTURES){ try{ return parseCsv(await readFile(resolve(FIXTURES, name+'.csv'),'utf8')); }catch{ return null; } }
  const u=`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&headers=1&sheet=${encodeURIComponent(name)}`+(tq?`&tq=${encodeURIComponent(tq)}`:'')+`&_=${Date.now()}`;
  const r=await fetch(u, { redirect:'follow' }); if(!r.ok) return null;
  const t=await r.text(); if(t.trimStart().startsWith('<')) return null;   // HTML = tab missing / not public
  return parseCsv(t);
}
const col = (rows, name) => { const i=rows[0].indexOf(name); return i<0?null:rows.slice(1).map(r=>r[i]); };

test('DashStats legacy header A:P is unchanged', async ()=>{
  const st=await tab('DashStats'); assert.ok(st, 'DashStats missing');
  assert.equal(st[0].slice(0,16).join(','), LEGACY_STATS_HEADER);
  assert.equal(st[0].slice(16,76).join(','), Array.from({length:60},(_,i)=>'s'+(i+1)).join(','), 's1..s60 block changed');
});
test('DashStats rows 2..59 are the legacy panel rows in order', async ()=>{
  const st=await tab('DashStats'); const ids=st.slice(1).map(r=>r[0]);
  LEGACY_IDS.forEach((id,i)=>assert.equal(ids[i], id, `row ${i+2}`));
});
test('DashStats extension zone: header at CE, PAGE:* rows after the legacy block, required ids present', async ()=>{
  const st=await tab('DashStats');
  assert.equal(st[0].slice(EXT_COL-1, EXT_COL-1+5).join(','), EXT_HEADER, 'extension header (needs v5 deployed)');
  st.slice(1+LEGACY_IDS.length).forEach((r,i)=>assert.match(r[2], /^PAGE:/, `row ${LEGACY_IDS.length+i+2} panel`));
  const ids=new Set(st.slice(1).map(r=>r[0]));
  REQUIRED_PAGE_IDS.forEach(id=>assert.ok(ids.has(id), `missing ${id}`));
  const status=col(st,'status'); const allowed=new Set(['FRESH','LATE','BEHIND','WEEKLY','MONTHLY','MISSING']);
  status.forEach((s,i)=>assert.ok(allowed.has(s), `row ${i+2} status "${s}"`));
});
test('DashStats: legacy series have numeric last values and yyyy-mm-dd asof', async ()=>{
  const st=await tab('DashStats');
  st.slice(1,1+LEGACY_IDS.length).forEach(r=>{ if(r[14]==='0') return;      // n=0: series legitimately empty (e.g. SGS TODO)
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r[3]), `${r[0]} asof "${r[3]}"`);
    assert.ok(Number.isFinite(parseFloat(r[4])), `${r[0]} last "${r[4]}"`); });
});
test('DashSeries legacy header A:I is unchanged', async ()=>{
  const ds=await tab('DashSeries'); assert.ok(ds, 'DashSeries missing');
  assert.equal(ds[0].slice(0,9).join(','), LEGACY_SERIES_HEADER);
  assert.ok(ds.length>200, 'DashSeries too short');
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(ds[1][0]), 'Date not yyyy-mm-dd text');
});
test('Meta: schema_version matches and clocks present', async ()=>{
  const m=await tab('Meta'); assert.ok(m, 'Meta missing (needs v5 deployed)');
  const kv=Object.fromEntries(m.slice(1).map(r=>[r[0],r[1]]));
  assert.equal(kv.schema_version, SCHEMA_VERSION);
  assert.match(kv.generated_at||'', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
});
test('Live and RatiosLatest readable; no Book group', async ()=>{
  const lv=await tab('Live'); assert.ok(lv && lv[0].includes('mid'), 'Live');
  const rl=await tab('RatiosLatest'); assert.ok(rl && rl[0].includes('ticker'), 'RatiosLatest');
  assert.ok(!rl.slice(1).some(r=>r[0]==='Book'), 'RatiosLatest has a Book group');
});
test('Privacy: Config holds no secret values; Log/Diagnostics carry no credentials', async ()=>{
  const cfg=await tab('Config');
  if(cfg) cfg.slice(1).forEach(r=>{ if(KEY_ROW.test(r[0]) && r[0]!=='MAS_KEY_HEADER') assert.equal((r[1]||'').trim(), '', `Config ${r[0]} has a value`); });
  for(const n of ['Log','Diagnostics']){ const t=await tab(n); if(!t) continue;
    t.forEach((r,i)=>r.forEach(c=>assert.ok(!SECRET_PAT.test(c), `${n} row ${i+1} looks like a credential`))); }
});
test('Privacy: no personal tabs reachable', async ()=>{
  for(const n of ['Runs','IBKR Log','Book']){ const t=await tab(n);
    if(t) assert.ok(!(t[0].includes('ticker')&&t[0].includes('qty')) && !t[0].includes('run_date_sgt'), `${n} tab is public`); }
});
