// Tests the INDstocks broker option of trade.php against a FAKE INDstocks API that follows the documented shapes (api-docs.indstocks.com).
// INDstocks has no sandbox, so nothing here can ever reach the real one: trade.php only uses the fake when the SIGNALS_TEST_* variables are set.
// usage: node tests/indstocks.test.js   (needs PHP on the PATH, or set PHP_EXE)
const http=require('http'),path=require('path'),fs=require('fs'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..'),PIN='2468',FAKE=8098;
const PHP=process.env.PHP_EXE||(()=>{const base=path.join(process.env.LOCALAPPDATA||'','Microsoft','WinGet','Packages');try{const d=fs.readdirSync(base).find(x=>x.startsWith('PHP.PHP.'));if(d)return path.join(base,d,'php.exe')}catch(e){}return'php'})();
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const jwt=(exp)=>b64({alg:'HS512',typ:'JWT'})+'.'+b64({clientID:'X',exp,iat:exp-50000,iss:'indmoney'})+'.fakesignature';
const GOOD=jwt(Math.floor(Date.now()/1000)+36000),EXPIRED=jwt(Math.floor(Date.now()/1000)-100),REJECTED=jwt(Math.floor(Date.now()/1000)+36000).replace('fakesignature','other');
let reqs=[];
const CONTRACTS={'NIFTY|2026-11-17|25050|CE':['45388',65],'NIFTY|2026-11-17|25000|PE':['45387',65],'BANKNIFTY|2026-11-24|60500|CE':['59001',30],'SENSEX|2026-11-12|82000|CE':['822217',20]};
const fake=http.createServer((q,s)=>{let b='';q.on('data',d=>b+=d).on('end',()=>{const u=new URL(q.url,'http://x');reqs.push({m:q.method,p:u.pathname,q:u.search,b,auth:q.headers.authorization||'',ver:q.headers['api-version']||''});
  const send=(c,j)=>{s.writeHead(c,{'Content-Type':'application/json'});s.end(JSON.stringify(j))},auth=q.headers.authorization||'';
  if(u.pathname==='/__log')return send(200,reqs);
  if(auth!==GOOD)return send(403,{status:'error',message:'Invalid token',error_type:'TokenException'});
  if(u.pathname==='/funds')return send(200,{status:'success',data:{sod_balance:20000,withdrawal_balance:1000,detailed_avl_balance:{option_buy:15000,eq_cnc:500}}});
  if(u.pathname==='/portfolio/positions')return send(200,{status:'success',data:[
    {security_id:'45388',symbol:'NIFTY',segment:'DERIVATIVE',product:'INTRADAY',exchange:'NSE',drv_option_type:'CE',drv_expiry_date:'2026-11-17',drv_strike_price:25050,net_qty:65,avg_price:200},
    {security_id:'822217',symbol:'SENSEX',segment:'DERIVATIVE',product:'MARGIN',exchange:'BSE',drv_option_type:'CE',drv_expiry_date:'2026-11-12',drv_strike_price:82000,net_qty:20,avg_price:300},
    {security_id:'45387',symbol:'NIFTY',segment:'DERIVATIVE',product:'INTRADAY',exchange:'NSE',drv_option_type:'PE',drv_expiry_date:'2026-11-17',drv_strike_price:25000,net_qty:0,avg_price:150}]});
  if(u.pathname==='/market/quotes/ltp'){const codes=(u.searchParams.get('scrip-codes')||'').split(',');if(codes.some(c=>c.startsWith('BFO_')))return send(400,{message:'Invalid scrip codes or mode',success:false});const d={};for(const c of codes)d[c]={live_price:215.5};return send(200,{status:'success',data:d})}
  if(u.pathname==='/order-book')return send(200,{status:'success',data:[
    {id:'DRV-1',security_id:'45388',exchange:'NSE',segment:'DERIVATIVE',txn_type:'BUY',name:'NIFTY-Nov2026-25050-CE',requested_qty:65,requested_price:200,traded_qty:65,traded_price:199.9,status:'SUCCESS',created_at:'2026-11-11T10:00:00'},
    {id:'DRV-2',security_id:'45388',exchange:'NSE',segment:'DERIVATIVE',txn_type:'SELL',name:'NIFTY-Nov2026-25050-CE',requested_qty:65,requested_price:250,traded_qty:0,traded_price:0,status:'O-PENDING',created_at:'2026-11-11T11:00:00'},
    {id:'EQ-3',security_id:'2885',exchange:'NSE',segment:'EQUITY',txn_type:'BUY',name:'RELIANCE',requested_qty:1,requested_price:1300,traded_qty:1,traded_price:1300,status:'SUCCESS',created_at:'2026-11-11T09:30:00'}]});
  if(u.pathname==='/market/instruments/search'){const k=[u.searchParams.get('underlying'),u.searchParams.get('expiry'),+u.searchParams.get('strike_from'),u.searchParams.get('option_type')].join('|'),c=CONTRACTS[k];
    return send(200,{status:'success',data:{count:c?1:0,page:1,page_size:50,instruments:c?[{security_id:c[0],trading_symbol:'X',expiry:u.searchParams.get('expiry'),strike_price:+u.searchParams.get('strike_from'),option_type:u.searchParams.get('option_type'),lot_size:c[1]}]:[]}})}
  if(u.pathname==='/order'&&q.method==='POST')return send(200,{status:'success',data:{order_id:'DRV-'+(100+reqs.length),order_status:'O-PENDING'}});
  if(u.pathname==='/order/cancel'&&q.method==='POST')return send(200,{status:'success',data:{order_id:JSON.parse(b).order_id,order_status:'CANCELLED'}});
  send(404,{status:'error',message:'unknown'})})});
let pass=0,fail=0;const t=(n,c,x)=>{if(c){pass++;console.log('  ok  ',n)}else{fail++;console.log('  FAIL',n,x!==undefined?JSON.stringify(x):'')}};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function startPhp(port,mode){const data=fs.mkdtempSync(path.join(os.tmpdir(),'sigind-'));const p=spawn(PHP,['-S','127.0.0.1:'+port,'-t',ROOT],{cwd:ROOT,env:{...process.env,SIGNALS_TEST_UPSTOX:'http://127.0.0.1:'+FAKE,SIGNALS_TEST_MODE:mode,SIGNALS_TEST_BROKER:'indstocks',SIGNALS_TEST_DATA:data},stdio:'ignore'});return{p,data}}
async function api(port,qs,{method='GET',body,pin=PIN}={}){const r=await fetch(`http://127.0.0.1:${port}/api.php?${qs}`,{method,headers:{'X-App-Pin':pin,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const txt=await r.text();let j;try{j=JSON.parse(txt)}catch(e){j={raw:txt}}return{s:r.status,j}}
let n=0;const nifty={u:'NIFTY',e:'2026-11-17',k:25050,t:'CE'};
const ord=(o={})=>({instrument_token:'NSE_FO|45388',quantity:65,transaction_type:'BUY',order_type:'LIMIT',product:'I',price:200.05,ref:'ind-'+(++n)+'-'+Date.now(),label:'NIFTY 25050 CE',contract:nifty,...o});
(async()=>{fake.listen(FAKE,'127.0.0.1');console.log('PHP:',PHP);
  let S=startPhp(8121,'dry');await sleep(1300);const D=8121;console.log('\nINDstocks, dry mode');
  let r=await api(D,'trade=status');t('status says indstocks, paste-a-token, not connected',r.j.broker==='indstocks'&&r.j.tokenMode==='paste'&&r.j.connected===false&&r.j.configured===true,r.j);
  r=await api(D,'trade=login');t('no OAuth login for INDstocks',r.s===400&&/paste/i.test(r.j.message),r);
  r=await api(D,'trade=settoken',{method:'POST',body:{token:'not-a-token'}});t('a malformed token is refused',r.s===422,r);
  r=await api(D,'trade=settoken',{method:'POST',body:{token:EXPIRED}});t('an expired token is refused',r.s===422&&/expired/.test(r.j.message),r);
  r=await api(D,'trade=settoken',{method:'POST',body:{token:REJECTED}});t('a token INDstocks rejects is refused and not saved',r.s===422&&/did not accept/.test(r.j.message),r);
  r=await api(D,'trade=status');t('still not connected',r.j.connected===false);
  r=await api(D,'trade=settoken',{method:'POST',body:{token:GOOD}});t('a good token is accepted',r.s===200&&r.j.expires>Date.now()/1000,r);
  const tf=fs.readFileSync(path.join(S.data,'order-token-ind.php'),'utf8');t('token file starts with the exit line and the token is never returned to the page',tf.startsWith('<?php http_response_code(404); exit; ?>')&&!JSON.stringify(r.j).includes('fakesignature'));
  const f1=reqs.filter(x=>x.p==='/funds').pop();t('INDstocks gets the RAW token (no Bearer) and API-Version v1',f1&&f1.auth===GOOD&&f1.ver==='v1',f1);
  r=await api(D,'trade=status');t('status now connected',r.j.connected===true,r.j);
  r=await api(D,'trade=funds');t('funds map to available_to_trade (option buying balance)',r.j.data.available_to_trade.total===15000,r);
  r=await api(D,'trade=positions');const P=r.j.data;t('positions are normalised: two open option rows, zero-quantity row dropped',Array.isArray(P)&&P.length===2,P);
  t('NSE position: key, symbol, product, quantity, average, last price, pnl',P[0].instrument_token==='NSE_FO|45388'&&/NIFTY 25050 CE 17 NOV 26/.test(P[0].trading_symbol)&&P[0].product==='I'&&P[0].quantity===65&&P[0].average_price===200&&P[0].last_price===215.5&&Math.abs(P[0].pnl-1007.5)<1e-6,P[0]);
  t('BSE position: key and overnight product, last price unavailable (BFO quote refused) does not break the list',P[1].instrument_token==='BSE_FO|822217'&&P[1].product==='D'&&P[1].last_price===0,P[1]);
  r=await api(D,'trade=orders');t('orders list keeps derivatives only, newest first, with mapped status',r.j.data.length===2&&r.j.data[0].order_id==='DRV-2'&&r.j.data[0].status==='o-pending'&&r.j.data[1].status==='complete'&&r.j.data[1].filled_quantity===65&&r.j.data[1].instrument_token==='NSE_FO|45388',r.j.data);
  r=await api(D,'trade=order&order_id=DRV-1');t('single order status from the order book',r.j.data.status==='complete'&&r.j.data.average_price===199.9,r);
  const before=reqs.length;
  r=await api(D,'trade=place',{method:'POST',body:ord()});t('valid BUY with the matching contract passes in dry mode',r.s===200&&r.j.mode==='dry'&&/INDstocks/.test(r.j.note),r);
  t('dry mode sent no order to INDstocks',!reqs.slice(before).some(x=>x.p==='/order'));
  const rej=async(name,o,re)=>{await sleep(3200);const x=await api(D,'trade=place',{method:'POST',body:ord(o)});t(name,x.s===422&&(!re||re.test(x.j.message)),x)};
  await rej('BUY without contract details refused',{contract:undefined},/contract details/);
  await rej('a contract id that does not match the strike is refused',{instrument_token:'NSE_FO|45387'},/does not match/);
  await rej('a strike INDstocks does not list is refused',{contract:{...nifty,k:25075},instrument_token:'NSE_FO|45389'},/no such contract/);
  await rej('quantity that is not a lot multiple is refused',{quantity:70},/lot size \(65\)/);
  await rej('an unlisted contract is refused',{contract:{...nifty,u:'RELIANCE'}},/limited to Nifty|no such contract/);
  await rej('Sensex contract with an NSE id is refused',{contract:{u:'SENSEX',e:'2026-11-12',k:82000,t:'CE'}},/does not belong/);
  await rej('stop orders are refused (not offered by INDstocks for a position)',{transaction_type:'SELL',order_type:'SL',price:119.95,trigger_price:120},/no stop order/);
  await rej('market-style or off-tick price refused',{price:200.03},/0\.05/);
  await sleep(3200);r=await api(D,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:65,contract:undefined})});t('sell of the held 65 passes',r.s===200,r);
  await rej('sell of more than held refused',{transaction_type:'SELL',quantity:130,contract:undefined},/hold only 65/);
  await rej('sell with the wrong product refused',{transaction_type:'SELL',quantity:65,product:'D',contract:undefined},/no long position|hold/);
  await rej('sell of a contract not held refused',{transaction_type:'SELL',instrument_token:'NSE_FO|99999',quantity:65,contract:undefined},/no long position/);
  r=await api(D,'trade=cancel&order_id=DRV-2',{method:'DELETE'});t('cancel in dry mode sends nothing',r.s===200&&r.j.mode==='dry'&&!reqs.some(x=>x.p==='/order/cancel'),r);
  t('no order was ever POSTed to the fake INDstocks in dry mode',!reqs.some(x=>x.p==='/order'&&x.m==='POST'));
  S.p.kill();
  S=startPhp(8122,'live');await sleep(1300);const L=8122;console.log('\nINDstocks, live mode (fake INDstocks only)');
  r=await api(L,'trade=place',{method:'POST',body:ord()});t('live order without a token is refused (422)',(r.s===422||r.s===401)&&/Paste/.test(r.j.message),r);
  await api(L,'trade=settoken',{method:'POST',body:{token:GOOD}});reqs.length=0;await sleep(3200);
  r=await api(L,'trade=place',{method:'POST',body:ord({price:201.5})});t('live BUY goes through and returns the order id',r.s===200&&r.j.mode==='live'&&/^DRV-/.test(r.j.data.order_ids[0]),r);
  let po=reqs.filter(x=>x.p==='/order'&&x.m==='POST').pop(),body=po&&JSON.parse(po.b);
  t('order body follows the INDstocks format (NSE, INTRADAY, 99999)',body&&body.txn_type==='BUY'&&body.exchange==='NSE'&&body.segment==='DERIVATIVE'&&body.product==='INTRADAY'&&body.order_type==='LIMIT'&&body.validity==='DAY'&&body.security_id==='45388'&&body.qty===65&&body.limit_price===201.5&&body.is_amo===false&&body.algo_id==='99999'&&body.remarks==='IDXSIG',body);
  t('the order carries the raw token and API-Version',po.auth===GOOD&&po.ver==='v1');
  await sleep(3200);r=await api(L,'trade=place',{method:'POST',body:ord({instrument_token:'BSE_FO|822217',quantity:20,product:'D',price:300.05,contract:{u:'SENSEX',e:'2026-11-12',k:82000,t:'CE'}})});
  po=reqs.filter(x=>x.p==='/order'&&x.m==='POST').pop();body=JSON.parse(po.b);t('Sensex goes to BSE with the BSE algo id and the overnight product MARGIN',r.s===200&&body.exchange==='BSE'&&body.security_id==='822217'&&body.product==='MARGIN'&&body.algo_id==='9999999999999999'&&body.qty===20,body);
  await sleep(3200);r=await api(L,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:130,contract:undefined})});t('live sell above the holding is refused before reaching INDstocks',r.s===422&&reqs.filter(x=>x.p==='/order'&&x.m==='POST').length===2,r);
  await sleep(3200);r=await api(L,'trade=place',{method:'POST',body:ord({transaction_type:'SELL',quantity:65,price:250,contract:undefined})});body=JSON.parse(reqs.filter(x=>x.p==='/order'&&x.m==='POST').pop().b);t('live sell of the held quantity is sent',r.s===200&&body.txn_type==='SELL'&&body.qty===65&&body.limit_price===250,body);
  r=await api(L,'trade=cancel&order_id=DRV-2',{method:'DELETE'});const cb=reqs.find(x=>x.p==='/order/cancel');t('live cancel posts order_id and segment',r.s===200&&cb&&JSON.parse(cb.b).order_id==='DRV-2'&&JSON.parse(cb.b).segment==='DERIVATIVE',cb);
  S.p.kill();fake.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)})();
