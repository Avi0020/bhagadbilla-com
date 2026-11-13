// Tests the optional Upstox order connection (trade.php) against a FAKE Upstox server. Nothing here can reach the real Upstox:
// trade.php only talks to the fake when the SIGNALS_TEST_* environment variables are set, which only this test does.
// usage: node tests/trade.test.js        (needs PHP on the PATH, or set PHP_EXE)
const http=require('http'),path=require('path'),fs=require('fs'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..'),PIN='2468';
const PHP=process.env.PHP_EXE||(()=>{const base=path.join(process.env.LOCALAPPDATA||'','Microsoft','WinGet','Packages');try{const d=fs.readdirSync(base).find(x=>x.startsWith('PHP.PHP.'));if(d)return path.join(base,d,'php.exe')}catch(e){}return'php'})();
const reqs=[];let heldQty=65;
const fake=http.createServer((q,s)=>{let b='';q.on('data',d=>b+=d).on('end',()=>{const u=new URL(q.url,'http://x'),auth=q.headers.authorization||'';reqs.push({m:q.method,p:u.pathname,q:u.search,b,auth});
  const send=(c,j)=>{s.writeHead(c,{'Content-Type':'application/json'});s.end(JSON.stringify(j))},ok=auth==='Bearer MOCKTOKEN';
  if(u.pathname==='/__log'){return send(200,reqs)}
  if(u.pathname==='/v2/login/authorization/token'){const f=new URLSearchParams(b);return f.get('code')==='goodcode'&&f.get('client_id')==='test-id'&&f.get('client_secret')==='test-secret'&&f.get('grant_type')==='authorization_code'?send(200,{access_token:'MOCKTOKEN',user_name:'Test User'}):send(401,{status:'error',errors:[{message:'bad code'}]})}
  if(!ok)return send(401,{status:'error',errors:[{message:'bad token'}]});
  if(u.pathname==='/v3/user/get-funds-and-margin')return send(200,{status:'success',data:{available_to_trade:{total:12345.6}}});
  if(u.pathname==='/v2/portfolio/short-term-positions')return send(200,{status:'success',data:[{instrument_token:'NSE_FO|45388',trading_symbol:'NIFTY 25000 CE',quantity:heldQty,average_price:100,last_price:110,pnl:650,product:'I'},{instrument_token:'NSE_EQ|INE002A01018',trading_symbol:'RELIANCE',quantity:10,average_price:1300,last_price:1310,pnl:100,product:'D'}]});
  if(u.pathname==='/v2/order/retrieve-all')return send(200,{status:'success',data:[{order_id:'MOCK1',status:'complete',transaction_type:'BUY'}]});
  if(u.pathname==='/v2/order/details')return send(200,{status:'success',data:{order_id:u.searchParams.get('order_id'),status:'complete',filled_quantity:65,average_price:100.05}});
  if(u.pathname==='/v3/order/place'&&q.method==='POST')return send(200,{status:'success',data:{order_ids:['MOCK-'+reqs.length]}});
  if(u.pathname==='/v3/order/cancel'&&q.method==='DELETE')return send(200,{status:'success',data:{order_id:u.searchParams.get('order_id')}});
  send(404,{status:'error',errors:[{message:'unknown'}]})})});
let pass=0,fail=0;const t=(name,cond,extra)=>{if(cond){pass++;console.log('  ok  ',name)}else{fail++;console.log('  FAIL',name,extra!==undefined?JSON.stringify(extra):'')}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function startPhp(port,mode){const data=fs.mkdtempSync(path.join(os.tmpdir(),'sig-'));
  const p=spawn(PHP,['-S','127.0.0.1:'+port,'-t',ROOT],{cwd:ROOT,env:{...process.env,SIGNALS_TEST_UPSTOX:'http://127.0.0.1:8097',SIGNALS_TEST_MODE:mode,SIGNALS_TEST_DATA:data},stdio:'ignore'});return{p,data,port}}
async function api(port,qs,{method='GET',body,pin=PIN}={}){const r=await fetch(`http://127.0.0.1:${port}/api.php?${qs}`,{method,headers:{'X-App-Pin':pin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const txt=await r.text();let j;try{j=JSON.parse(txt)}catch(e){j={raw:txt}}return{s:r.status,j,txt}}
let n=0;const ord=(o={})=>({instrument_token:'NSE_FO|45388',quantity:65,transaction_type:'BUY',order_type:'LIMIT',product:'I',price:100.05,ref:'ref-'+(++n)+'-'+Date.now(),label:'NIFTY 25000 CE',...o});
async function login(port){const l=await api(port,'trade=login');const url=new URL(l.j.url);const st=url.searchParams.get('state');
  const cb=await fetch(`http://127.0.0.1:${port}/api.php?callback=1&code=goodcode&state=${st}`);const html=await cb.text();return{l,url,st,html,replay:await (await fetch(`http://127.0.0.1:${port}/api.php?callback=1&code=goodcode&state=${st}`)).text()}}
(async()=>{fake.listen(8097,'127.0.0.1');
  console.log('PHP:',PHP);
  // ---------- OFF ----------
  let S=startPhp(8101,'off');await sleep(1200);console.log('\nmode off');
  let r=await api(8101,'trade=status');t('status says off',r.j.mode==='off',r.j);
  r=await api(8101,'trade=place',{method:'POST',body:ord()});t('place refused (403)',r.s===403,r);
  r=await api(8101,'trade=login');t('login refused',r.s===403,r);
  r=await api(8101,'trade=status',{pin:'0000'});t('wrong PIN is refused',r.s===401,r);
  let cb=await fetch('http://127.0.0.1:8101/api.php?callback=1&code=goodcode&state=x');t('callback refused when off',(await cb.text()).includes('switched off'));
  S.p.kill();
  // ---------- DRY ----------
  S=startPhp(8102,'dry');await sleep(1200);console.log('\nmode dry (no token yet)');const D=8102;
  r=await api(D,'trade=status');t('status says dry, not connected',r.j.mode==='dry'&&r.j.connected===false,r.j);
  const before=reqs.length;
  r=await api(D,'trade=place',{method:'POST',body:ord()});t('valid BUY passes in dry mode',r.s===200&&r.j.mode==='dry'&&/^DRY/.test(r.j.data.order_ids[0]),r);
  t('dry mode sent NOTHING to Upstox',reqs.length===before,reqs.slice(before));
  const rej=async(name,o,re)=>{await sleep(3200);const x=await api(D,'trade=place',{method:'POST',body:ord(o)});t(name,x.s===422&&(!re||re.test(x.j.message)),x)};
  await rej('market order refused',{order_type:'MARKET'},/limit/i);
  await rej('price off the 0.05 tick refused',{price:100.03},/0\.05/);
  await rej('equity instrument refused',{instrument_token:'NSE_EQ|INE002A01018'},/option/i);
  await rej('order above the value cap refused',{quantity:5000,price:100},/limit of Rs/);
  await rej('quantity above the cap refused',{quantity:6000,price:1},/Quantity/);
  await rej('bad product refused',{product:'MTF'},/Product/);
  await rej('SL sell with limit above trigger refused',{transaction_type:'SELL',order_type:'SL',price:61,trigger_price:60},/limit price cannot be above/);
  const fixed=ord();await sleep(3200);r=await api(D,'trade=place',{method:'POST',body:fixed});t('fresh ref accepted',r.s===200,r);
  await sleep(3200);r=await api(D,'trade=place',{method:'POST',body:fixed});t('same reference cannot be sent twice',r.s===422&&/already sent/.test(r.j.message),r);
  await sleep(3200);await api(D,'trade=place',{method:'POST',body:ord()});r=await api(D,'trade=place',{method:'POST',body:ord()});t('orders too close together refused',r.s===422&&/Wait/.test(r.j.message),r);
  const lg=fs.readFileSync(path.join(S.data,'orders.log.php'),'utf8').trim().split('\n').slice(1).map(x=>JSON.parse(x));t('every attempt is logged',lg.length>=9&&lg.some(x=>x.ev==='dry-order')&&lg.some(x=>x.ev==='rejected'),lg.length);
  console.log('\nlogin flow (dry)');const lo=await login(D);
  t('login URL points at Upstox dialog with a state',lo.url.pathname.endsWith('/v2/login/authorization/dialog')&&lo.url.searchParams.get('client_id')==='test-id'&&lo.st.length>=16,lo.l.j);
  t('callback with the right state connects',lo.html.includes('Connected to Upstox'),lo.html.slice(0,200));
  t('callback state works only once',lo.replay.includes('not accepted')||lo.replay.includes('not valid'),lo.replay.slice(0,200));
  const bad=await fetch(`http://127.0.0.1:${D}/api.php?callback=1&code=goodcode&state=forged`);t('forged state is refused',(await bad.text()).includes('not accepted'));
  t('token file starts with an exit line, so a browser would show nothing',fs.readFileSync(path.join(S.data,'order-token.php'),'utf8').startsWith('<?php http_response_code(404); exit; ?>'));
  const ft=await fetch('http://127.0.0.1:'+D+'/data/order-token.php');t('opening the token file over the web shows nothing',(await ft.text()).trim()===''||ft.status===404);
  r=await api(D,'trade=status');t('status now connected',r.j.connected===true&&r.j.user==='Test User',r.j);
  r=await api(D,'trade=funds');t('funds read',r.j.data&&r.j.data.available_to_trade.total===12345.6,r);
  r=await api(D,'trade=positions');t('positions read, only option contracts',r.j.data.length===1&&r.j.data[0].instrument_token==='NSE_FO|45388'&&r.j.data[0].quantity===65,r);
  r=await api(D,'trade=orders');t('orders read',r.j.data[0].order_id==='MOCK1',r);
  r=await api(D,'trade=order&order_id=MOCK1');t('order status read',r.j.data.status==='complete',r);
  console.log('\nselling only to close (dry, connected)');
  await sleep(3200);r=await api(D,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:65})});t('sell of the held 65 passes',r.s===200,r);
  await rej('sell of more than held refused',{transaction_type:'SELL',quantity:130},/hold only 65/);
  await rej('sell with the wrong product refused',{transaction_type:'SELL',quantity:65,product:'D'},/no long position|hold/);
  await rej('sell of a contract not held refused',{transaction_type:'SELL',instrument_token:'NSE_FO|99999',quantity:65},/no long position/);
  await sleep(3200);r=await api(D,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:65,order_type:'SL',price:59.95,trigger_price:60})});t('stop-loss sell passes',r.s===200,r);
  r=await api(D,'trade=cancel&order_id=MOCK1',{method:'DELETE'});t('cancel in dry mode sends nothing',r.s===200&&r.j.mode==='dry'&&!reqs.some(x=>x.m==='DELETE'),r);
  t('no order was ever POSTed to the fake Upstox while in dry mode',!reqs.some(x=>x.p==='/v3/order/place'));
  S.p.kill();
  // ---------- LIVE (against the fake only) ----------
  S=startPhp(8103,'live');await sleep(1200);console.log('\nmode live (fake Upstox)');const L=8103;
  r=await api(L,'trade=place',{method:'POST',body:ord()});t('live order without a login is refused (422)',r.s===422||r.s===401,r);
  await login(L);reqs.length=0;await sleep(3200);
  r=await api(L,'trade=place',{method:'POST',body:ord({price:101.5})});t('live BUY goes through',r.s===200&&r.j.mode==='live'&&r.j.data.order_ids.length===1,r);
  const po=reqs.find(x=>x.p==='/v3/order/place');const body=po&&JSON.parse(po.b);
  t('order body matches the Upstox v3 format',body&&body.quantity===65&&body.product==='I'&&body.validity==='DAY'&&body.price===101.5&&body.tag==='IDXSIG'&&body.instrument_token==='NSE_FO|45388'&&body.order_type==='LIMIT'&&body.transaction_type==='BUY'&&body.trigger_price===0&&body.is_amo===false&&body.slice===false&&body.disclosed_quantity===0,body);
  t('order carries the Bearer token',po&&po.auth==='Bearer MOCKTOKEN');
  await sleep(3200);r=await api(L,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:130})});t('live sell above holding refused before reaching Upstox',r.s===422&&reqs.filter(x=>x.p==='/v3/order/place').length===1,r);
  await sleep(3200);r=await api(L,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:65,order_type:'SL',price:59.95,trigger_price:60})});const sl=JSON.parse(reqs.filter(x=>x.p==='/v3/order/place').pop().b);t('live stop-loss sell carries its trigger',r.s===200&&sl.order_type==='SL'&&sl.trigger_price===60&&sl.price===59.95&&sl.transaction_type==='SELL',sl);
  r=await api(L,'trade=cancel&order_id=MOCK-9',{method:'DELETE'});t('live cancel reaches Upstox',r.s===200&&reqs.some(x=>x.m==='DELETE'&&x.q.includes('MOCK-9')),r);
  for(let i=0;i<8;i++){await sleep(3200);await api(L,'trade=place',{method:'POST',body:ord({price:100+i*.05})})}
  await sleep(3200);r=await api(L,'trade=place',{method:'POST',body:ord()});t('daily order limit stops further orders',r.s===422&&/Daily order limit/.test(r.j.message),r);
  S.p.kill();fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)})();
