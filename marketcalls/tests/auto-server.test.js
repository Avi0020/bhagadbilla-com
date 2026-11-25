// Tests the automatic-trading rules of trade.php (smart order with attached stop and target, modify, cancel, kill switch, ledger, limits) against a FAKE INDstocks
// that follows the documented smart-order shapes. INDstocks has no sandbox, so nothing here can reach the real one: trade.php only uses the fake when SIGNALS_TEST_* is set.
// usage: node tests/auto-server.test.js   (needs PHP on the PATH, or set PHP_EXE)
const http=require('http'),path=require('path'),fs=require('fs'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..'),PIN='2468',FAKE=8099;
const PHP=process.env.PHP_EXE||(()=>{const base=path.join(process.env.LOCALAPPDATA||'','Microsoft','WinGet','Packages');try{const d=fs.readdirSync(base).find(x=>x.startsWith('PHP.PHP.'));if(d)return path.join(base,d,'php.exe')}catch(e){}return'php'})();
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
const GOOD=b64({alg:'HS512',typ:'JWT'})+'.'+b64({clientID:'X',exp:Math.floor(Date.now()/1000)+36000,iss:'indmoney'})+'.fakesignature';
let reqs=[],positions=[],rejectSmart=false;
const CONTRACTS={'NIFTY|2026-11-17|25050|CE':['45388',65],'BANKNIFTY|2026-11-24|60500|CE':['59001',30]};
const fake=http.createServer((q,s)=>{let b='';q.on('data',d=>b+=d).on('end',()=>{const u=new URL(q.url,'http://x');reqs.push({m:q.method,p:u.pathname,b});
  const send=(c,j)=>{s.writeHead(c,{'Content-Type':'application/json'});s.end(JSON.stringify(j))};
  if(q.headers.authorization!==GOOD)return send(403,{status:'error',message:'Invalid token'});
  if(u.pathname==='/funds')return send(200,{status:'success',data:{detailed_avl_balance:{option_buy:50000}}});
  if(u.pathname==='/portfolio/positions')return send(200,{status:'success',data:positions});
  if(u.pathname==='/market/quotes/ltp'){const d={};for(const c of (u.searchParams.get('scrip-codes')||'').split(','))d[c]={live_price:200};return send(200,{status:'success',data:d})}
  if(u.pathname==='/order-book')return send(200,{status:'success',data:[
    {id:'DRV-9',security_id:'45388',exchange:'NSE',segment:'DERIVATIVE',txn_type:'BUY',name:'NIFTY-25050-CE',product:'INTRADAY',order_type:'OCO',requested_qty:65,requested_price:200,traded_qty:65,traded_price:200.4,status:'SUCCESS',created_at:'2026-11-11T10:00:00',remarks:'IDXSIG',child_order_id:'GTT-9',sl_trigger_price:120,sl_limit_price:114,tgt_trigger_price:360,tgt_limit_price:352.8},
    {id:'GTT-9',security_id:'45388',exchange:'NSE',segment:'DERIVATIVE',txn_type:'SELL',name:'NIFTY-25050-CE',product:'INTRADAY',order_type:'OCO',requested_qty:65,requested_price:0,traded_qty:0,traded_price:0,status:'SL-PENDING',created_at:'2026-11-11T10:00:01',parent_order_id:'DRV-9',sl_trigger_price:120,sl_limit_price:114,tgt_trigger_price:360,tgt_limit_price:352.8}]});
  if(u.pathname==='/market/instruments/search'){const k=[u.searchParams.get('underlying'),u.searchParams.get('expiry'),+u.searchParams.get('strike_from'),u.searchParams.get('option_type')].join('|'),c=CONTRACTS[k];
    return send(200,{status:'success',data:{count:c?1:0,page:1,page_size:50,instruments:c?[{security_id:c[0],trading_symbol:'X',expiry:u.searchParams.get('expiry'),strike_price:+u.searchParams.get('strike_from'),option_type:u.searchParams.get('option_type'),lot_size:c[1]}]:[]}})}
  if(u.pathname==='/smart/order'&&q.method==='POST'){if(rejectSmart)return send(400,{status:'error',message:'Stop price too close to the market price'});return send(200,{status:'success',data:{order_data:[{order_id:'DRV-501',order_status:'CREATED',child_order_details:{order_id:'GTT-601',order_status:'CREATED'}}]}})}
  if(u.pathname==='/smart/order/modify'&&q.method==='POST')return send(200,{status:'success',data:{order_id:JSON.parse(b).order_id,order_status:'MODIFIED'}});
  if(u.pathname==='/smart/order/cancel'&&q.method==='POST')return send(200,{status:'success',data:{order_id:JSON.parse(b).order_id,order_status:'CANCELLED'}});
  if(u.pathname==='/order'&&q.method==='POST')return send(200,{status:'success',data:{order_id:'DRV-777',order_status:'O-PENDING'}});
  send(404,{status:'error',message:'unknown'})})});
let pass=0,fail=0;const t=(n,c,x)=>{if(c){pass++;console.log('  ok  ',n)}else{fail++;console.log('  FAIL',n,x!==undefined?JSON.stringify(x):'')}};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function startPhp(port,{mode,broker='indstocks',auto=true,nogap=true}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'sigauto-'));
  const env={...process.env,SIGNALS_TEST_UPSTOX:'http://127.0.0.1:'+FAKE,SIGNALS_TEST_MODE:mode,SIGNALS_TEST_BROKER:broker,SIGNALS_TEST_DATA:data};if(auto)env.SIGNALS_TEST_AUTO='1';if(nogap)env.SIGNALS_TEST_NOGAP='1';
  return{p:spawn(PHP,['-S','127.0.0.1:'+port,'-t',ROOT],{cwd:ROOT,env,stdio:'ignore'}),data}}
async function api(port,qs,{method='GET',body}={}){const r=await fetch(`http://127.0.0.1:${port}/api.php?${qs}`,{method,headers:{'X-App-Pin':PIN,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const txt=await r.text();let j;try{j=JSON.parse(txt)}catch(e){j={raw:txt}}return{s:r.status,j}}
let n=0;const nifty={u:'NIFTY',e:'2026-11-17',k:25050,t:'CE'};
const ATT={sl_trigger:120,sl_limit:114,tgt_trigger:360,tgt_limit:352.8};
const buy=(o={})=>({instrument_token:'NSE_FO|45388',quantity:65,transaction_type:'BUY',order_type:'LIMIT',product:'I',price:202,ref:'auto-'+(++n)+'-'+Date.now(),label:'AUTO BUY NIFTY 25050 CE',contract:nifty,auto:true,attach:{...ATT},...o});
const smart=()=>reqs.filter(x=>x.p==='/smart/order');
(async()=>{fake.listen(FAKE,'127.0.0.1');console.log('PHP:',PHP);
  /* ---------- automatic trading switched OFF (ORDER_AUTO false) ---------- */
  let S=startPhp(8131,{mode:'dry',auto:false});await sleep(1300);let D=8131;console.log('\nAutomatic trading off');
  await api(D,'trade=settoken',{method:'POST',body:{token:GOOD}});
  let r=await api(D,'trade=status');t('status shows automatic trading not configured',r.j.auto&&r.j.auto.configured===false&&r.j.auto.enabled===false,r.j.auto);
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('an automatic order is refused while it is off',r.s===422&&/switched off/i.test(r.j.message),r);
  S.p.kill();await sleep(300);

  /* ---------- dry mode, automatic trading ON ---------- */
  S=startPhp(8132,{mode:'dry'});await sleep(1300);D=8132;console.log('\nDry mode, automatic trading on');
  await api(D,'trade=settoken',{method:'POST',body:{token:GOOD}});
  r=await api(D,'trade=status');const A=r.j.auto;t('status carries the rules (stop 40%, target 80%, trail 30%/25%, 1 lot, 1 open, 2 a day, square-off 15:10)',A.configured&&A.enabled&&A.sl===.4&&A.target===.8&&A.trailStart===.3&&A.trailGive===.25&&A.lots===1&&A.maxOpen===1&&A.maxPerDay===2&&A.squareOff==='15:10'&&A.entryUntil==='14:00',A);
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('a correct automatic order passes the dry run',r.s===200&&r.j.mode==='dry'&&/DRY/.test(r.j.data.order_ids[0]),r);
  t('nothing was sent to INDstocks in dry mode',smart().length===0&&!reqs.some(x=>x.p==='/order'));
  r=await api(D,'trade=place',{method:'POST',body:buy({attach:undefined})});t('an automatic order without stop and target is refused',r.s===422&&/must carry/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({attach:{...ATT,sl_trigger:205,sl_limit:200}})});t('a stop above the entry price is refused',r.s===422&&/below the entry/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({attach:{...ATT,sl_trigger:195,sl_limit:190}})});t('a stop closer than 5% is refused',r.s===422&&/5% to 60%/.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({attach:{...ATT,tgt_trigger:1000,tgt_limit:990}})});t('a target more than 300% away is refused',r.s===422&&/10% to 300%/.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({quantity:130})});t('more than one lot is refused for automatic orders',r.s===422&&/limited to 1 lot/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({product:'D'})});t('an overnight automatic order is refused (a smart order lasts one day)',r.s===422&&/intraday only/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({instrument_token:'BSE_FO|822217',contract:{u:'SENSEX',e:'2026-11-12',k:82000,t:'CE'}})});t('a Sensex order cannot carry a stop (not documented by INDstocks)',r.s===422&&/Sensex/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('the second automatic order of the day passes',r.s===200,r);
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('the third is refused: daily automatic limit of 2',r.s===422&&/daily limit/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:buy({ref:'auto-same-ref-1',price:202}),});t('(fresh ref but over the daily limit stays refused)',r.s===422);
  r=await api(D,'trade=status');t('status counts the automatic buys',r.j.sentToday>=2);
  S.p.kill();await sleep(300);

  /* ---------- open-position limit and kill switch ---------- */
  S=startPhp(8133,{mode:'dry'});await sleep(1300);D=8133;console.log('\nOpen-position limit and kill switch');
  await api(D,'trade=settoken',{method:'POST',body:{token:GOOD}});
  positions=[{security_id:'59001',symbol:'BANKNIFTY',segment:'DERIVATIVE',product:'INTRADAY',exchange:'NSE',drv_option_type:'CE',drv_expiry_date:'2026-11-24',drv_strike_price:60500,net_qty:30,avg_price:400}];
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('with one automatic position already open the next buy is refused',r.s===422&&/already has 1 open/i.test(r.j.message),r);
  positions=[];
  r=await api(D,'trade=autoswitch',{method:'POST',body:{on:false}});t('the kill switch pauses automatic trading',r.s===200&&r.j.auto.killed===true&&r.j.auto.enabled===false,r);
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('an automatic order is refused while paused',r.s===422&&/switched off/i.test(r.j.message),r);
  r=await api(D,'trade=place',{method:'POST',body:{instrument_token:'NSE_FO|45388',quantity:65,transaction_type:'BUY',order_type:'LIMIT',product:'I',price:202,ref:'manual-'+Date.now(),label:'manual',contract:nifty}});t('a manual order still works while paused',r.s===200,r);
  r=await api(D,'trade=autoswitch',{method:'POST',body:{on:true}});t('and it can be turned back on',r.s===200&&r.j.auto.enabled===true,r);
  r=await api(D,'trade=place',{method:'POST',body:{...buy(),attach:{...ATT},auto:false}});t('a manual buy with an attached stop and target passes the dry run too',r.s===200,r);

  console.log('\nSmart modify, cancel and the ledger (dry)');
  const mod={order_id:'GTT-601',sl_trigger:150,sl_limit:142.5,tgt_trigger:360,tgt_limit:352.8};
  r=await api(D,'trade=smartmodify',{method:'POST',body:mod});t('moving the stop up passes the dry run',r.s===200&&r.j.mode==='dry',r);
  r=await api(D,'trade=smartmodify',{method:'POST',body:{...mod,sl_limit:151}});t('a stop limit above its trigger is refused',r.s===422&&/not consistent/i.test(r.j.message),r);
  r=await api(D,'trade=smartmodify',{method:'POST',body:{...mod,sl_trigger:150.03}});t('a price that is not a multiple of 0.05 is refused',r.s===422&&/0\.05/.test(r.j.message),r);
  r=await api(D,'trade=smartmodify',{method:'POST',body:{...mod,order_id:''}});t('an order id is required',r.s===400,r);
  r=await api(D,'trade=smartcancel',{method:'POST',body:{order_id:'DRV-501'}});t('cancel passes the dry run',r.s===200&&r.j.mode==='dry',r);
  t('no smart order traffic reached INDstocks in dry mode',!reqs.some(x=>/smart\/order\/(modify|cancel)/.test(x.p)));
  r=await api(D,'trade=autostate');t('the ledger starts empty',r.s===200&&r.j.state===null,r);
  r=await api(D,'trade=autostate',{method:'POST',body:{state:{day:'2026-11-11',trades:[{id:'a1',state:'open'}],hist:[]}}});t('the runner can save the ledger',r.s===200,r);
  r=await api(D,'trade=autostate');t('and read it back',r.j.state&&r.j.state.trades[0].id==='a1',r);
  r=await api(D,'trade=autostate',{method:'POST',body:{nothing:1}});t('a bad ledger body is refused',r.s===400,r);
  t('the ledger file is a .php file with the exit line',fs.readFileSync(path.join(S.data,'auto-state.php'),'utf8').startsWith('<?php http_response_code(404); exit; ?>'));
  const log=fs.readFileSync(path.join(S.data,'orders.log.php'),'utf8');t('the order log records the dry smart-order steps',/dry-smart-modify/.test(log)&&/dry-smart-cancel/.test(log)&&/auto-switch/.test(log));
  S.p.kill();await sleep(300);

  /* ---------- live mode against the fake: the real smart-order request ---------- */
  S=startPhp(8134,{mode:'live'});await sleep(1300);D=8134;console.log('\nLive mode against the fake INDstocks');reqs=[];positions=[];
  await api(D,'trade=settoken',{method:'POST',body:{token:GOOD}});reqs=[];
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('the automatic buy is sent as ONE smart order',r.s===200&&r.j.mode==='live'&&smart().length===1,r);
  const sb=smart()[0]&&JSON.parse(smart()[0].b);
  t('the body has the buy, the limit, the stop and the target attached',sb&&sb.txn_type==='BUY'&&sb.exchange==='NSE'&&sb.segment==='DERIVATIVE'&&sb.product==='INTRADAY'&&sb.order_type==='LIMIT'&&sb.validity==='DAY'&&sb.security_id==='45388'&&sb.qty===65&&sb.limit_price===202&&sb.sl_trigger_price===120&&sb.sl_limit_price===114&&sb.tgt_trigger_price===360&&sb.tgt_limit_price===352.8&&sb.algo_id==='99999'&&sb.remarks==='IDXSIG',sb);
  t('the reply gives the entry order id and the stop/target (child) id',r.j.data&&r.j.data.order_ids[0]==='DRV-501'&&r.j.data.child_id==='GTT-601',r.j);
  r=await api(D,'trade=smartmodify',{method:'POST',body:{order_id:'GTT-601',sl_trigger:202.5,sl_limit:192.4,tgt_trigger:360,tgt_limit:352.8}});
  const mb=reqs.filter(x=>x.p==='/smart/order/modify').map(x=>JSON.parse(x.b))[0];
  t('trailing the stop sends a modify with both stop and target (an OCO needs both)',r.s===200&&r.j.mode==='live'&&mb&&mb.order_id==='GTT-601'&&mb.segment==='DERIVATIVE'&&mb.algo_id==='99999'&&mb.sl_trigger_price===202.5&&mb.sl_limit_price===192.4&&mb.tgt_trigger_price===360&&mb.tgt_limit_price===352.8,mb);
  r=await api(D,'trade=smartcancel',{method:'POST',body:{order_id:'GTT-601'}});const cb=reqs.filter(x=>x.p==='/smart/order/cancel').map(x=>JSON.parse(x.b))[0];
  t('cancel sends the order id and segment',r.s===200&&cb&&cb.order_id==='GTT-601'&&cb.segment==='DERIVATIVE',cb);
  r=await api(D,'trade=orders');const oc=(r.j.data||[]).find(o=>o.order_id==='GTT-9');
  t('the order list shows the stop/target leg with its parent and prices',oc&&oc.parent_order_id==='DRV-9'&&oc.order_type==='OCO'&&oc.sl_trigger_price===120&&oc.tgt_trigger_price===360&&oc.transaction_type==='SELL',r.j);
  positions=[{security_id:'45388',symbol:'NIFTY',segment:'DERIVATIVE',product:'INTRADAY',exchange:'NSE',drv_option_type:'CE',drv_expiry_date:'2026-11-17',drv_strike_price:25050,net_qty:65,avg_price:200.4}];reqs=[];
  r=await api(D,'trade=place',{method:'POST',body:{instrument_token:'NSE_FO|45388',quantity:65,transaction_type:'SELL',order_type:'LIMIT',product:'I',price:195,ref:'sq-a1-1-'+Date.now(),label:'AUTO SQUAREOFF'}});
  const so=reqs.find(x=>x.p==='/order');t('a square-off sell of the held quantity is sent as a plain limit order',r.s===200&&so&&JSON.parse(so.b).txn_type==='SELL'&&JSON.parse(so.b).qty===65&&JSON.parse(so.b).product==='INTRADAY',so);
  r=await api(D,'trade=place',{method:'POST',body:{instrument_token:'NSE_FO|45388',quantity:130,transaction_type:'SELL',order_type:'LIMIT',product:'I',price:195,ref:'sq-a1-2-'+Date.now(),label:'x'}});t('selling more than held is refused (no short positions)',r.s===422&&/hold only 65/.test(r.j.message),r);
  positions=[];rejectSmart=true;
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('if INDstocks rejects the smart order the app reports it and nothing is bought',r.s===502&&/too close/i.test(r.j.message),r);
  rejectSmart=false;S.p.kill();await sleep(300);

  /* ---------- Upstox broker support ---------- */
  S=startPhp(8135,{mode:'dry',broker:'upstox'});await sleep(1300);D=8135;console.log('\nUpstox broker');
  r=await api(D,'trade=status');t('Upstox enables automatic trading when configured',r.j.auto&&r.j.auto.enabled===true,r.j.auto);
  r=await api(D,'trade=place',{method:'POST',body:buy()});t('Upstox accepts dry automatic orders with stop and target attached',r.s===200&&r.j.mode==='dry',r);
  r=await api(D,'trade=smartmodify',{method:'POST',body:mod});t('Upstox accepts dry smartmodify for trailing stops',r.s===200&&r.j.mode==='dry',r);
  r=await api(D,'trade=smartcancel',{method:'POST',body:{order_id:'DRY-TEST'}});t('Upstox accepts dry smartcancel',r.s===200&&r.j.mode==='dry',r);
  S.p.kill();fake.close();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)})();
