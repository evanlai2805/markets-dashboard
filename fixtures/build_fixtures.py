"""Build v5-shaped fixture CSVs for offline page development and as an independent cross-check
of dashboard.gs. Not part of the deployed pipeline.

Inputs : the public sheet's current DashStats/DashSeries (legacy rows, fetched by fetch.sh),
         MacroHistory exported from a workbook .xlsx (26k rows), and FRED's keyless
         fredgraph.csv endpoint for the 33 v5 series the workbook does not yet hold.
Outputs: fixtures/DashStats.csv, fixtures/DashSeries.csv in the exact v5 column layout.

Usage: python3 fixtures/build_fixtures.py "<workbook.xlsx>"
"""
import sys, csv, io, math, urllib.request, datetime as dt
from statistics import median
import openpyxl

XLSX = sys.argv[1]
OUT = 'fixtures'
SPARK_N = 60
EXT_COL = 83
TODAY = dt.date.today()

# --- the same config blocks as dashboard.gs / code.gs (kept in sync by hand; tests catch drift)
NEW_FRED = {'DGS1MO':'DGS1MO','DGS6MO':'DGS6MO','DGS1':'DGS1','DGS3':'DGS3','DGS7':'DGS7','DGS20':'DGS20','DFII7':'DFII7','DFII20':'DFII20','DFII30':'DFII30',
 'T5YIE':'T5YIE','CPILFESL':'CPILFESL','BAMLC0A1CAAA':'BAMLC0A1CAAA','BAMLC0A2CAA':'BAMLC0A2CAA','BAMLC0A3CA':'BAMLC0A3CA','BAMLC0A4CBBB':'BAMLC0A4CBBB',
 'BAMLC1A0C13Y':'BAMLC1A0C13Y','BAMLH0A1HYBB':'BAMLH0A1HYBB','BAMLH0A2HYB':'BAMLH0A2HYB','BAMLH0A3HYC':'BAMLH0A3HYC','BAMLHE00EHYIOAS':'BAMLHE00EHYIOAS',
 'BAMLEMCBPIOAS':'BAMLEMCBPIOAS','BAMLH0A0HYM2EY':'BAMLH0A0HYM2EY','BAMLC0A0CMEY':'BAMLC0A0CMEY',
 **{f'G10Y_{c}':f'IRLTLT01{c if c!="GB" else "GB"}M156N' for c in ['US','DE','GB','JP','AU','CA','IT','FR','CH','ZA']}}
# Note: workbook also lacks nothing else we need; everything below is computed.
def sub(a,b): return a-b if (a is not None and b is not None) else None
COMPUTED = {
 'US_5Y_30Y':lambda m:sub(m.get('DGS30'),m.get('DGS5')), 'US_10Y_30Y':lambda m:sub(m.get('DGS30'),m.get('DGS10')),
 'US_2Y_30Y':lambda m:sub(m.get('DGS30'),m.get('DGS2')), 'US_20Y_30Y':lambda m:sub(m.get('DGS30'),m.get('DGS20')),
 'BE_5Y':lambda m:sub(m.get('DGS5'),m.get('DFII5')), 'BE_30Y':lambda m:sub(m.get('DGS30'),m.get('DFII30')),
 'BE_10Y_CALC':lambda m:sub(m.get('DGS10'),m.get('DFII10')),
 'POLICY_PROXY_6M':lambda m:sub(m.get('DGS6MO'),m.get('DFF')), 'POLICY_PROXY_1Y':lambda m:sub(m.get('DGS1'),m.get('DFF')),
 **{f'G10Y_{c}_US':(lambda c: (lambda m: sub(m.get(f'G10Y_{c}'),m.get('G10Y_US'))))(c) for c in ['DE','GB','JP','AU','CA','IT','FR','CH','ZA']}}
PAGE_EXTRA = [
 ['DGS1MO','UST 1m','rates','bp',2],['DGS6MO','UST 6m','rates','bp',2],['DGS1','UST 1y','rates','bp',2],['DGS3','UST 3y','rates','bp',2],['DGS7','UST 7y','rates','bp',2],['DGS20','UST 20y','rates','bp',2],
 ['DFII5','5y real (TIPS)','inflation','bp',2],['DFII7','7y real (TIPS)','inflation','bp',2],['DFII20','20y real (TIPS)','inflation','bp',2],['DFII30','30y real (TIPS)','inflation','bp',2],
 ['T5YIE','5y breakeven','inflation','bp',2],['BE_5Y','5y BE (calc)','inflation','bp',2],['BE_10Y_CALC','10y BE (calc)','inflation','bp',2],['BE_30Y','30y BE (calc)','inflation','bp',2],
 ['US_5Y_30Y','5s30s','rates','bp',2],['US_10Y_30Y','10s30s','rates','bp',2],['US_2Y_30Y','2s30s','rates','bp',2],['US_20Y_30Y','20s30s','rates','bp',2],
 ['DFEDTARL','Target range lower','policy','bp',2],['POLICY_PROXY_6M','Policy proxy 6m − funds','policy','bp',2],['POLICY_PROXY_1Y','Policy proxy 1y − funds','policy','bp',2],
 ['BAMLC0A1CAAA','AAA OAS','credit','bp',2],['BAMLC0A2CAA','AA OAS','credit','bp',2],['BAMLC0A3CA','A OAS','credit','bp',2],['BAMLC0A4CBBB','BBB OAS','credit','bp',2],['BAMLC1A0C13Y','IG 1-3y OAS','credit','bp',2],
 ['BAMLH0A1HYBB','BB OAS','credit','bp',2],['BAMLH0A2HYB','B OAS','credit','bp',2],['BAMLH0A3HYC','CCC & lower OAS','credit','bp',2],['BAMLHE00EHYIOAS','Euro HY OAS','credit','bp',2],['BAMLEMCBPIOAS','EM corp OAS','credit','bp',2],
 ['BAMLH0A0HYM2EY','HY effective yield','credit','bp',2],['BAMLC0A0CMEY','IG effective yield','credit','bp',2],
 ['G10Y_US','US 10y (OECD)','global','bp',2],['G10Y_DE','Germany 10y','global','bp',2],['G10Y_GB','UK 10y','global','bp',2],['G10Y_JP','Japan 10y','global','bp',2],['G10Y_AU','Australia 10y','global','bp',2],
 ['G10Y_CA','Canada 10y','global','bp',2],['G10Y_IT','Italy 10y','global','bp',2],['G10Y_FR','France 10y','global','bp',2],['G10Y_CH','Switzerland 10y','global','bp',2],['G10Y_ZA','South Africa 10y','global','bp',2],
 ['G10Y_DE_US','Bund − UST','global','bp',2],['G10Y_GB_US','Gilt − UST','global','bp',2],['G10Y_JP_US','JGB − UST','global','bp',2],['G10Y_AU_US','ACGB − UST','global','bp',2],['G10Y_CA_US','Canada − UST','global','bp',2],
 ['G10Y_IT_US','BTP − UST','global','bp',2],['G10Y_FR_US','OAT − UST','global','bp',2],['G10Y_CH_US','Swiss − UST','global','bp',2],['G10Y_ZA_US','SAGB − UST','global','bp',2],
 ['CPILFESL','Core CPI YoY %','macro','abs',1,1,'yoy'],
 ['DEXSDUS','USDSEK','fx','pct',4],['USDSGD_OANDA','USDSGD (OANDA)','fx','pct',4],['SORA_INDEX','SORA index','sg','pct',4],['SORA_VOL','SORA volume','sg','pct',0]]
PCT3Y_IDS = ['BAMLH0A0HYM2','BAMLC0A0CM','HY_IG_OAS','BAMLC0A1CAAA','BAMLC0A2CAA','BAMLC0A3CA','BAMLC0A4CBBB','BAMLC1A0C13Y','BAMLH0A1HYBB','BAMLH0A2HYB','BAMLH0A3HYC','BAMLHE00EHYIOAS','BAMLEMCBPIOAS','VIXCLS','DGS10','DFII10','T10YIE','US_10Y_2Y']
SERIES_EXTRA = [['UST 2y','DGS2',1],['UST 5y','DGS5',1],['UST 30y','DGS30',1],['5y real','DFII5',1],['10y real','DFII10',1],['30y real','DFII30',1],['5y BE','T5YIE',1],['10y BE','T10YIE',1],
 ['5s30s','US_5Y_30Y',1],['10s30s','US_10Y_30Y',1],['IG OAS','BAMLC0A0CM',1],['BBB OAS','BAMLC0A4CBBB',1],['BB OAS','BAMLH0A1HYBB',1],['CCC OAS','BAMLH0A3HYC',1],['DXY','DXY',1],['Target upper','DFEDTARU',1],
 ['Fed balance sheet $bn','WALCL',0.001],['Gold','GOLD',1],['Bitcoin','BTCUSD',1],['WTI','DCOILWTICO',1],['Copper/Gold x1000','CopperGold',1000],['SGS 10y','SGS_10Y',1],['6M T-bill','TBILL_6M',1],['STI','STI',1],
 ['USDJPY','DEXJPUS',1],['EURUSD','DEXUSEU',1],['Policy proxy 6m','POLICY_PROXY_6M',1],['G10Y US','G10Y_US',1],['G10Y DE','G10Y_DE',1],['G10Y GB','G10Y_GB',1],['G10Y JP','G10Y_JP',1]]

# --- load history
wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
ws = wb['MacroHistory']; rows = list(ws.iter_rows(values_only=True)); hdr = rows[0]
hist = {h:[] for h in hdr[1:]}
for r in rows[1:]:
    d = r[0]
    if not hasattr(d,'date'): continue
    d = d.date() if isinstance(d, dt.datetime) else d
    for i,h in enumerate(hdr[1:],1):
        v = r[i] if i < len(r) else None
        if isinstance(v,(int,float)) and math.isfinite(v): hist[h].append((d,float(v)))
for k in hist: hist[k].sort()
print('workbook series:', len(hist), 'rows:', len(rows)-1)

# --- fetch the v5 series from FRED (keyless graph CSV)
for sid, fid in NEW_FRED.items():
    if sid in hist and hist[sid]: continue
    try:
        txt = urllib.request.urlopen(f'https://fred.stlouisfed.org/graph/fredgraph.csv?id={fid}', timeout=30).read().decode()
        pts=[]
        for line in txt.splitlines()[1:]:
            d,v = line.split(',')[:2]
            try: pts.append((dt.date.fromisoformat(d), float(v)))
            except ValueError: pass
        hist[sid]=pts; print(f'  FRED {sid:<16} {len(pts):>6} obs  last {pts[-1] if pts else "—"}')
    except Exception as e: print('  FRED', sid, 'FAILED', e); hist[sid]=[]

# --- computed columns on the union of dates
alldates = sorted({d for pts in hist.values() for d,_ in pts})
by = {k:dict(v) for k,v in hist.items()}
for cid, fn in COMPUTED.items():
    out=[]
    for d in alldates:
        m = {k:by[k].get(d) for k in by}
        v = fn(m)
        if v is not None: out.append((d,v))
    hist[cid]=out

def idx_at_or_before(pts, t):
    lo,hi,ans=0,len(pts)-1,-1
    while lo<=hi:
        m=(lo+hi)//2
        if pts[m][0]<=t: ans=m; lo=m+1
        else: hi=m-1
    return ans
def yoy(pts):
    out=[]
    for d,v in pts:
        t=d.replace(year=d.year-1); j=idx_at_or_before(pts,t)
        if j<0 or pts[j][1]==0 or (d-pts[j][0]).days>400: continue
        out.append((d,(v/pts[j][1]-1)*100))
    return out
def stats(pts, mode, scale=1, transform=None):
    if transform=='yoy': pts=yoy(pts)
    if scale and scale!=1: pts=[(d,v*scale) for d,v in pts]
    n=len(pts)
    if not n: return None
    last=pts[-1]; prev=pts[-2] if n>1 else None; asof=last[0]
    def at(days):
        j=idx_at_or_before(pts, asof-dt.timedelta(days=days)); return pts[j][1] if j>=0 else None
    def back(k): return pts[-1-k][1] if n>k else None
    gaps=sorted((pts[i][0]-pts[i-1][0]).days for i in range(max(1,n-12),n)); spacing=gaps[len(gaps)//2] if gaps else 1
    v1w = None if spacing>=20 else (back(1) if spacing>=5 else at(7))
    v1m = back(1) if spacing>=20 else (back(4) if spacing>=5 else at(30))
    jy=idx_at_or_before(pts, dt.date(asof.year-1,12,31)); ytd=pts[jy][1] if jy>=0 else None
    w=[v for d,v in pts if d>=asof-dt.timedelta(days=365)]; hi,lo=max(w),min(w)
    pct=sum(1 for x in w if x<=last[1])/len(w)*100
    j1y=idx_at_or_before(pts, asof-dt.timedelta(days=365)); v1y=pts[j1y][1] if j1y>=0 and (asof-pts[j1y][0]).days<=400 else None
    def chg(old):
        if old is None: return ''
        if mode=='bp': return (last[1]-old)*100
        if mode=='pct': return (last[1]/old-1) if old else ''
        return last[1]-old
    return dict(asof=asof,last=last[1],prev=prev[1] if prev else '',d1=chg(prev[1] if prev else None),d1w=chg(v1w),d1m=chg(v1m),ytd=chg(ytd),
                pct=pct,hi=hi,lo=lo,pos=(last[1]-lo)/(hi-lo) if hi>lo else .5,n=n,cadence=spacing,v1m=v1m if v1m is not None else '',
                v1y=v1y if v1y is not None else '',spark=[v for _,v in pts[-SPARK_N:]])
def stale_limit(sid,cad):
    lim = 6 if cad<=3 else (18 if cad<=10 else cad*3+5)
    floor = 12 if (sid.startswith('DEX') or sid in('DTWEXBGS','DXY')) else 0
    return max(lim,floor)
def pct3y(sid):
    pts=hist.get(sid) or []
    if not pts: return ''
    last=pts[-1]; w=[v for d,v in pts if d>=last[0]-dt.timedelta(days=3*365)]
    return round(sum(1 for x in w if x<=last[1])/len(w)*1000)/10 if w else ''

# --- DashStats: keep the legacy rows exactly as the sheet has them, append PAGE rows
legacy = list(csv.reader(open(f'{OUT}/DashStats.csv')))
legacy = [legacy[0]] + [r for r in legacy[1:] if r and not str(r[2]).startswith('PAGE:')]   # idempotent: drop rows a previous build appended
hdr_out = legacy[0][:76]
rows_out = [r[:76] for r in legacy[1:]]
ext = []
legacy_asof = [dt.date.fromisoformat(r[3]) for r in legacy[1:] if r[3]]
allst=[]
LEGACY_SPEC={'WALCL':(0.001,None),'WTREGEN':(0.001,None),'Net_Liquidity':(0.001,None),'CopperGold':(1000,None),'ICSA':(0.001,None),'CPIAUCSL':(1,'yoy'),'PCEPILFE':(1,'yoy')}
for r in legacy[1:]:
    sid=r[0]; pts=hist.get(sid) or []; mode=r[15]; sc,tr=LEGACY_SPEC.get(sid,(1,None))
    s=stats(pts,mode,sc,tr) if pts else None
    allst.append((sid,s))
for item in PAGE_EXTRA:
    sid,label,group,mode,dec=item[:5]; scale=item[5] if len(item)>5 else 1; transform=item[6] if len(item)>6 else None
    s=stats(hist.get(sid) or [],mode,scale,transform)
    row=[sid,label,'PAGE:'+group, s['asof'].isoformat() if s else '', s['last'] if s else '', s['prev'] if s else '', s['d1'] if s else '', s['d1w'] if s else '', s['d1m'] if s else '', s['ytd'] if s else '',
         s['pct'] if s else '', s['hi'] if s else '', s['lo'] if s else '', s['pos'] if s else '', s['n'] if s else 0, mode]
    sp=s['spark'] if s else []; pad=SPARK_N-len(sp); row+=['']*pad+sp
    rows_out.append(row); allst.append((sid,s))
asof_all=max([s['asof'] for _,s in allst if s]+legacy_asof)
for i,(sid,s) in enumerate(allst):
    if not s: ext.append(['','','','','MISSING']); continue
    cad=s['cadence']; age=(TODAY-s['asof']).days; late=age>stale_limit(sid,cad)
    behind=(asof_all-s['asof']).days>3
    status='LATE' if late else ('MONTHLY' if cad>=20 else ('WEEKLY' if cad>=5 else ('BEHIND' if behind else 'FRESH')))
    ext.append([s['v1m'],s['v1y'],pct3y(sid) if sid in PCT3Y_IDS else '',round(cad*10)/10,status])
# pad to EXT_COL-1 columns then extension
hdr_full = hdr_out + ['']*(EXT_COL-1-len(hdr_out)) + ['v1m','v1y','pct3y','cadence','status']
hdr_full[78:82]=['ticker','value','up','down']   # CA:CD helper header, as the sheet has it
with open(f'{OUT}/DashStats.csv','w',newline='') as f:
    w=csv.writer(f,quoting=csv.QUOTE_ALL); w.writerow(hdr_full)
    for r,e in zip(rows_out,ext): w.writerow(r+['']*(EXT_COL-1-len(r))+e)
print('DashStats.csv', len(rows_out), 'rows x', len(hdr_full), 'cols')

# --- DashSeries: legacy columns from the sheet fixture, extra columns forward-filled
legacy_ds=list(csv.reader(open(f'{OUT}/DashSeries.csv')))
dates=[dt.date.fromisoformat(r[0]) for r in legacy_ds[1:]]
cutoff=TODAY-dt.timedelta(days=366)
extra_dates={d for h,sid,sc in SERIES_EXTRA for d,_ in (hist.get(sid) or []) if d>=cutoff}
alld=sorted(set(dates)|extra_dates)
leg={dt.date.fromisoformat(r[0]):r[1:9] for r in legacy_ds[1:]}
out=[['Date']+legacy_ds[0][1:9]+[h for h,_,_ in SERIES_EXTRA]]
ptr=[0]*len(SERIES_EXTRA); lastv=['']*len(SERIES_EXTRA); lastleg=['']*8
for d in alld:
    row=[d.isoformat()]
    if d in leg: lastleg=leg[d]
    row+=lastleg
    for i,(h,sid,sc) in enumerate(SERIES_EXTRA):
        pts=hist.get(sid) or []
        while ptr[i]<len(pts) and pts[ptr[i]][0]<=d: lastv[i]=pts[ptr[i]][1]*sc; ptr[i]+=1
        row.append(lastv[i])
    out.append(row)
with open(f'{OUT}/DashSeries.csv','w',newline='') as f:
    w=csv.writer(f,quoting=csv.QUOTE_ALL); w.writerows(out)
print('DashSeries.csv', len(out)-1, 'rows x', len(out[0]), 'cols')
with open(f'{OUT}/Meta.csv','w',newline='') as f:
    w=csv.writer(f,quoting=csv.QUOTE_ALL); w.writerows([['key','value'],['schema_version','5'],['generated_at',dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S')],['last_run','2026-09-14 14:19'],['last_complete','2026-09-14 14:19'],['timezone','Asia/Singapore'],['series_count',str(len(hist))]])
with open(f'{OUT}/Notes.csv','w',newline='') as f:
    w=csv.writer(f,quoting=csv.QUOTE_ALL); w.writerows([['key','text','date'],
      ['regime','Fixture note: the 10y move over the month is real-yield driven, not breakevens. The curve has bear-flattened; credit has not noticed.','2026-09-14'],
      ['rates','','' ],['rates.10Y','5% is the level that produced buying on Thursday; a clean break opens 5.25 on 2007 analogues.','2026-09-14'],['credit','','']])
print('Meta.csv, Notes.csv written')
