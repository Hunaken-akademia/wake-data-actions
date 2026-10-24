"""Finite, resumable public-data archive. Never substitute closing odds for pre-deadline odds."""
import argparse,asyncio,aiohttp,base64,collections,csv,datetime,gzip,hashlib,io,json,math,sqlite3,time
from pathlib import Path
URL='https://kyoteibiyori.com/request_odds_shousai.php'
KEYS=[f'{a}{b}{c}' for a in range(1,7) for b in range(1,7) for c in range(1,7) if a!=b and a!=c and b!=c]
INDEX={v:i for i,v in enumerate(KEYS)}
def now():return datetime.datetime.now(datetime.timezone.utc).isoformat()
def positive(v):return len(v)==120 and all(isinstance(a,(float,int)) and math.isfinite(a) and a>0 for a in v)
def normalize(o,x):
 if not isinstance(o,dict):return 'unavailable',{'reason':'no_history_response'}
 groups={}
 for v in o.get('jikan_odds_list') or []:
  if not isinstance(v,dict) or int(v.get('type',-1))!=0:continue
  if (int(v.get('hiduke',0)),int(v.get('place_no',0)),int(v.get('race_no',0)))!=(int(x['d'].replace('-','')),x['p'],x['r']):raise ValueError('race_identity_mismatch')
  minute=int(v['shimekiri'])
  if minute<=0:continue
  key=str(v['kumiawase']).zfill(3)
  if key not in INDEX:continue
  a=groups.setdefault(str(minute),[None]*120);j=INDEX[key]
  if a[j] is not None:raise ValueError('duplicate_ticket')
  try:a[j]=float(v['odds'])
  except (TypeError,ValueError):a[j]=None
 good=[int(m) for m,a in groups.items() if positive(a)];best=min(good,key=lambda m:abs(m-5)) if good else None
 return ('usable' if best is not None else 'incomplete' if groups else 'unavailable'),{'kind':'source_labeled_history','snapshots':groups,'preferred_labeled_minutes':best,'actual_capture_timestamp_available':False,'raw_sha256':hashlib.sha256(json.dumps(o,sort_keys=True,separators=(',',':')).encode()).hexdigest()}
def target_list(path):return json.loads(gzip.decompress(base64.b64decode(Path(path).read_text())))
def connect(state):
 state.mkdir(parents=True,exist_ok=True);p=state/'collection.sqlite'
 if not p.exists() and (state/'collection.sqlite.gz').exists():p.write_bytes(gzip.decompress((state/'collection.sqlite.gz').read_bytes()))
 db=sqlite3.connect(p);db.execute('pragma journal_mode=WAL');db.execute('create table if not exists records(d text,p int,r int,status text,source text,payload text,retrieved_at text,primary key(d,p,r))');db.execute('create table if not exists metadata(k text primary key,v text)');return db
def put(db,x,status,source,payload):db.execute('insert or replace into records values(?,?,?,?,?,?,?)',(x['d'],x['p'],x['r'],status,source,json.dumps(payload,ensure_ascii=False,separators=(',',':')),now()))
def status(db,targets,**extra):
 counts=dict(db.execute('select status,count(*) from records group by status'));total=sum(counts.values());o={'period':[targets[0]['d'],targets[-1]['d']],'target':len(targets),'processed':total,'pending':len(targets)-total,'usable':counts.get('usable',0),'unavailable':counts.get('unavailable',0),'incomplete':counts.get('incomplete',0),'failed':counts.get('failed',0),'complete':total==len(targets),'updated_at':now(),**extra};return o
def pack(db,state,out,targets,extra=None):
 out.mkdir(parents=True,exist_ok=True);db.commit();s=status(db,targets,**(extra or {}));(out/'progress.json').write_text(json.dumps(s,ensure_ascii=False,indent=2));db.execute('pragma wal_checkpoint(TRUNCATE)')
 with open(state/'collection.sqlite','rb') as src,gzip.open(out/'collection.sqlite.gz','wb',compresslevel=6) as dst:
  import shutil;shutil.copyfileobj(src,dst)
 if s['complete']:
  with gzip.open(out/'predeadline_odds_20251024_20261023.jsonl.gz','wt',encoding='utf8') as f:
   f.write(json.dumps({'format':'wake-predeadline-year-v1','period':s['period'],'tickets':['-'.join(k) for k in KEYS],'note':'source-labeled 5/10/20/30-min data and timestamped snapshots are distinguished; no closing-odds substitution'},ensure_ascii=False)+'\n')
   for d,p,r,st,source,pl,got in db.execute('select * from records order by d,p,r'):f.write(json.dumps({'d':d,'p':p,'r':r,'status':st,'source':source,'retrieved_at':got,**json.loads(pl)},ensure_ascii=False,separators=(',',':'))+'\n')
 print(json.dumps(s,ensure_ascii=False),flush=True);return s
async def seed(session,db,targets):
 wanted={(r['d'],r['p'],r['r']) for r in targets};d=datetime.date(2026,7,19);end=datetime.date(2026,10,23)
 while d<=end:
  url='https://boatracecsv.github.io/data/previews/od3/'+d.strftime('%Y/%m/%d')+'.csv'
  try:
   async with session.get(url) as resp:
    if resp.status==200:
     content=await resp.text()
     for r in csv.DictReader(io.StringIO(content)):
      try:
       key=(r['レース日'],int(r['レース場']),int(r['レース回'].removesuffix('R')))
       if key not in wanted:continue
       got=datetime.datetime.fromisoformat(r['取得日時']);deadline=datetime.datetime.fromisoformat(r['レース日']+'T'+r['締切時刻']+':00+09:00');values=[float(r['3連単_'+'-'.join(k)]) for k in KEYS]
       if got<deadline and positive(values):put(db,{'d':key[0],'p':key[1],'r':key[2]},'usable','BoatraceCSV',{'kind':'captured_snapshot','captured_at':got.isoformat(),'deadline':deadline.isoformat(),'offset_min':(deadline-got).total_seconds()/60,'odds':values})
      except (TypeError,ValueError,KeyError):continue
  except (TimeoutError,aiohttp.ClientError):pass
  db.commit();d+=datetime.timedelta(days=1);await asyncio.sleep(.5)
 print('seeded_public_records',db.execute('select count(*) from records').fetchone()[0],flush=True)
async def collect(args):
 targets=target_list(args.targets);state=Path(args.state);out=Path(args.out);db=connect(state)
 if args.pack_only:
  previous=json.loads((out/'progress.json').read_text()) if (out/'progress.json').exists() else {}
  extra={k:previous[k] for k in ['requires_attention','stop_reason','requests_this_chunk','source_rate_limit_count'] if k in previous}
  return pack(db,state,out,targets,extra)
 start=time.monotonic();stop_at=start+args.budget_seconds;attention=False;reason='chunk_time_budget';requests=0;rate_hits=0;consecutive_failures=0;lastlog=0.
 timeout=aiohttp.ClientTimeout(total=30,connect=15)
 async with aiohttp.ClientSession(trust_env=True,cookie_jar=aiohttp.DummyCookieJar(),connector=aiohttp.TCPConnector(limit=1),timeout=timeout,headers={'Referer':'https://kyoteibiyori.com/','User-Agent':'WAKE-Predeadline-Archive/1.0'}) as session:
  if db.execute('select count(*) from records').fetchone()[0]==0:await seed(session,db,targets)
  done={(d,p,r) for d,p,r in db.execute('select d,p,r from records')};pending=[x for x in targets if (x['d'],x['p'],x['r']) not in done]
  for x in pending:
   if time.monotonic()>=stop_at:break
   status_value=None;payload=None
   for retry in range(2):
    if time.monotonic()>=stop_at:break
    await asyncio.sleep(args.interval);requests+=1
    try:
     async with session.post(URL,data={'data':json.dumps({'place_no':str(x['p']),'race_no':str(x['r']),'hiduke':x['d'].replace('-','')})}) as resp:
      raw=await resp.read()
      if resp.status in [401,403]:attention=True;reason='source_access_denied';break
      if resp.status==429:
       rate_hits+=1;reason='source_rate_limited'
       if rate_hits>=3:attention=True;break
       try:delay=max(120,float(resp.headers.get('Retry-After','120')))
       except ValueError:delay=120
       print('rate limited; waiting',delay,'seconds',flush=True);await asyncio.sleep(min(delay,max(0,stop_at-time.monotonic())));continue
      if resp.status!=200:raise RuntimeError('source_http_'+str(resp.status))
      status_value,payload=normalize(json.loads(raw),x);consecutive_failures=0;break
    except (TimeoutError,aiohttp.ClientError,ValueError,TypeError,RuntimeError) as e:
     if retry:status_value='failed';payload={'reason':str(e)};consecutive_failures+=1
   if attention:break
   if status_value is not None:put(db,x,status_value,'KyoteiBiyori',payload)
   if consecutive_failures>=10:attention=True;reason='repeated_source_errors';break
   if time.monotonic()-lastlog>60:
    db.commit();o=status(db,targets,requests_this_chunk=requests,source_rate_limit_count=rate_hits);out.mkdir(parents=True,exist_ok=True);(out/'progress.json').write_text(json.dumps(o,indent=2));print(json.dumps(o),flush=True);lastlog=time.monotonic()
 result=pack(db,state,out,targets,{'requires_attention':attention,'stop_reason':reason,'requests_this_chunk':requests,'source_rate_limit_count':rate_hits});db.close();return result
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--targets',required=True);p.add_argument('--state',default='state');p.add_argument('--out',default='out');p.add_argument('--budget-seconds',type=int,default=17400);p.add_argument('--interval',type=float,default=7.0);p.add_argument('--pack-only',action='store_true');args=p.parse_args()
 if args.interval<7:raise SystemExit('Minimum interval is 7 seconds; do not bypass provider rate limits.')
 asyncio.run(collect(args))
