// Tests the accounts system (auth.php + the gate in api.php): sign-up, log-in, sessions, owner admin, and above all that one person's data can never reach another.
// Runs against a PHP server in "users" mode with a temporary data folder. Nothing here can reach a real broker.
// usage: node tests/auth.test.js   (needs PHP on the PATH, or set PHP_EXE)
const http=require('http'),path=require('path'),fs=require('fs'),os=require('os'),{spawn}=require('child_process');
const ROOT=path.join(__dirname,'..'),PORT=8161;
const PHP=process.env.PHP_EXE||(()=>{const base=path.join(process.env.LOCALAPPDATA||'','Microsoft','WinGet','Packages');try{const d=fs.readdirSync(base).find(x=>x.startsWith('PHP.PHP.'));if(d)return path.join(base,d,'php.exe')}catch(e){}return'php'})();
let pass=0,fail=0;const t=(n,c,x)=>{if(c){pass++;console.log('  ok  ',n)}else{fail++;console.log('  FAIL',n,x!==undefined?JSON.stringify(x):'')}};const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const SETUP='SETUP-CODE-123',RKEY='runner-key-0123456789abcdef-test';
function startPhp(port,extra={}){const data=fs.mkdtempSync(path.join(os.tmpdir(),'sigauth-'));
  return{p:spawn(PHP,['-S','127.0.0.1:'+port,'-t',ROOT],{cwd:ROOT,env:{...process.env,SIGNALS_TEST_UPSTOX:'http://127.0.0.1:1',SIGNALS_TEST_MODE:'dry',SIGNALS_TEST_BROKER:'indstocks',SIGNALS_TEST_DATA:data,SIGNALS_TEST_AUTH:'users',SIGNALS_TEST_SETUP:SETUP,SIGNALS_TEST_RUNNER_KEY:RKEY,SIGNALS_TEST_RL:'40',...extra},stdio:'ignore'}),data,port}}
class C{constructor(port){this.port=port;this.jar={}}
  async req(qs,{method='GET',body,headers={}}={}){const h={...headers};if(this.jar.ixs)h.Cookie='ixs='+this.jar.ixs;if(method!=='GET'&&!('X-IX' in h)&&h['X-IX']!==null)h['X-IX']='1';if(h['X-IX']===null)delete h['X-IX'];if(body)h['Content-Type']='application/json';
    const r=await fetch(`http://127.0.0.1:${this.port}/api.php?${qs}`,{method,headers:h,body:body?JSON.stringify(body):undefined,redirect:'manual'});
    const sc=r.headers.getSetCookie?r.headers.getSetCookie():[];for(const c of sc){const m=/^ixs=([^;]*)/.exec(c);if(m){if(m[1]===''||m[1]==='deleted')delete this.jar.ixs;else this.jar.ixs=m[1]}}
    const tx=await r.text();let j;try{j=JSON.parse(tx)}catch(e){j={raw:tx}}return{s:r.status,j,sc}}
  post(qs,body,headers){return this.req(qs,{method:'POST',body:body||{},headers})}}
const HEAD_LEN='<?php http_response_code(404); exit; ?>\n'.length;
const idOf=(S,name)=>{const u=JSON.parse(fs.readFileSync(path.join(S.data,'users.php'),'utf8').slice(HEAD_LEN)).users;return Object.values(u).find(x=>x.username===name).id};
const PW='Zebra-Tunnel-47',PW2='Maple-Orbit-83';
(async()=>{console.log('PHP:',PHP);
  let S=startPhp(PORT);await sleep(1400);const base=`http://127.0.0.1:${PORT}`,anon=new C(PORT);

  console.log('\nBefore anyone has an account');
  let r=await anon.req('ping=1');t('ping says users mode, nobody signed in, first run, setup code configured',r.j.auth&&r.j.auth.mode==='users'&&r.j.auth.user===null&&r.j.auth.firstRun===true&&r.j.auth.setupReady===true,r.j.auth);
  t('ping never leaks the token, setup code or runner key',!/SETUP-CODE|runner-key|eyJ/.test(JSON.stringify(r.j)));
  for(const [name,qs,m] of [['paper account','store=paper','GET'],['trading','trade=status','GET'],['alerts','svc=status','GET'],['engine record','record=1','GET'],['market data','path=/v2/market-quote/quotes&instrument_key=x','GET'],['yahoo','yahoo=NIFTY','GET'],['owner admin','auth=admin_users','GET']]){r=await anon.req(qs,{method:m});t(name+' needs a login (401)',r.s===401,[r.s,r.j])}
  r=await anon.post('auth=signup',{username:'olivia',password:PW,invite:SETUP,accept:true},{'X-IX':null});t('a sign-up without the app header is blocked (403)',r.s===403,r);
  r=await anon.post('auth=signup',{username:'olivia',password:PW,invite:SETUP,accept:true},{Origin:'https://evil.example'});t('a sign-up from another site is blocked (403)',r.s===403,r);
  for(const f of ['auth.php','trade.php','svc.php'])t('/'+f+' opened directly shows nothing (404)',(await fetch(base+'/'+f)).status===404);

  console.log('\nThe owner account');
  const owner=new C(PORT);
  r=await owner.post('auth=signup',{username:'olivia',password:PW,invite:'wrong',accept:true});t('wrong setup code refused',r.s===422&&/setup code/i.test(r.j.message),r);
  r=await owner.post('auth=signup',{username:'olivia',password:PW,invite:SETUP});t('the "I understand" box is required',r.s===422&&/tick/i.test(r.j.message),r);
  r=await owner.post('auth=signup',{username:'ab',password:PW,invite:SETUP,accept:true});t('a too short username is refused',r.s===422,r);
  r=await owner.post('auth=signup',{username:'Admin',password:PW,invite:SETUP,accept:true});t('reserved names are refused',r.s===422&&/reserved/i.test(r.j.message),r);
  for(const bad of ['short1','aaaaaaaaaa','password123','olivia-olivia']){r=await owner.post('auth=signup',{username:'olivia',password:bad,invite:SETUP,accept:true});t('weak password "'+bad+'" refused',r.s===422,r.j)}
  r=await owner.post('auth=signup',{username:'olivia',password:PW,invite:SETUP,accept:true});
  t('the first account is created and is the owner',r.s===200&&r.j.user&&r.j.user.role==='admin'&&r.j.user.username==='olivia',r);
  const ck=r.sc.join(' | ');t('the session cookie is HttpOnly and SameSite=Lax',/ixs=/.test(ck)&&/HttpOnly/i.test(ck)&&/SameSite=Lax/i.test(ck),ck);
  r=await owner.req('auth=me');t('me shows the owner, and it is no longer first run',r.j.user&&r.j.user.role==='admin'&&r.j.firstRun===false,r.j);
  r=await new C(PORT).post('auth=signup',{username:'mallory',password:PW,invite:SETUP,accept:true});t('the setup code works once: it cannot create a second owner',r.s===422,r);

  console.log('\nInvites and friends');
  r=await owner.post('auth=admin_invite',{count:3,days:7,note:'friends'});const codes=r.j.codes;t('the owner can make invite codes',r.s===200&&codes&&codes.length===3&&/^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codes[0]),r.j);
  r=await owner.req('auth=admin_invites');t('the invite list shows hints only, never the codes',r.s===200&&r.j.invites.length===3&&!JSON.stringify(r.j).includes(codes[0]),r.j);
  const A=new C(PORT),B=new C(PORT);
  r=await A.post('auth=signup',{username:'asha',password:PW,invite:codes[0].toLowerCase().replace(/-/g,''),accept:true});t('a friend signs up with an invite code (any case, dashes optional)',r.s===200&&r.j.user.role==='member',r);
  r=await new C(PORT).post('auth=signup',{username:'late',password:PW,invite:codes[0],accept:true});t('an invite code works only once',r.s===422&&/invite code/i.test(r.j.message),r);
  r=await B.post('auth=signup',{username:'ASHA',password:PW,invite:codes[1],accept:true});t('usernames are unique, ignoring case',r.s===422&&/taken/i.test(r.j.message),r);
  r=await B.post('auth=signup',{username:'bharat',password:PW2,invite:codes[1],accept:true});t('a second friend signs up',r.s===200,r);
  r=await new C(PORT).post('auth=signup',{username:'nobody',password:PW,invite:'ABCD-EFGH-JKMN',accept:true});t('a made-up invite code is refused',r.s===422,r);
  const users=JSON.parse(fs.readFileSync(path.join(S.data,'users.php'),'utf8').replace(/^<\?php[^\n]*\n/,''));const ids=Object.fromEntries(Object.values(users.users).map(u=>[u.username,u.id]));
  const raw=fs.readFileSync(path.join(S.data,'users.php'),'utf8');
  t('the user file starts with the exit line and holds bcrypt hashes, not passwords',raw.startsWith('<?php http_response_code(404); exit; ?>')&&/\$2y\$/.test(raw)&&![PW,PW2].some(p=>raw.includes(p)));
  t('the invite file keeps only hashes of the codes',!codes.some(c=>fs.readFileSync(path.join(S.data,'invites.php'),'utf8').includes(c)));

  console.log('\nA never sees B (and B never sees A)');
  const bookA={book:{ts:1000,on:true,cash:41000,start:50000,pos:[],hist:[{id:'a-1',pnl:500,entry:100}],log:[]}},bookB={book:{ts:1001,on:true,cash:60000,start:50000,pos:[{id:'b-open',entry:80}],hist:[{id:'b-1',pnl:-300,entry:90}],log:[]}};
  r=await A.req('store=paper');t('a new account starts with an empty paper account',r.s===200&&Object.keys(r.j).length===0,r.j);
  r=await A.post('store=paper',bookA);t('A saves a paper account',r.s===200,r);
  r=await B.req('store=paper');t('B does not get A\'s account',r.s===200&&Object.keys(r.j).length===0,r.j);
  r=await B.post('store=paper',bookB);t('B saves a different account',r.s===200,r);
  r=await A.req('store=paper');t('A still gets exactly A\'s account',r.j.book&&r.j.book.hist[0].id==='a-1'&&r.j.book.cash===41000,r.j);
  r=await B.req('store=paper');t('B gets exactly B\'s account',r.j.book&&r.j.book.hist[0].id==='b-1'&&r.j.book.pos[0].id==='b-open',r.j);
  for(const q of ['uid='+ids.asha,'user='+ids.asha,'u='+ids.asha,'id='+ids.asha,'account=asha','uid=../'+ids.asha,'uid=owner','uid=engine','path=../u/'+ids.asha+'/paper.php']){r=await B.req('store=paper&'+q);t('B asking for A with "'+q.split('&')[0].slice(0,30)+'" still gets only B\'s account',r.j.book&&r.j.book.hist[0].id==='b-1',r.j)}
  r=await B.post('store=paper&uid='+ids.asha,bookB);r=await A.req('store=paper');t('B writing with A\'s id in the URL does not change A\'s account',r.j.book.hist[0].id==='a-1',r.j);
  t('on disk each person has their own folder and file',fs.existsSync(path.join(S.data,'u',ids.asha,'paper.php'))&&fs.existsSync(path.join(S.data,'u',ids.bharat,'paper.php'))&&fs.readFileSync(path.join(S.data,'u',ids.asha,'paper.php'),'utf8').includes('a-1')&&!fs.readFileSync(path.join(S.data,'u',ids.asha,'paper.php'),'utf8').includes('b-1'));
  r=await A.post('store=paper',{book:{ts:2000,pos:[{id:'a-1'}],hist:[{id:'a-1'}]}});t('a position A already closed cannot be re-opened by a stale window (409)',r.s===409,r);
  r=await B.post('store=paper',{book:{ts:2000,pos:[{id:'a-1'}],hist:[]}});t('…but the same id in B\'s own account is a different thing (200): closed trades are per person',r.s===200,r);
  r=await A.post('svc=lease',{id:'win1',runner:false});const r2=await B.post('svc=lease',{id:'win2',runner:false});t('each person has their own writer lease (B is not blocked by A\'s window)',r.j.granted===true&&r2.j.granted===true,[r.j,r2.j]);
  r=await A.req('svc=status');t('A sees a live writer in its own account',r.j.writerAlive===true);
  const C3=new C(PORT);r=await C3.post('auth=signup',{username:'chitra',password:PW,invite:codes[2],accept:true});r=await C3.post('svc=lease',{id:'win3',runner:false});t('a third person starts with a free lease too',r.j.granted===true);
  r=await C3.req('svc=status');const rr=await C3.req('store=paper');t('and sees nothing of A or B',rr.s===200&&Object.keys(rr.j).length===0);

  console.log('\nFriends broker status & alerts; they can read market data');
  r=await A.req('trade=status');t('a friend can read their own broker status',r.s===200,r);
  r=await A.post('svc=notify',{title:'x',message:'hello'});t('phone alerts are closed to a friend (403)',r.s===403,r);
  r=await owner.req('trade=status');t('the owner can use the trading routes (status works)',r.s===200&&r.j.mode==='dry',r);
  for(const act of ['admin_users','admin_invites']){r=await A.req('auth='+act);t('owner-only '+act+' is closed to a friend (403)',r.s===403,[r.s,r.j])}
  r=await A.post('auth=admin_invite',{});t('a friend cannot make invites (403)',r.s===403,r);
  r=await A.post('auth=admin_disable',{id:ids.bharat});t('a friend cannot disable another person (403)',r.s===403,r);
  r=await A.req('path=/v2/market-quote/quotes&instrument_key=x');t('a friend can reach the market-data route (it fails only because the fake has no token: not 401/403)',r.s!==401&&r.s!==403,[r.s,r.j]);

  console.log('\nLogging in');
  r=await new C(PORT).post('auth=login',{username:'asha',password:'Wrong-Pass-12'});const wrongMsg=r.j.message;t('wrong password: 401 "Wrong username or password"',r.s===401&&/Wrong username or password/.test(wrongMsg),r);
  r=await new C(PORT).post('auth=login',{username:'no-such-person',password:'Wrong-Pass-12'});t('an unknown username gives the SAME message (no way to find out who has an account)',r.s===401&&r.j.message===wrongMsg,r);
  const A2=new C(PORT);r=await A2.post('auth=login',{username:'Asha',password:PW});t('login works (username not case sensitive)',r.s===200&&r.j.user.username==='asha',r);
  r=await A2.req('store=paper');t('a second device of the same person sees the same account',r.j.book&&r.j.book.hist[0].id==='a-1');
  const V=new C(PORT);r=await V.post('auth=signup',{username:'victim',password:PW,invite:(await owner.post('auth=admin_invite',{})).j.codes[0],accept:true});
  const Vl=new C(PORT);for(let i=0;i<5;i++)r=await Vl.post('auth=login',{username:'victim',password:'Wrong-Pass-1'+i});
  r=await Vl.post('auth=login',{username:'victim',password:PW});t('after 5 wrong passwords the username is locked for a while (429), even with the right password',r.s===429&&/Too many/i.test(r.j.message),r);
  r=await V.req('store=paper');t('(the owner of the locked account is not logged out by an attacker)',r.s===200,r);

  console.log('\nPasswords and sessions');
  r=await A2.post('auth=password',{old:'nope-nope-1',new:PW2});t('changing the password needs the right current one (401)',r.s===401,r);
  r=await A2.post('auth=password',{old:PW,new:'short'});t('a weak new password is refused',r.s===422,r);
  r=await A2.post('auth=password',{old:PW,new:PW2});t('the password can be changed',r.s===200,r);
  r=await A.req('store=paper');t('the OTHER device is logged out by a password change (401)',r.s===401,r);
  r=await A2.req('store=paper');t('this device stays logged in',r.s===200);
  r=await new C(PORT).post('auth=login',{username:'asha',password:PW});t('the old password no longer works',r.s===401);
  const A3=new C(PORT);r=await A3.post('auth=login',{username:'asha',password:PW2});t('the new password works',r.s===200);
  r=await A3.post('auth=logout',{});t('logout works',r.s===200);r=await A3.req('store=paper');t('and the session is gone (401)',r.s===401);
  const stale=A2.jar.ixs;r=await A2.post('auth=logout',{});const old=new C(PORT);old.jar.ixs=stale;r=await old.req('store=paper');t('a copied session cookie is dead after logout (401)',r.s===401);

  console.log('\nOwner admin');
  r=await owner.req('auth=admin_users');t('the owner sees everyone with trade counts (not their trades)',r.s===200&&r.j.users.length>=4&&r.j.users.find(u=>u.username==='asha').trades===1&&!JSON.stringify(r.j).includes('a-1'),r.j.users&&r.j.users.map(u=>[u.username,u.trades]));
  const Af=new C(PORT);await Af.post('auth=login',{username:'asha',password:PW2});
  r=await owner.post('auth=admin_disable',{id:ids.asha});t('the owner can switch a friend off',r.s===200);
  r=await Af.req('store=paper');t('their open session stops working at once (401)',r.s===401,r);
  r=await new C(PORT).post('auth=login',{username:'asha',password:PW2});t('and they cannot log in (403)',r.s===403&&/switched off/i.test(r.j.message),r);
  r=await owner.post('auth=admin_enable',{id:ids.asha});r=await Af.post('auth=login',{username:'asha',password:PW2});t('switched back on, they can log in again',r.s===200);
  r=await owner.post('auth=admin_reset',{id:ids.asha});const temp=r.j.temp;t('the owner can reset a password and gets a one-time temporary one',r.s===200&&temp&&temp.length>=10,r);
  r=await Af.req('store=paper');t('the reset ends their old session',r.s===401);
  const An=new C(PORT);r=await An.post('auth=login',{username:'asha',password:temp});t('they log in with the temporary password and are told to change it',r.s===200&&r.j.user.mustChange===true,r);
  r=await An.req('store=paper');t('until they do, the data routes are closed (403, change password first)',r.s===403&&r.j.auth==='change',r);
  r=await An.post('auth=password',{old:temp,new:'Quartz-Meadow-61'});r=await An.req('store=paper');t('after changing it everything works and their paper account is intact',r.s===200&&r.j.book&&r.j.book.hist[0].id==='a-1',r);
  r=await owner.post('auth=admin_disable',{id:idOf(S,'olivia')});t('the owner cannot switch themselves off here',r.s===422);
  r=await owner.post('auth=delete_me',{password:PW});t('the only owner cannot delete the owner account',r.s===422,r);
  const chitraId=idOf(S,'chitra');r=await C3.post('auth=delete_me',{password:'wrong-password-1'});t('deleting your own account needs your password (401)',r.s===401);
  r=await C3.post('auth=delete_me',{password:PW});t('a friend can delete their own account',r.s===200);
  t('and their folder is gone from the disk',!fs.existsSync(path.join(S.data,'u',chitraId)));
  r=await new C(PORT).post('auth=login',{username:'chitra',password:PW});t('and they cannot log in any more',r.s===401);
  r=await owner.post('auth=admin_delete',{id:ids.bharat});t('the owner can delete a friend and their data',r.s===200&&!fs.existsSync(path.join(S.data,'u',ids.bharat)),r);

  console.log('\nThe owner\'s 24/7 runner');
  const run=new C(PORT);r=await run.req('trade=status',{headers:{'X-Runner-Key':RKEY}});t('the runner key opens the trading routes',r.s===200&&r.j.mode==='dry',r);
  r=await run.req('trade=status',{headers:{'X-Runner-Key':RKEY+'x'}});t('a wrong runner key is refused (401)',r.s===401,r);
  r=await run.post('store=paper',{book:{ts:5000,on:true,start:50000,cash:49000,pos:[{id:'e-open',ix:'NIFTY',entry:100,ltp:110,t0:1}],hist:[{id:'e-1',ix:'NIFTY',kind:'intra',entry:100,exit:130,pnl:1900,ret:.3,tC:2},{id:'e-2',ix:'BANKNIFTY',kind:'intra',entry:200,exit:150,pnl:-1500,ret:-.25,tC:3}],log:[{txt:'secret log line'}]}},{'X-Runner-Key':RKEY});t('the runner has its own paper account (the engine record)',r.s===200,r);
  r=await B.req('record=1');r=await C3.req('record=1');r=await A.req('record=1');
  r=await An.req('record=1');t('every friend can read the engine record, read-only, without its cash or log',r.s===200&&r.j.record&&r.j.record.hist.length===2&&r.j.record.pos.length===1&&!JSON.stringify(r.j).includes('secret log line')&&!('cash' in r.j.record),r.j);
  r=await An.req('store=paper');t('and the engine record is NOT anyone\'s own paper account',r.j.book&&r.j.book.hist[0].id==='a-1');
  r=await run.req('auth=admin_users',{headers:{'X-Runner-Key':RKEY}});t('the runner cannot use owner admin (401)',r.s===401,r);

  console.log('\nRate limit on market data (per person)');
  const R1=new C(PORT);await R1.post('auth=login',{username:'olivia',password:PW});let last;for(let i=0;i<45;i++)last=await An.req('path=/v2/nothing');
  t('one person asking too often gets 429',last.s===429,last);
  r=await owner.req('path=/v2/nothing');t('another person is not affected',r.s!==429,r.s);

  console.log('\nOwner forgot the password');
  const rec=new C(PORT);
  r=await rec.post('auth=recover',{username:'olivia',code:'wrong',password:'Quartz-Meadow-61'});t('recovery with a wrong setup code is refused',r.s===422,r);
  r=await rec.post('auth=recover',{username:'asha',code:SETUP,password:'Quartz-Meadow-61'});t('recovery only works for an OWNER account (a friend\'s name is refused)',r.s===422&&/no owner/i.test(r.j.message),r);
  r=await rec.post('auth=recover',{username:'olivia',code:SETUP,password:'short'});t('recovery still enforces the password rules',r.s===422,r);
  r=await rec.post('auth=recover',{username:'olivia',code:SETUP,password:'Quartz-Meadow-61'});t('with the right setup code the owner can set a new password',r.s===200,r);
  r=await owner.req('store=paper');t('the owner\'s old sessions end',r.s===401,r);
  r=await new C(PORT).post('auth=login',{username:'olivia',password:PW});t('the old owner password no longer works',r.s===401);
  r=await new C(PORT).post('auth=login',{username:'olivia',password:'Quartz-Meadow-61'});t('the new one works',r.s===200&&r.j.user.role==='admin',r);
  t('the audit log records sign-ups, log-ins and failures but no passwords',(()=>{const l=fs.readFileSync(path.join(S.data,'auth-log.php'),'utf8');return /signup/.test(l)&&/login-failed/.test(l)&&/owner-password-recovered/.test(l)&&![PW,PW2,'Quartz-Meadow-61','Wrong-Pass-12'].some(p=>l.includes(p))})());

  S.p.kill();await sleep(300);

  console.log('\nRecovery switched off (no setup code configured)');
  S=startPhp(8166,{SIGNALS_TEST_SETUP:''});await sleep(1300);
  r=await new C(8166).post('auth=recover',{username:'olivia',code:'',password:'Quartz-Meadow-61'});t('with ADMIN_SETUP_CODE empty recovery is off, even with an empty code',r.s===422,r);
  S.p.kill();await sleep(300);

  console.log('\nDefault PIN safety (single-PIN mode)');
  S=startPhp(8162,{SIGNALS_TEST_AUTH:'pin'});await sleep(1300);
  const hr=(host,pin)=>new Promise(res=>{const q=http.request({host:'127.0.0.1',port:8162,path:'/api.php?store=paper',headers:{Host:host,'X-App-Pin':pin}},x=>{let b='';x.on('data',d=>b+=d).on('end',()=>res({s:x.statusCode,b}))});q.end()});
  let h=await hr('localhost:8162','2468');t('on localhost the default PIN still works (owner\'s own PC)',h.s===200,h);
  h=await hr('signals.example.com','2468');t('on a public host the DEFAULT PIN is refused, with a message that says why',h.s===401&&/default PIN/i.test(h.b),h);
  S.p.kill();await sleep(300);

  console.log('\nServer not set up (no setup code)');
  S=startPhp(8163,{SIGNALS_TEST_SETUP:''});await sleep(1300);
  r=await new C(8163).post('auth=signup',{username:'olivia',password:PW,invite:'',accept:true});t('without ADMIN_SETUP_CODE nobody can create the first account',r.s===422&&/not set up/i.test(r.j.message),r);
  r=await new C(8163).req('ping=1');t('ping tells the page the setup code is missing',r.j.auth.firstRun===true&&r.j.auth.setupReady===false,r.j.auth);
  S.p.kill();await sleep(300);

  console.log('\nSign-up rate limit');
  S=startPhp(8164);await sleep(1300);const SR=new C(8164);let lastS;for(let i=0;i<12;i++)lastS=await SR.post('auth=signup',{username:'user'+i+'x',password:PW,invite:'WRONG',accept:true});
  t('too many sign-up attempts from one place are stopped (429)',lastS.s===429,lastS);
  S.p.kill();console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0)})();
