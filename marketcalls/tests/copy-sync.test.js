// Tests Upstox GTT trailing_gap fix, GTT status endpoint, and hardened multi-account copy-trading sync (preflight funds/mode/position checks, synced modify, cancel, and exit).
const http = require('http'), path = require('path'), fs = require('fs'), os = require('os'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'), PORT = 8151, FAKE = 8099, SETUP = 'SETUP-COPY-123';
const PHP = process.env.PHP_EXE || (() => {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try { const d = fs.readdirSync(base).find(x => x.startsWith('PHP.PHP.')); if (d) return path.join(base, d, 'php.exe'); } catch (e) {}
  return 'php';
})();
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const indTok = clientID => b64({ alg: 'HS512', typ: 'JWT' }) + '.' + b64({ clientID, exp: Math.floor(Date.now() / 1000) + 36000, iss: 'indmoney' }) + '.sig';

const TOK_OWNER = 'UPX-OWNER';
const TOK_POOR = 'UPX-POOR';
const TOK_OFF = 'UPX-OFF';
const TOK_FOLLOW_IND = indTok('IND-FOLLOW-1');

let reqs = [];
let nGtt = 0;
let posHeld = false;
const fake = http.createServer((q, s) => {
  let b = '';
  q.on('data', d => b += d).on('end', () => {
    const u = new URL(q.url, 'http://x');
    const auth = q.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    let body = null;
    try { body = b ? JSON.parse(b) : null; } catch (e) {}
    reqs.push({ m: q.method, p: u.pathname, q: u.search, token, body });
    const send = (c, j) => { s.writeHead(c, { 'Content-Type': 'application/json' }); s.end(JSON.stringify(j)); };

    // Upstox OAuth token exchange (tests use code as token id)
    if (u.pathname === '/v2/login/authorization/token') {
      const code = new URLSearchParams(b).get('code') || TOK_OWNER;
      return send(200, { access_token: code, user_name: 'User-' + code });
    }
    // INDstocks endpoints
    if (token === TOK_FOLLOW_IND) {
      if (u.pathname === '/funds') return send(200, { status: 'success', data: { detailed_avl_balance: { option_buy: 45000 } } });
      if (u.pathname === '/portfolio/positions') return send(200, { status: 'success', data: posHeld ? [{ security_id: '45388', symbol: 'NIFTY', product: 'INTRADAY', exchange: 'NSE', drv_option_type: 'CE', drv_expiry_date: '2026-11-17', drv_strike_price: 25050, net_qty: 130, avg_price: 200 }] : [] });
      if (u.pathname === '/market/instruments/search') return send(200, { status: 'success', data: { instruments: [{ security_id: '45388', expiry: '2026-11-17', strike_price: 25050, option_type: 'CE', lot_size: 65 }] } });
      if (u.pathname === '/smart/order') { posHeld = true; return send(200, { status: 'success', data: { order_data: [{ order_id: 'IND-P-1', order_status: 'CREATED', child_order_details: { order_id: 'IND-C-1', order_status: 'CREATED' } }] } }); }
      if (u.pathname === '/smart/order/modify') return send(200, { status: 'success', data: { order_id: body.order_id, order_status: 'MODIFIED' } });
      if (u.pathname === '/smart/order/cancel') return send(200, { status: 'success', data: { order_id: body.order_id, order_status: 'CANCELLED' } });
      if (u.pathname === '/order') return send(200, { status: 'success', data: { order_id: 'IND-EXIT-1', order_status: 'SUCCESS' } });
    }
    // Upstox endpoints
    if (u.pathname === '/v3/user/get-funds-and-margin') {
      const avl = token === TOK_POOR ? 500 : 100000;
      return send(200, { status: 'success', data: { equity: { available_margin: avl } } });
    }
    if (u.pathname === '/v2/portfolio/short-term-positions') {
      return send(200, { status: 'success', data: posHeld ? [{ instrument_token: 'NSE_FO|45388', trading_symbol: 'NIFTY 25050 CE', quantity: 65, average_price: 200, last_price: 220, pnl: 1300, product: 'I' }] : [] });
    }
    if (u.pathname === '/v3/order/gtt/place') {
      nGtt++;
      return send(200, { status: 'success', data: { gtt_order_ids: ['GTT-' + nGtt] } });
    }
    if (u.pathname === '/v3/order/gtt/modify') return send(200, { status: 'success', data: { gtt_order_ids: [body.gtt_order_id] } });
    if (u.pathname === '/v3/order/gtt/cancel') return send(200, { status: 'success', data: { gtt_order_ids: [u.searchParams.get('gtt_order_id')] } });
    if (u.pathname === '/v3/order/gtt') return send(200, { status: 'success', data: { type: 'MULTIPLE', gtt_order_id: u.searchParams.get('gtt_order_id'), rules: [{ strategy: 'ENTRY', status: 'COMPLETED' }] } });
    if (u.pathname === '/v3/order/place') return send(200, { status: 'success', data: { order_id: 'UPX-EXIT-1' } });
    send(404, { status: 'error', message: 'unknown ' + u.pathname });
  });
});

class Client {
  constructor(port) { this.base = `http://127.0.0.1:${port}/api.php`; this.c = ''; }
  async req(qs, opt = {}) {
    const h = { 'X-IX': '1', 'Origin': `http://127.0.0.1:${PORT}`, ...(opt.body ? { 'Content-Type': 'application/json' } : {}), ...(this.c ? { Cookie: this.c } : {}) };
    const r = await fetch(`${this.base}?${qs}`, { method: opt.method || (opt.body ? 'POST' : 'GET'), headers: h, body: opt.body ? JSON.stringify(opt.body) : undefined });
    for (const v of (r.headers.getSetCookie ? r.headers.getSetCookie() : [])) { const m = /^ixs=([^;]*)/.exec(v); if (m) this.c = (m[1] === '' || m[1] === 'deleted') ? '' : 'ixs=' + m[1]; }
    const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { j = { raw: txt }; }
    return { s: r.status, j };
  }
}

let pass = 0, fail = 0;
const t = (n, c, x) => { if (c) { pass++; console.log('  ok  ', n); } else { fail++; console.log('  FAIL', n, x !== undefined ? JSON.stringify(x) : ''); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PW = 'Zebra-Tunnel-47';

(async () => {
  fake.listen(FAKE, '127.0.0.1');
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sigcopysync-'));
  const php = spawn(PHP, ['-S', '127.0.0.1:' + PORT, '-t', ROOT], {
    cwd: ROOT,
    env: {
      ...process.env,
      SIGNALS_TEST_UPSTOX: 'http://127.0.0.1:' + FAKE,
      SIGNALS_TEST_USER_DIR: '1',
      SIGNALS_TEST_AUTH: 'users',
      SIGNALS_TEST_MODE: 'live',
      SIGNALS_TEST_BROKER: 'upstox',
      SIGNALS_TEST_AUTO: '1',
      SIGNALS_TEST_NOGAP: '1',
      SIGNALS_TEST_SETUP: SETUP,
      SIGNALS_TEST_DATA: data
    },
    stdio: 'ignore'
  });
  await sleep(1400);

  const O = new Client(PORT);
  const oRes = await O.req('auth=signup', { body: { username: 'owner1', email: '', password: PW, invite: SETUP, accept: true } });
  if (!oRes.j || !oRes.j.user) throw new Error('Owner signup failed: ' + JSON.stringify(oRes));

  const mkUser = async (uname) => {
    const inv = (await O.req('auth=invite', { body: { days: 7 } })).j.code;
    const c = new Client(PORT);
    const s = await c.req('auth=signup', { body: { username: uname, email: '', password: PW, invite: inv, accept: true } });
    if (!s.j || !s.j.user) throw new Error('Signup failed for ' + uname + ': ' + JSON.stringify(s));
    return { c, id: s.j.user.id };
  };

  const F1 = await mkUser('followind');
  const F2 = await mkUser('followpoor');
  const F3 = await mkUser('followoff');

  // Connect Owner -> Upstox
  const connectUpstox = async (cl, tok) => {
    await cl.req('trade=setmode', { body: { broker: 'upstox', mode: 'live' } });
    const lg = await cl.req('trade=login');
    const state = new URL(lg.j.url).searchParams.get('state');
    await fetch(`http://127.0.0.1:${PORT}/api.php?callback=1&code=${tok}&state=${state}`);
  };

  await connectUpstox(O, TOK_OWNER);
  await connectUpstox(F2.c, TOK_POOR);
  await connectUpstox(F3.c, TOK_OFF);
  await F3.c.req('trade=setmode', { body: { broker: 'upstox', mode: 'off' } });

  // F1 connects INDstocks
  await F1.c.req('trade=setmode', { body: { broker: 'indstocks', mode: 'live' } });
  await F1.c.req('trade=settoken', { body: { token: TOK_FOLLOW_IND } });

  // Enable autoCopy for F1 (2 lots), F2 (1 lot, poor), F3 (1 lot, mode off)
  await O.req('auth=admin_autocopy', { body: { id: F1.id, enabled: true, lots: 2 } });
  await O.req('auth=admin_autocopy', { body: { id: F2.id, enabled: true, lots: 1 } });
  await O.req('auth=admin_autocopy', { body: { id: F3.id, enabled: true, lots: 1 } });

  // Owner verifies GTT read endpoint works
  let r = await O.req('trade=gtt&order_id=GTT-1');
  t('trade=gtt fetches Upstox GTT rules cleanly', r.s === 200 && r.j.data && r.j.data.gtt_order_id === 'GTT-1', r);

  // Owner places automatic buy (NSE_FO|45388)
  reqs = [];
  r = await O.req('trade=place', {
    body: {
      instrument_token: 'NSE_FO|45388', quantity: 65, lots: 1, transaction_type: 'BUY',
      order_type: 'LIMIT', product: 'I', price: 200, trigger_price: 0,
      ref: 'auto-sync-test-1', label: 'AUTO BUY NIFTY', auto: true,
      attach: { sl_trigger: 120, sl_limit: 114, tgt_trigger: 360, tgt_limit: 352.8 }
    }
  });
  const b = r.j.broadcast;
  t('auto-buy places origin GTT and broadcasts copy orders', r.s === 200 && r.j.data.order_ids[0] === 'GTT-1' && b && b.eligible === 3 && b.sent === 1, r);
  t('INDstocks follower F1 received 2 lots (130 qty) smart order', b.results[F1.id].status === 'sent' && b.results[F1.id].qty === 130 && b.results[F1.id].child === 'IND-C-1', b.results[F1.id]);
  t('low-balance follower F2 was safely skipped before order placement', b.results[F2.id].status === 'skipped' && /Insufficient funds/i.test(b.results[F2.id].reason), b.results[F2.id]);
  t('mode-off follower F3 was skipped cleanly', b.results[F3.id].status === 'skipped' && /OFF/i.test(b.results[F3.id].reason), b.results[F3.id]);

  // Owner modifies trailing stop on GTT-1 -> verify Upstox trailing_gap fix AND F1 INDstocks modify!
  reqs = [];
  r = await O.req('trade=smartmodify', {
    body: { order_id: 'GTT-1', quantity: 65, trailing_gap: 67.5, sl_trigger: 202.5, sl_limit: 192.4, tgt_trigger: 360, tgt_limit: 352.8 }
  });
  const oMod = reqs.find(x => x.p === '/v3/order/gtt/modify' && x.token === TOK_OWNER);
  const f1Mod = reqs.find(x => x.p === '/smart/order/modify' && x.token === TOK_FOLLOW_IND);
  t('Upstox GTT modify sends passed trailing_gap (67.5), NOT tgt-sl spread', oMod && oMod.body.rules[1].trailing_gap === 67.5 && oMod.body.rules[1].trigger_price === 202.5, oMod && oMod.body);
  t('synced smartmodify updated follower F1 child order IND-C-1', r.s === 200 && r.j.broadcast && r.j.broadcast.sent === 1 && f1Mod && f1Mod.body.order_id === 'IND-C-1' && f1Mod.body.sl_trigger_price === 202.5, { b: r.j.broadcast, f1Mod });

  // Owner square-off step 1: cancel stop/target with squareOff:true -> F1 IND-C-1 cancelled
  reqs = [];
  r = await O.req('trade=smartcancel', { body: { order_id: 'GTT-1', squareOff: true } });
  const f1Can = reqs.find(x => x.p === '/smart/order/cancel' && x.token === TOK_FOLLOW_IND);
  t('synced smartcancel with squareOff:true cancelled follower F1 stop/target', r.s === 200 && r.j.broadcast && r.j.broadcast.sent === 1 && f1Can && f1Can.body.order_id === 'IND-C-1', r.j);

  // Owner square-off step 2: SELL with copyExit:true -> F1 held qty (130) sold-to-close!
  reqs = [];
  r = await O.req('trade=place', {
    body: {
      instrument_token: 'NSE_FO|45388', quantity: 65, transaction_type: 'SELL',
      order_type: 'LIMIT', product: 'I', price: 210, trigger_price: 0,
      ref: 'sq-sync-1', label: 'AUTO SQUAREOFF', copyExit: true, originOrderId: 'GTT-1'
    }
  });
  const f1Sell = reqs.find(x => x.p === '/order' && x.token === TOK_FOLLOW_IND);
  t('synced copyExit sold follower F1 held quantity (130)', r.s === 200 && r.j.broadcast && r.j.broadcast.sent === 1 && f1Sell && f1Sell.body.txn_type === 'SELL' && f1Sell.body.qty === 130, { b: r.j.broadcast, f1Sell });

  // Second copyExit call should see copy-link already closed
  r = await O.req('trade=place', {
    body: {
      instrument_token: 'NSE_FO|45388', quantity: 65, transaction_type: 'SELL',
      order_type: 'LIMIT', product: 'I', price: 210, trigger_price: 0,
      ref: 'sq-sync-2', label: 'AUTO SQUAREOFF', copyExit: true, originOrderId: 'GTT-1'
    }
  });
  t('closed copy-link is not exited twice', r.s === 200 && r.j.broadcast && r.j.broadcast.matched === 0, r.j.broadcast);

  php.kill();
  fake.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
