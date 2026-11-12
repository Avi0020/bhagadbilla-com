// Tests Email & OTP verification for user registration and login
const path = require('path'), fs = require('fs'), os = require('os'), { spawn } = require('child_process');
const ROOT = path.join(__dirname, '..'), PORT = 8162;
const PHP = process.env.PHP_EXE || (() => {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    const d = fs.readdirSync(base).find(x => x.startsWith('PHP.PHP.'));
    if (d) return path.join(base, d, 'php.exe');
  } catch (e) {}
  return 'php';
})();

let pass = 0, fail = 0;
const t = (n, c, x) => {
  if (c) { pass++; console.log('  ok  ', n); }
  else { fail++; console.log('  FAIL', n, x !== undefined ? JSON.stringify(x) : ''); }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SETUP = 'SETUP-CODE-123';

function startPhp(port, extra = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'sigotp-'));
  return {
    p: spawn(PHP, ['-S', '127.0.0.1:' + port, '-t', ROOT], {
      cwd: ROOT,
      env: {
        ...process.env,
        SIGNALS_TEST_UPSTOX: 'http://127.0.0.1:1',
        SIGNALS_TEST_DATA: data,
        SIGNALS_TEST_AUTH: 'users',
        SIGNALS_TEST_SETUP: SETUP,
        SIGNALS_TEST_OTP: '1',
        ...extra
      },
      stdio: 'ignore'
    }),
    data,
    port
  };
}

class Client {
  constructor(port) { this.port = port; this.jar = {}; }
  async req(qs, { method = 'GET', body, headers = {} } = {}) {
    const h = { ...headers };
    if (this.jar.ixs) h.Cookie = 'ixs=' + this.jar.ixs;
    if (method !== 'GET' && !('X-IX' in h) && h['X-IX'] !== null) h['X-IX'] = '1';
    if (body) h['Content-Type'] = 'application/json';
    const r = await fetch(`http://127.0.0.1:${this.port}/api.php?${qs}`, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual'
    });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    for (const c of sc) {
      const m = /^ixs=([^;]*)/.exec(c);
      if (m) {
        if (m[1] === '' || m[1] === 'deleted') delete this.jar.ixs;
        else this.jar.ixs = m[1];
      }
    }
    const tx = await r.text();
    let j;
    try { j = JSON.parse(tx); } catch (e) { j = { raw: tx }; }
    return { s: r.status, j, sc };
  }
  post(qs, body, headers) { return this.req(qs, { method: 'POST', body: body || {}, headers }); }
}

(async () => {
  console.log('Testing Email & OTP Verification Flow...');
  const S = startPhp(PORT);
  await sleep(1500);

  const anon = new Client(PORT);

  // 1. First user (owner) signs up with setup code
  console.log('\nOwner setup');
  let r = await anon.post('auth=signup', {
    username: 'avi',
    password: 'Password-Super-1',
    invite: SETUP,
    accept: true
  });
  t('owner creates account', r.s === 200 && r.j.user && r.j.user.role === 'admin', r.j);

  // 2. Request OTP with invalid email
  console.log('\nEmail OTP Request');
  const userClient = new Client(PORT);
  r = await userClient.post('auth=send_otp', { email: 'bad-email' });
  t('invalid email refused', r.s === 422 && /valid email/i.test(r.j.message), r.j);

  // 3. Request valid OTP
  r = await userClient.post('auth=send_otp', { email: 'trader@bhagadbilla.com', username: 'trader' });
  t('valid email OTP sent', r.s === 200 && r.j.status === 'success' && r.j.debug_otp, r.j);
  const otp = r.j.debug_otp;

  // 4. Rate limit check (< 60s)
  r = await userClient.post('auth=send_otp', { email: 'trader@bhagadbilla.com' });
  t('rapid resend rate limited (429)', r.s === 429 && /wait/i.test(r.j.message), r.j);

  // 5. Signup with wrong OTP
  console.log('\nUser Signup with OTP');
  r = await userClient.post('auth=signup', {
    username: 'trader',
    email: 'trader@bhagadbilla.com',
    otp: '000000',
    password: 'Trading-Password-1',
    accept: true
  });
  t('wrong OTP refused', r.s === 422 && /incorrect verification code/i.test(r.j.message), r.j);

  // 6. Signup with correct OTP
  r = await userClient.post('auth=signup', {
    username: 'trader',
    email: 'trader@bhagadbilla.com',
    otp: otp,
    password: 'Trading-Password-1',
    accept: true
  });
  t('signup with correct OTP succeeds', r.s === 200 && r.j.user && r.j.user.username === 'trader' && r.j.user.email === 'trader@bhagadbilla.com', r.j);

  // 7. Verify session
  r = await userClient.req('auth=me');
  t('user session active and contains email', r.j.user && r.j.user.email === 'trader@bhagadbilla.com', r.j);

  // 8. Log out
  await userClient.post('auth=logout');

  // 9. Log in with Email instead of username
  console.log('\nLogin with Email');
  r = await userClient.post('auth=login', {
    username: 'trader@bhagadbilla.com',
    password: 'Trading-Password-1'
  });
  t('login with email address succeeds', r.s === 200 && r.j.user && r.j.user.username === 'trader', r.j);

  // 10. Trying to send OTP for an existing email gives error
  r = await anon.post('auth=send_otp', { email: 'trader@bhagadbilla.com', purpose: 'registration' });
  t('existing email refused for new registration', r.s === 422 && /already registered/i.test(r.j.message), r.j);

  // 11. Password reset via OTP
  console.log('\nPassword Reset via OTP');
  r = await anon.post('auth=send_otp', { email: 'trader@bhagadbilla.com', purpose: 'reset' });
  t('reset OTP generated', r.s === 200 && r.j.debug_otp, r.j);
  const resetOtp = r.j.debug_otp;

  r = await anon.post('auth=reset_password_otp', {
    email: 'trader@bhagadbilla.com',
    otp: resetOtp,
    password: 'New-Password-99'
  });
  t('password reset with OTP succeeds', r.s === 200 && r.j.status === 'success', r.j);

  // Login with new password
  r = await anon.post('auth=login', {
    username: 'trader',
    password: 'New-Password-99'
  });
  t('login with new password works', r.s === 200, r.j);

  // 12. 10-day Trial and Onboarding Stats
  console.log('\nTrial Period & Onboarding Stats');
  // Check member trial details
  t('member account has 10-day trial', r.j.user && r.j.user.plan === 'trial' && r.j.user.daysLeft === 10 && !r.j.user.expired, r.j);

  // Check admin session and overview stats
  const adminClient = new Client(PORT);
  await adminClient.post('auth=login', {
    username: 'avi',
    password: 'Password-Super-1'
  });
  r = await adminClient.req('auth=me');
  t('admin account is unlimited', r.j.user && r.j.user.plan === 'unlimited' && r.j.user.daysLeft === null, r.j);

  r = await adminClient.req('auth=admin_users');
  t('admin gets onboarding stats (total, active trials, unlimited)', r.s === 200 && r.j.stats && r.j.stats.totalOnboarded === 2 && r.j.stats.activeTrials === 1 && r.j.stats.unlimitedCount === 1, r.j.stats);

  const traderRow = r.j.users.find(u => u.username === 'trader');
  t('trader row in admin table shows trial info', traderRow && traderRow.plan === 'trial' && traderRow.daysLeft === 10, traderRow);

  // Admin extends trial by 10 days
  r = await adminClient.post('auth=admin_extend_trial', { id: traderRow.id, days: 10 });
  t('admin extends user trial by 10 days', r.s === 200 && r.j.daysAdded === 10, r.j);

  // Admin sets plan to unlimited
  r = await adminClient.post('auth=admin_plan', { id: traderRow.id, plan: 'unlimited' });
  t('admin upgrades user to unlimited', r.s === 200 && r.j.plan === 'unlimited', r.j);

  // Admin sets plan back to trial
  r = await adminClient.post('auth=admin_plan', { id: traderRow.id, plan: 'trial' });
  t('admin sets user back to trial', r.s === 200 && r.j.plan === 'trial', r.j);

  // Simulate trial expiry > 15 days ago by writing directly to data/users.php
  const usersFile = path.join(S.data, 'users.php');
  let raw = fs.readFileSync(usersFile, 'utf8');
  const head = raw.slice(0, raw.indexOf('{'));
  const jsonPart = JSON.parse(raw.slice(raw.indexOf('{')));
  const now = Math.floor(Date.now() / 1000);
  const expiredTime = now - (16 * 86400); // 16 days expired
  jsonPart.users[traderRow.id].trial_exp = expiredTime;
  fs.writeFileSync(usersFile, head + JSON.stringify(jsonPart));

  // Admin stats reflect expired trial and inactive > 15 days
  r = await adminClient.req('auth=admin_users');
  t('admin stats track expired trials and inactive > 15 days', r.s === 200 && r.j.stats.expiredTrials === 1 && r.j.stats.inactiveOver15Days === 1, r.j.stats);

  // Member is now blocked from data routes due to trial expiration
  r = await anon.req('store=1');
  t('expired trial member is blocked by auth_gate (403 trial_expired)', r.s === 403 && r.j.auth === 'trial_expired' && r.j.inactiveDays >= 15, r.j);

  // Admin extends trial for expired member by 10 days
  r = await adminClient.post('auth=admin_extend_trial', { id: traderRow.id, days: 10 });
  t('admin re-activates expired member with trial extension', r.s === 200 && r.j.daysAdded === 10, r.j);

  // Member is unblocked
  r = await anon.req('store=1');
  t('extended member is unblocked (200)', r.s === 200, r.j);

  // 13. Real Trading Mode Switch with Email OTP & Easy Off
  console.log('\nReal Trading Mode Switch (Email OTP & Easy Off)');
  // Non-owner cannot check trade status or switch
  r = await anon.req('auth=admin_trade_status');
  t('non-owner cannot access admin_trade_status (403)', r.s === 403, r.j);

  // Admin checks trade status
  r = await adminClient.req('auth=admin_trade_status');
  t('admin checks trade status', r.s === 200 && r.j.broker === 'upstox', r.j);

  // Attempting to switch to live without OTP is refused
  r = await adminClient.post('auth=admin_switch_trading', { mode: 'live' });
  t('switch to live without OTP refused (422)', r.s === 422, r.j);

  // Admin requests OTP for real trading
  r = await adminClient.post('auth=admin_trade_otp', { email: 'owner@bhagadbilla.com' });
  t('admin requests real trading OTP', r.s === 200 && r.j.debug_otp, r.j);
  const tradeOtp = r.j.debug_otp;

  // Wrong OTP refused
  r = await adminClient.post('auth=admin_switch_trading', { mode: 'live', email: 'owner@bhagadbilla.com', otp: '000000' });
  t('wrong OTP for real trading refused (422)', r.s === 422 && /incorrect verification code/i.test(r.j.message), r.j);

  // Correct OTP activates live real trading!
  r = await adminClient.post('auth=admin_switch_trading', { mode: 'live', email: 'owner@bhagadbilla.com', otp: tradeOtp });
  t('correct OTP activates real trading (live mode)', r.s === 200 && r.j.mode === 'live', r.j);

  // Verify trade status endpoint reflects live mode
  r = await adminClient.req('trade=status');
  t('trade status API reports live mode', r.s === 200 && r.j.mode === 'live', r.j);

  // Switching OFF can be done easily (NO OTP required)
  r = await adminClient.post('auth=admin_switch_trading', { mode: 'off' });
  t('turning real trading OFF requires no OTP (easy off)', r.s === 200 && r.j.mode === 'off', r.j);

  // Verify trade status API confirms off
  r = await adminClient.req('trade=status');
  t('trade status API confirms switched off', r.s === 200 && r.j.mode === 'off', r.j);

  // Switching to Dry-run can also be done easily (NO OTP required)
  r = await adminClient.post('auth=admin_switch_trading', { mode: 'dry' });
  t('switching to dry run requires no OTP', r.s === 200 && r.j.mode === 'dry', r.j);

  r = await adminClient.req('trade=status');
  t('trade status API confirms dry run', r.s === 200 && r.j.mode === 'dry', r.j);

  // 14. Admin Broker Switch (Upstox <-> INDstocks)
  console.log('\nAdmin Broker Switch');
  // Invalid broker refused
  r = await adminClient.post('auth=admin_switch_broker', { broker: 'zerodha' });
  t('invalid broker refused (422)', r.s === 422, r.j);

  // Switch to INDstocks
  r = await adminClient.post('auth=admin_switch_broker', { broker: 'indstocks' });
  t('admin switches broker to indstocks', r.s === 200 && r.j.broker === 'indstocks', r.j);

  // Admin trade status reports indstocks
  r = await adminClient.req('auth=admin_trade_status');
  t('admin trade status reports indstocks', r.s === 200 && r.j.broker === 'indstocks', r.j);

  // Trade API confirms broker is now indstocks
  r = await adminClient.req('trade=status');
  t('trade status API reports broker indstocks', r.s === 200 && r.j.broker === 'indstocks', r.j);

  // Switch back to Upstox
  r = await adminClient.post('auth=admin_switch_broker', { broker: 'upstox' });
  t('admin switches broker back to upstox', r.s === 200 && r.j.broker === 'upstox', r.j);

  // Trade API confirms broker is now upstox
  r = await adminClient.req('trade=status');
  t('trade status API reports broker upstox', r.s === 200 && r.j.broker === 'upstox', r.j);

  console.log(`\nResults: ${pass} passed, ${fail} failed`);
  try { S.p.kill(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();
