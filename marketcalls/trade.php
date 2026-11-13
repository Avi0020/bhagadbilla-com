<?php
/* =========================================================
 *  Signals — optional Upstox order connection
 *  ---------------------------------------------------------
 *  OFF by default. Nothing here can send an order until YOU change ORDER_MODE (here, or in trade-local.php).
 *
 *    'off'  : no trading at all (default).
 *    'dry'  : every order is checked and logged exactly as in live mode, but NOT sent to Upstox. Use this first.
 *    'live' : orders go to your real Upstox account with real money.
 *
 *  Needs, for 'live': an Upstox Developer App (API key + secret) with the redirect URL below registered,
 *  and your server's fixed IP registered with Upstox for order APIs. See SETUP-hostinger.txt.
 *  Keep the secret only in this file on your server. Never put it in index.html or commit it.
 *
 *  Safety rules enforced HERE on the server (the page cannot bypass them):
 *   - limit and stop-limit orders only, never market orders; prices on the 0.05 tick
 *   - index/stock option contracts only (NSE_FO / BSE_FO), market hours only, no after-market orders
 *   - SELL only to close a position you hold, never more than you hold (no option writing)
 *   - per-order value cap, per-order quantity cap, orders-per-day cap, a minimum gap between orders
 *   - every order carries a one-time reference, so a double tap or retry cannot send it twice
 *   - every attempt is logged to data/orders.log.php
 * ========================================================= */

if (!function_exists('out')) { http_response_code(404); exit; }   // only loaded through api.php

/* Your own settings can live in trade-local.php next to this file (it only contains define('ORDER_MODE', 'dry'); and the like). It is not part of the project files, so the secret never ends up in git. Values defined there win over the defaults below. */
if (is_file(__DIR__ . '/trade-local.php')) require __DIR__ . '/trade-local.php';

defined('ORDER_MODE') || define('ORDER_MODE', 'off');
defined('ORDER_BROKER') || define('ORDER_BROKER', 'upstox');   // 'upstox' or 'indstocks'
/* Automatic trading (INDstocks only, intraday Nifty / Bank Nifty options): the 24/7 runner buys a Valid call by itself WITH the stop-loss and target attached (an INDstocks
   smart order), trails the stop up as the price rises, cancels unfilled entries and squares off at AUTO_SQUAREOFF. OFF by default. It also needs "autoTrade": true in service/config.json,
   and ORDER_MODE 'live' to send real orders ('dry' only logs). Every limit below is enforced here on the server. */
defined('ORDER_AUTO') || define('ORDER_AUTO', (getenv('SIGNALS_TEST_UPSTOX') && getenv('SIGNALS_TEST_AUTO')) ? true : false);
defined('AUTO_LOTS') || define('AUTO_LOTS', 1);                // lots per automatic buy
defined('AUTO_MAX_OPEN') || define('AUTO_MAX_OPEN', 1);        // automatic positions open at once
defined('AUTO_MAX_PER_DAY') || define('AUTO_MAX_PER_DAY', 2);  // automatic buys per day
defined('AUTO_SL') || define('AUTO_SL', 0.40);                 // stop-loss: this far below the entry price (the tested value)
defined('AUTO_TARGET') || define('AUTO_TARGET', 0.80);         // target: this far above the entry price
defined('AUTO_TRAIL_START') || define('AUTO_TRAIL_START', 0.30); // the trailing stop starts once the price has been this far above entry ...
defined('AUTO_TRAIL_GIVE') || define('AUTO_TRAIL_GIVE', 0.25);   // ... and follows this far below the highest price, never below your entry price
defined('AUTO_ENTRY_UNTIL') || define('AUTO_ENTRY_UNTIL', '14:00'); // no automatic entries after this time (IST)
defined('AUTO_ENTRY_BUFFER') || define('AUTO_ENTRY_BUFFER', 0.01); // entry limit price this far above the live price, so it fills at once
defined('AUTO_ENTRY_WAIT') || define('AUTO_ENTRY_WAIT', 60);   // seconds before an unfilled entry is cancelled
defined('AUTO_SQUAREOFF') || define('AUTO_SQUAREOFF', '15:10'); // intraday positions are closed from this time (IST)
defined('UPSTOX_CLIENT_ID') || define('UPSTOX_CLIENT_ID', '');   // API key of your Upstox Developer App
defined('UPSTOX_CLIENT_SECRET') || define('UPSTOX_CLIENT_SECRET', '');  // API secret (keep private)
defined('UPSTOX_REDIRECT_URI') || define('UPSTOX_REDIRECT_URI', '');   // e.g. https://yourdomain.com/signals/api.php?callback=1  (must match the app exactly)
defined('ORDER_MAX_VALUE') || define('ORDER_MAX_VALUE', 50000); // rupees, price x quantity, per order
defined('ORDER_MAX_QTY') || define('ORDER_MAX_QTY', 5000);  // units per order
defined('ORDER_MAX_PER_DAY') || define('ORDER_MAX_PER_DAY', 10);    // orders sent per day
defined('TEST_NOGAP') || define('TEST_NOGAP', (getenv('SIGNALS_TEST_UPSTOX') && getenv('SIGNALS_TEST_NOGAP')) ? true : false);   // automated tests only: no waiting between orders
defined('ORDER_GAP_SECONDS') || define('ORDER_GAP_SECONDS', TEST_NOGAP ? 0 : 3);     // minimum seconds between orders

function t_conf() {
    $mf = ix_data_dir() . '/trade-mode.php';
    $dynMode = null;
    $dynBroker = null;
    if (is_file($mf)) {
        $dm = t_read($mf);
        if (isset($dm['mode']) && in_array($dm['mode'], ['off', 'dry', 'live'], true)) {
            $dynMode = $dm['mode'];
        }
        if (isset($dm['broker']) && in_array($dm['broker'], ['upstox', 'indstocks'], true)) {
            $dynBroker = $dm['broker'];
        }
    }
    $test = getenv('SIGNALS_TEST_UPSTOX');   // only used by the automated tests, which point everything at a fake Upstox
    if ($test) {
        $mode = $dynMode ?? (getenv('SIGNALS_TEST_MODE') ?: 'dry');
        $broker = $dynBroker ?? (getenv('SIGNALS_TEST_BROKER') ?: 'upstox');
        return ['mode' => $mode, 'api' => $test, 'hft' => $test,
                'data' => ix_data_dir(),
                'cid' => 'test-id', 'secret' => 'test-secret', 'redirect' => 'http://localhost/api.php?callback=1', 'anytime' => true,
                'broker' => $broker, 'ind' => $test];
    }
    $mode = $dynMode ?? ORDER_MODE;
    $broker = $dynBroker ?? ORDER_BROKER;
    return ['mode' => $mode, 'api' => 'https://api.upstox.com', 'hft' => 'https://api-hft.upstox.com', 'data' => ix_data_dir(),
            'cid' => UPSTOX_CLIENT_ID, 'secret' => UPSTOX_CLIENT_SECRET, 'redirect' => UPSTOX_REDIRECT_URI, 'anytime' => false,
            'broker' => $broker, 'ind' => 'https://api.indstocks.com'];
}
function t_dir($c) {
    if (!is_dir($c['data'])) @mkdir($c['data'], 0755, true);
    if (!is_file($c['data'] . '/.htaccess')) @file_put_contents($c['data'] . '/.htaccess', "Require all denied\nDeny from all\n");
    return $c['data'];
}
/* Trading files are saved as .php files that start with an exit line: even on a web server that ignores .htaccess (such as Nginx), opening one in a browser shows nothing. */
defined('T_HEAD') || define('T_HEAD', "<?php http_response_code(404); exit; ?>\n");
function t_read($f, $d = []) { if (!is_file($f)) return $d; $raw = (string)file_get_contents($f); if (strpos($raw, T_HEAD) === 0) $raw = substr($raw, strlen(T_HEAD)); return json_decode($raw, true) ?: $d; }
function t_write($f, $v) { file_put_contents($f, T_HEAD . json_encode($v), LOCK_EX); @chmod($f, 0600); }
function t_ist() { return new DateTime('now', new DateTimeZone('Asia/Kolkata')); }
function t_log($c, $arr) { $arr['t'] = t_ist()->format('c'); $f = t_dir($c) . '/orders.log.php'; if (!is_file($f)) @file_put_contents($f, T_HEAD, LOCK_EX); @file_put_contents($f, json_encode($arr) . "\n", FILE_APPEND | LOCK_EX); @chmod($f, 0600); }
function t_token($c) { $t = t_read(t_dir($c) . ($c['broker'] === 'indstocks' ? '/order-token-ind.php' : '/order-token.php')); return (!empty($t['token']) && ($t['exp'] ?? 0) > time()) ? $t : null; }
function t_call($method, $url, $token, $body = null, $extra = []) {
    $ch = curl_init($url);
    $h = ['Accept: application/json', 'Authorization: Bearer ' . $token];
    if ($body !== null) $h[] = 'Content-Type: application/json';
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => array_merge($h, $extra)]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    if ($raw === false) return [0, ['status' => 'error', 'message' => 'Upstox unreachable: ' . $err]];
    $j = json_decode($raw, true);
    return [$code, is_array($j) ? $j : ['status' => 'error', 'message' => 'Bad response from Upstox']];
}
/* ---------------- INDstocks (https://api-docs.indstocks.com) ----------------
   Auth is the raw access token in the Authorization header (no "Bearer") plus API-Version: v1. Tokens last until 7:00 AM and are pasted in the app (indstocks.com/app/api-trading/access-tokens).
   Orders must come from the static IP saved on the INDstocks dashboard. There is no sandbox, so 'dry' mode is the way to practise.
   Contracts are named like Upstox keys on purpose (NSE_FO|<id>, BSE_FO|<id>): the numeric part is the exchange security id, the same at both brokers (checked for Nifty and Sensex). */
function t_icall($c, $method, $path, $token, $body = null) {
    $ch = curl_init($c['ind'] . $path);
    $h = ['Accept: application/json', 'Authorization: ' . $token, 'API-Version: v1'];
    if ($body !== null) $h[] = 'Content-Type: application/json';
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $h]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); $err = curl_error($ch); curl_close($ch);
    if ($raw === false) return [0, ['status' => 'error', 'message' => 'INDstocks unreachable: ' . $err]];
    $j = json_decode($raw, true);
    return [$code, is_array($j) ? $j : ['status' => 'error', 'message' => 'Bad response from INDstocks']];
}
function t_ind_key($exchange, $id) { return (strtoupper((string)$exchange) === 'BSE' ? 'BSE_FO' : 'NSE_FO') . '|' . $id; }
function t_ind_status($s) {
    $u = strtoupper(trim((string)$s));
    if ($u === 'SUCCESS') return 'complete';
    if (in_array($u, ['CANCELLED', 'EXPIRED'], true)) return 'cancelled';
    if (in_array($u, ['FAILED', 'ABORTED'], true)) return 'rejected';
    return strtolower($u);
}
function t_ind_funds($c, $tk) {
    [$code, $j] = t_icall($c, 'GET', '/funds', $tk['token']);
    if ($code !== 200) return null;
    $v = $j['data']['detailed_avl_balance']['option_buy'] ?? ($j['data']['withdrawal_balance'] ?? null);   // balance usable for buying options
    return ['available_to_trade' => ['total' => $v === null ? null : (float)$v]];
}
function t_ind_orders($c, $tk) {
    [$code, $j] = t_icall($c, 'GET', '/order-book', $tk['token']);
    if ($code !== 200) return null;
    $o = [];
    foreach ((array)($j['data'] ?? []) as $r) {
        if (strtoupper((string)($r['segment'] ?? '')) !== 'DERIVATIVE') continue;
        $o[] = ['order_id' => (string)($r['id'] ?? ''), 'status' => t_ind_status($r['status'] ?? ''), 'transaction_type' => (string)($r['txn_type'] ?? ''), 'trading_symbol' => (string)($r['name'] ?? ''),
                'instrument_token' => t_ind_key($r['exchange'] ?? 'NSE', $r['security_id'] ?? ''), 'quantity' => (int)($r['requested_qty'] ?? 0), 'price' => (float)($r['requested_price'] ?? 0),
                'filled_quantity' => (int)($r['traded_qty'] ?? 0), 'average_price' => (float)($r['traded_price'] ?? 0), 'created_at' => (string)($r['created_at'] ?? ''), 'message' => (string)($r['extra_info'] ?? ''),
                'order_type' => (string)($r['order_type'] ?? ''), 'remarks' => (string)($r['remarks'] ?? ''), 'product' => (string)($r['product'] ?? ''), 'parent_order_id' => (string)($r['parent_order_id'] ?? ''), 'child_order_id' => (string)($r['child_order_id'] ?? ''),
                'sl_trigger_price' => (float)($r['sl_trigger_price'] ?? 0), 'sl_limit_price' => (float)($r['sl_limit_price'] ?? 0), 'tgt_trigger_price' => (float)($r['tgt_trigger_price'] ?? 0), 'tgt_limit_price' => (float)($r['tgt_limit_price'] ?? 0)];
    }
    usort($o, function ($a, $b) { return strcmp($b['created_at'], $a['created_at']); });
    return $o;
}
function t_ind_positions($c, $tk) {
    [$code, $j] = t_icall($c, 'GET', '/portfolio/positions?segment=derivative', $tk['token']);
    if ($code !== 200) return null;
    $rows = []; $ids = ['NFO' => [], 'BFO' => []];
    foreach ((array)($j['data'] ?? []) as $p) {
        $q = (int)($p['net_qty'] ?? 0); $ot = strtoupper((string)($p['drv_option_type'] ?? ''));
        if ($q === 0 || !in_array($ot, ['CE', 'PE'], true)) continue;
        $bse = strtoupper((string)($p['exchange'] ?? 'NSE')) === 'BSE'; $id = (string)($p['security_id'] ?? '');
        $ids[$bse ? 'BFO' : 'NFO'][] = $id;
        $ex = strtotime((string)($p['drv_expiry_date'] ?? ''));
        $rows[] = ['id' => $id, 'bse' => $bse, 'p' => $p, 'q' => $q, 'ot' => $ot, 'sym' => strtoupper((string)($p['symbol'] ?? '')) . ' ' . (float)($p['drv_strike_price'] ?? 0) . ' ' . $ot . ($ex ? ' ' . strtoupper(date('j M y', $ex)) : '')];
    }
    $ltp = [];   // last prices from the quote endpoint (the positions endpoint has none); a failure just leaves them at 0
    foreach ($ids as $pre => $list) if ($list) {
        [$qc, $qj] = t_icall($c, 'GET', '/market/quotes/ltp?scrip-codes=' . implode(',', array_map(function ($i) use ($pre) { return $pre . '_' . $i; }, array_unique($list))), $tk['token']);
        if ($qc === 200) foreach ((array)($qj['data'] ?? []) as $k => $v) $ltp[substr((string)$k, 4)] = (float)($v['live_price'] ?? 0);
    }
    $o = [];
    foreach ($rows as $r) {
        $avg = (float)($r['p']['avg_price'] ?? 0); $last = $ltp[$r['id']] ?? 0.0;
        $o[] = ['instrument_token' => t_ind_key($r['bse'] ? 'BSE' : 'NSE', $r['id']), 'trading_symbol' => trim($r['sym']), 'quantity' => $r['q'], 'average_price' => $avg, 'last_price' => $last,
                'pnl' => $last > 0 ? ($last - $avg) * $r['q'] : 0.0, 'product' => strtoupper((string)($r['p']['product'] ?? '')) === 'INTRADAY' ? 'I' : 'D'];
    }
    return $o;
}
/* a buy must name the contract the person saw; the server looks it up at INDstocks and refuses if the id, underlying, expiry, strike or lot size do not match */
function t_ind_verify($c, $tk, $inst, $ct, $qty, &$lotOut = 0) {
    if (!is_array($ct)) return 'A buy needs the contract details (underlying, expiry, strike, CE or PE).';
    $u = strtoupper((string)($ct['u'] ?? '')); $e = (string)($ct['e'] ?? ''); $k = (float)($ct['k'] ?? 0); $t = strtoupper((string)($ct['t'] ?? ''));
    if (!preg_match('/^[A-Z0-9_-]{2,20}$/', $u)) return 'The underlying symbol is not valid.';
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $e) || $k <= 0 || !in_array($t, ['CE', 'PE'], true)) return 'The contract details are incomplete.';
    if (strpos($inst, ($u === 'SENSEX' ? 'BSE_FO' : 'NSE_FO') . '|') !== 0) return 'The contract does not belong to ' . $u . '.';
    if (!$tk) return '';   // a dry run before the token is pasted cannot look it up
    [$code, $j] = t_icall($c, 'GET', '/market/instruments/search?' . http_build_query(['underlying' => $u, 'segment' => 'DERIVATIVE', 'expiry' => $e, 'strike_from' => $k, 'strike_to' => $k, 'option_type' => $t]), $tk['token']);
    if ($code !== 200) return 'Could not check the contract with INDstocks: ' . t_err($j, 'HTTP ' . $code);
    $row = null; foreach ((array)($j['data']['instruments'] ?? []) as $r) if ((float)($r['strike_price'] ?? 0) == $k && strtoupper((string)($r['option_type'] ?? '')) === $t) $row = $r;
    if (!$row) return 'INDstocks has no such contract (' . $u . ' ' . $e . ' ' . $k . ' ' . $t . ').';
    if ((string)$row['security_id'] !== substr($inst, strpos($inst, '|') + 1)) return 'The contract id does not match the one INDstocks lists for this strike and expiry. Order refused.';
    $lot = (int)($row['lot_size'] ?? 0); $lotOut = $lot; if ($lot > 0 && $qty % $lot !== 0) return 'Quantity must be a multiple of the lot size (' . $lot . ').';
    return '';
}
function t_auto_status($c, $dir, $ind, $mode) {
    $killed = !empty(t_read($dir . '/auto-off.php')['off']);
    return ['configured' => (bool)ORDER_AUTO, 'killed' => $killed, 'enabled' => (bool)ORDER_AUTO && $ind && $mode !== 'off' && !$killed, 'lots' => AUTO_LOTS, 'maxOpen' => AUTO_MAX_OPEN, 'maxPerDay' => AUTO_MAX_PER_DAY,
            'sl' => AUTO_SL, 'target' => AUTO_TARGET, 'trailStart' => AUTO_TRAIL_START, 'trailGive' => AUTO_TRAIL_GIVE, 'entryUntil' => AUTO_ENTRY_UNTIL, 'entryBuffer' => AUTO_ENTRY_BUFFER, 'entryWait' => AUTO_ENTRY_WAIT, 'squareOff' => AUTO_SQUAREOFF];
}
function t_hm($s) { $p = explode(':', (string)$s); return (int)$p[0] * 60 + (int)($p[1] ?? 0); }
function t_err($j, $dflt) { return $j['errors'][0]['message'] ?? $j['message'] ?? $dflt; }
function t_market_open($c) {
    if ($c['anytime']) return true;
    $n = t_ist(); $d = (int)$n->format('N'); $m = (int)$n->format('G') * 60 + (int)$n->format('i');
    return $d <= 5 && $m >= 555 && $m < 930;
}
function t_tick_ok($p) { return $p > 0 && abs(round($p * 100) - $p * 100) < 1e-6 && ((int)round($p * 100)) % 5 === 0; }

/* browser comes back from the Upstox login with ?callback=1&code=...&state=...  (no PIN header here: protected by the one-time state instead) */
function trade_callback() {
    $c = t_conf();
    header('Content-Type: text/html; charset=utf-8');
    $page = function ($title, $msg) { echo '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#0A0E13;color:#E7ECF1;padding:28px;max-width:520px;margin:auto"><h2>' . htmlspecialchars($title) . '</h2><p>' . htmlspecialchars($msg) . '</p>'; exit; };
    if ($c['mode'] === 'off') $page('Trading is switched off', 'ORDER_MODE is off in trade.php.');
    if ($c['broker'] === 'indstocks') $page('Not used', 'INDstocks uses a daily token that you paste in the app, so there is no login page.');
    $dir = t_dir($c); $sf = $dir . '/oauth-state.php'; $st = t_read($sf);
    $state = (string)($_GET['state'] ?? ''); $code = (string)($_GET['code'] ?? '');
    if ($state === '' || $code === '' || empty($st['state']) || !hash_equals($st['state'], $state) || ($st['exp'] ?? 0) < time()) $page('Login not accepted', 'This login link is not valid or has expired. Start again from the Paper tab.');
    t_write($sf, []);   // one use only
    $ch = curl_init($c['api'] . '/v2/login/authorization/token');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 15, CURLOPT_POST => true, CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_POSTFIELDS => http_build_query(['code' => $code, 'client_id' => $c['cid'], 'client_secret' => $c['secret'], 'redirect_uri' => $c['redirect'], 'grant_type' => 'authorization_code'])]);
    $raw = curl_exec($ch); curl_close($ch); $j = json_decode((string)$raw, true);
    if (empty($j['access_token'])) { t_log($c, ['ev' => 'login-failed']); $page('Upstox did not give a token', t_err((array)$j, 'Check the API key, secret and redirect URL.')); }
    $n = t_ist(); $exp = clone $n; $exp->setTime(3, 30, 0); if ($exp <= $n) $exp->modify('+1 day');   // tokens last until 3:30 AM the next day
    t_write($dir . '/order-token.php', ['token' => $j['access_token'], 'exp' => $exp->getTimestamp(), 'user' => $j['user_name'] ?? '', 'at' => time()]);
    t_log($c, ['ev' => 'login-ok', 'user' => $j['user_name'] ?? '']);
    $page('Connected to Upstox', 'You can close this tab and go back to the app. The connection lasts until about 3:30 AM tomorrow, then you log in again.');
}

function trade_handle($action) {
    $c = t_conf(); $mode = $c['mode']; $dir = t_dir($c);
    if (!in_array($mode, ['off', 'dry', 'live'], true)) out(500, ['status' => 'error', 'message' => 'ORDER_MODE must be off, dry or live']);
    if (!in_array($c['broker'], ['upstox', 'indstocks'], true)) out(500, ['status' => 'error', 'message' => 'ORDER_BROKER must be upstox or indstocks']);
    $ind = $c['broker'] === 'indstocks'; $bn = $ind ? 'INDstocks' : 'Upstox';
    $tk = t_token($c);
    $lim = ['maxValue' => ORDER_MAX_VALUE, 'maxQty' => ORDER_MAX_QTY, 'perDay' => ORDER_MAX_PER_DAY];
    $configured = $ind ? true : ($c['cid'] !== '' && $c['secret'] !== '' && $c['redirect'] !== '');
    if ($action === 'status') {
        $lg = t_read($dir . '/order-log.php'); $today = t_ist()->format('Y-m-d');
        out(200, ['status' => 'success', 'mode' => $mode, 'broker' => $c['broker'], 'tokenMode' => $ind ? 'paste' : 'login', 'configured' => $configured, 'connected' => (bool)$tk, 'user' => $tk['user'] ?? '', 'expires' => $tk['exp'] ?? 0,
                  'auto' => t_auto_status($c, $dir, $ind, $mode), 'limits' => $lim, 'sentToday' => ($lg['day'] ?? '') === $today ? (int)($lg['count'] ?? 0) : 0, 'marketOpen' => t_market_open($c)]);
    }
    if ($mode === 'off') out(403, ['status' => 'error', 'message' => 'Trading is switched off. Set ORDER_MODE in trade.php on the server to use it.']);

    if ($action === 'settoken') {   // INDstocks: the daily token is pasted in the app, checked with one harmless read, and kept only on the server
        if (!$ind) out(400, ['status' => 'error', 'message' => 'Upstox logs in with the Connect button, not a pasted token.']);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['status' => 'error', 'message' => 'POST required']);
        $in = json_decode((string)file_get_contents('php://input'), true); $tok = trim((string)($in['token'] ?? '')); $pp = explode('.', $tok); $gen = !empty($in['generated']);   // generated: the runner got it from /generate/token (valid 24 hours)
        if (count($pp) !== 3 && (!$gen || strlen($tok) < 20 || !preg_match('#^[A-Za-z0-9._~+/=-]+$#', $tok))) out(422, ['status' => 'error', 'message' => 'That does not look like an INDstocks access token.']);
        $pl = count($pp) === 3 ? json_decode((string)base64_decode(strtr($pp[1], '-_', '+/')), true) : null; $exp = (int)($pl['exp'] ?? 0);
        if ($exp === 0 && $gen) $exp = time() + 23 * 3600;
        if ($exp <= time() + 60) out(422, ['status' => 'error', 'message' => 'This token has already expired. Generate a new one on the INDstocks dashboard.']);
        [$code, $j] = t_icall($c, 'GET', '/funds', $tok); if ($code !== 200) out(422, ['status' => 'error', 'message' => 'INDstocks did not accept this token (' . t_err($j, 'HTTP ' . $code) . ').']);
        t_write($dir . '/order-token-ind.php', ['token' => $tok, 'exp' => $exp, 'user' => '', 'at' => time()]); t_log($c, ['ev' => 'token-saved', 'broker' => 'indstocks', 'exp' => $exp]);
        out(200, ['status' => 'success', 'expires' => $exp]);
    }
    if ($action === 'autoswitch') {   // the kill switch: turn automatic trading off (or back on) at once, from the app
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['status' => 'error', 'message' => 'POST required']);
        $in = json_decode((string)file_get_contents('php://input'), true); t_write($dir . '/auto-off.php', ['off' => empty($in['on']), 'at' => time()]); t_log($c, ['ev' => 'auto-switch', 'on' => !empty($in['on'])]);
        out(200, ['status' => 'success', 'auto' => t_auto_status($c, $dir, $ind, $mode)]);
    }
    if ($action === 'autostate') {   // the runner keeps its automatic-trading ledger here, so a restart never forgets an open trade
        $f = $dir . '/auto-state.php';
        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $raw = (string)file_get_contents('php://input'); if (strlen($raw) > 400000) out(413, ['status' => 'error', 'message' => 'State too large']);
            $in = json_decode($raw, true); if (!is_array($in) || !is_array($in['state'] ?? null)) out(400, ['status' => 'error', 'message' => 'Bad request']);
            t_write($f, ['state' => $in['state'], 'at' => time()]); out(200, ['status' => 'success']);
        }
        $a = t_read($f); out(200, ['status' => 'success', 'state' => $a['state'] ?? null]);
    }
    if ($action === 'smartmodify' || $action === 'smartcancel') {   // INDstocks smart orders: trail the stop (modify) or cancel the entry / its stop and target
        if (!$ind) out(400, ['status' => 'error', 'message' => 'Smart orders exist for INDstocks only.']);
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['status' => 'error', 'message' => 'POST required']);
        $in = json_decode((string)file_get_contents('php://input'), true); if (!is_array($in)) out(400, ['status' => 'error', 'message' => 'Bad request']);
        $oid = preg_replace('/[^A-Za-z0-9_-]/', '', (string)($in['order_id'] ?? '')); if ($oid === '') out(400, ['status' => 'error', 'message' => 'order_id missing']);
        $lf = $dir . '/order-log.php'; $lg = t_read($lf); $mods = (array)($lg['mods'] ?? []);
        if ($action === 'smartmodify') {
            $f = ['sl_trigger', 'sl_limit', 'tgt_trigger', 'tgt_limit']; $v = [];
            foreach ($f as $k) { $v[$k] = round((float)($in[$k] ?? 0), 2); if (!t_tick_ok($v[$k])) out(422, ['status' => 'error', 'message' => $k . ' must be above 0 and a multiple of 0.05.']); }
            if ($v['sl_limit'] > $v['sl_trigger'] || $v['tgt_limit'] > $v['tgt_trigger'] || $v['sl_trigger'] >= $v['tgt_trigger']) out(422, ['status' => 'error', 'message' => 'The stop and target prices are not consistent.']);
            $m = $mods[$oid] ?? ['n' => 0, 't' => 0]; if ($m['n'] >= 20) out(422, ['status' => 'error', 'message' => 'Modification limit for this order reached.']); if (!TEST_NOGAP && time() - (int)$m['t'] < 20) out(422, ['status' => 'error', 'message' => 'Wait before changing this order again.']);
            $mods[$oid] = ['n' => $m['n'] + 1, 't' => time()]; $lg['mods'] = $mods; t_write($lf, $lg);
            t_log($c, ['ev' => $mode === 'dry' ? 'dry-smart-modify' : 'smart-modify', 'mode' => $mode, 'order_id' => $oid] + $v);
            if ($mode === 'dry') out(200, ['status' => 'success', 'mode' => 'dry', 'note' => 'Dry run: nothing was sent to INDstocks.']);
            if (!$tk) out(422, ['status' => 'error', 'message' => 'Not connected to INDstocks. Paste today\'s token.']);
            [$code, $j] = t_icall($c, 'POST', '/smart/order/modify', $tk['token'], ['order_id' => $oid, 'segment' => 'DERIVATIVE', 'algo_id' => '99999', 'sl_trigger_price' => $v['sl_trigger'], 'sl_limit_price' => $v['sl_limit'], 'tgt_trigger_price' => $v['tgt_trigger'], 'tgt_limit_price' => $v['tgt_limit']]);
            t_log($c, ['ev' => 'smart-modify-reply', 'http' => $code, 'reply' => $j]);
            out($code === 200 && ($j['status'] ?? '') !== 'error' ? 200 : 502, $code === 200 && ($j['status'] ?? '') !== 'error' ? ['status' => 'success', 'mode' => 'live', 'data' => $j['data'] ?? null] : ['status' => 'error', 'message' => t_err($j, 'INDstocks refused the change (HTTP ' . $code . ').')]);
        }
        t_log($c, ['ev' => $mode === 'dry' ? 'dry-smart-cancel' : 'smart-cancel', 'mode' => $mode, 'order_id' => $oid]);
        if ($mode === 'dry') out(200, ['status' => 'success', 'mode' => 'dry', 'note' => 'Dry run: nothing was sent to INDstocks.']);
        if (!$tk) out(422, ['status' => 'error', 'message' => 'Not connected to INDstocks. Paste today\'s token.']);
        [$code, $j] = t_icall($c, 'POST', '/smart/order/cancel', $tk['token'], ['order_id' => $oid, 'segment' => 'DERIVATIVE']);
        out($code === 200 ? 200 : 502, $code === 200 ? ['status' => 'success', 'mode' => 'live', 'data' => $j['data'] ?? null] : ['status' => 'error', 'message' => t_err($j, 'Cancel failed')]);
    }
    if ($action === 'login') {
        if ($ind) out(400, ['status' => 'error', 'message' => 'INDstocks uses a daily token: paste it in the Paper tab.']);
        if (!$configured) out(400, ['status' => 'error', 'message' => 'Fill UPSTOX_CLIENT_ID, UPSTOX_CLIENT_SECRET and UPSTOX_REDIRECT_URI in trade.php first.']);
        $state = bin2hex(random_bytes(16)); t_write($dir . '/oauth-state.php', ['state' => $state, 'exp' => time() + 600]);
        out(200, ['status' => 'success', 'url' => $c['api'] . '/v2/login/authorization/dialog?' . http_build_query(['response_type' => 'code', 'client_id' => $c['cid'], 'redirect_uri' => $c['redirect'], 'state' => $state])]);
    }
    /* reads */
    if (in_array($action, ['funds', 'positions', 'orders', 'order'], true)) {
        if (!$tk) out(200, ['status' => 'success', 'connected' => false, 'data' => in_array($action, ['positions', 'orders'], true) ? [] : null]);
        if ($ind) {
            if ($action === 'funds') { $f = t_ind_funds($c, $tk); if ($f === null) out(502, ['status' => 'error', 'message' => 'Funds unavailable']); out(200, ['status' => 'success', 'data' => $f]); }
            if ($action === 'positions') { $p = t_ind_positions($c, $tk); if ($p === null) out(502, ['status' => 'error', 'message' => 'Positions unavailable']); out(200, ['status' => 'success', 'data' => $p]); }
            $ol = t_ind_orders($c, $tk); if ($ol === null) out(502, ['status' => 'error', 'message' => 'Orders unavailable']);
            if ($action === 'orders') out(200, ['status' => 'success', 'data' => array_slice($ol, 0, 20)]);
            $id = preg_replace('/[^A-Za-z0-9_-]/', '', (string)($_GET['order_id'] ?? '')); if ($id === '') out(400, ['status' => 'error', 'message' => 'order_id missing']);
            foreach ($ol as $o) if ($o['order_id'] === $id) out(200, ['status' => 'success', 'data' => $o]);
            out(502, ['status' => 'error', 'message' => 'Order not found']);
        }
        if ($action === 'funds') { [$code, $j] = t_call('GET', $c['api'] . '/v3/user/get-funds-and-margin', $tk['token'], null, ['Api-Version: 3.0']); if ($code !== 200) out(502, ['status' => 'error', 'message' => t_err($j, 'Funds unavailable')]); out(200, ['status' => 'success', 'data' => $j['data'] ?? null]); }
        if ($action === 'positions') { $p = t_positions($c, $tk); if ($p === null) out(502, ['status' => 'error', 'message' => 'Positions unavailable']); out(200, ['status' => 'success', 'data' => $p]); }
        if ($action === 'orders') { [$code, $j] = t_call('GET', $c['api'] . '/v2/order/retrieve-all', $tk['token']); if ($code !== 200) out(502, ['status' => 'error', 'message' => t_err($j, 'Orders unavailable')]); out(200, ['status' => 'success', 'data' => array_slice(array_reverse((array)($j['data'] ?? [])), 0, 20)]); }
        $id = preg_replace('/[^A-Za-z0-9_-]/', '', (string)($_GET['order_id'] ?? '')); if ($id === '') out(400, ['status' => 'error', 'message' => 'order_id missing']);
        [$code, $j] = t_call('GET', $c['api'] . '/v2/order/details?order_id=' . $id, $tk['token']); if ($code !== 200) out(502, ['status' => 'error', 'message' => t_err($j, 'Order not found')]); out(200, ['status' => 'success', 'data' => $j['data'] ?? null]);
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST' && $action !== 'cancel') out(405, ['status' => 'error', 'message' => 'POST required']);
    if ($action === 'cancel') {
        $id = preg_replace('/[^A-Za-z0-9_-]/', '', (string)($_GET['order_id'] ?? '')); if ($id === '') out(400, ['status' => 'error', 'message' => 'order_id missing']);
        t_log($c, ['ev' => 'cancel', 'mode' => $mode, 'order_id' => $id]);
        if ($mode === 'dry') out(200, ['status' => 'success', 'mode' => 'dry', 'data' => ['order_id' => $id], 'note' => 'Dry run: nothing was sent to ' . $bn . '.']);
        if (!$tk) out(422, ['status' => 'error', 'message' => 'Not connected to ' . $bn . '. ' . ($ind ? 'Paste today\'s token.' : 'Log in again.')]);
        if ($ind) { [$code, $j] = t_icall($c, 'POST', '/order/cancel', $tk['token'], ['order_id' => $id, 'segment' => 'DERIVATIVE']); out($code === 200 ? 200 : 502, $code === 200 ? ['status' => 'success', 'mode' => 'live', 'data' => ['order_id' => $id]] : ['status' => 'error', 'message' => t_err($j, 'Cancel failed')]); }
        [$code, $j] = t_call('DELETE', $c['hft'] . '/v3/order/cancel?order_id=' . $id, $tk['token']);
        out($code === 200 ? 200 : 502, $code === 200 ? ['status' => 'success', 'mode' => 'live', 'data' => $j['data'] ?? null] : ['status' => 'error', 'message' => t_err($j, 'Cancel failed')]);
    }
    if ($action !== 'place') out(400, ['status' => 'error', 'message' => 'Unknown action']);

    /* ---- place an order ---- */
    $in = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($in)) out(400, ['status' => 'error', 'message' => 'Bad request']);
    $inst = (string)($in['instrument_token'] ?? ''); $qty = (int)($in['quantity'] ?? 0); $side = strtoupper((string)($in['transaction_type'] ?? ''));
    $type = strtoupper((string)($in['order_type'] ?? '')); $prod = strtoupper((string)($in['product'] ?? '')); $price = round((float)($in['price'] ?? 0), 2);
    $trig = round((float)($in['trigger_price'] ?? 0), 2); $ref = preg_replace('/[^A-Za-z0-9_|:-]/', '', (string)($in['ref'] ?? '')); $label = substr(preg_replace('/[^A-Za-z0-9 ._|-]/', '', (string)($in['label'] ?? '')), 0, 80);
    $reject = function ($why) use ($c, $mode, $inst, $qty, $side, $type, $price, $label) { t_log($c, ['ev' => 'rejected', 'mode' => $mode, 'why' => $why, 'inst' => $inst, 'qty' => $qty, 'side' => $side, 'type' => $type, 'price' => $price, 'label' => $label]); out(422, ['status' => 'error', 'message' => $why]); };
    if (!preg_match('/^(NSE_FO|BSE_FO)\|[0-9]{3,9}$/', $inst)) $reject('Only index and stock option contracts are allowed.');
    if (!in_array($side, ['BUY', 'SELL'], true)) $reject('Side must be BUY or SELL.');
    if (!in_array($type, ['LIMIT', 'SL'], true)) $reject('Only limit and stop-limit orders are allowed. Market orders are switched off.');
    if (!in_array($prod, ['I', 'D'], true)) $reject('Product must be I (intraday) or D (overnight).');
    $att = is_array($in['attach'] ?? null) ? $in['attach'] : null; $isAuto = !empty($in['auto']); $lot = 0;
    if ($ind && $type === 'SL') $reject('INDstocks has no stop order for an open position in its API (stops exist only attached to a new order). Place the stop in the INDstocks app.');
    if ($qty < 1 || $qty > ORDER_MAX_QTY) $reject('Quantity must be between 1 and ' . ORDER_MAX_QTY . '.');
    if (!t_tick_ok($price)) $reject('Price must be above 0 and a multiple of 0.05.');
    if ($att !== null) {   // buy with the stop-loss and target attached (INDstocks smart order); intraday, NSE index options only
        if (!$ind) $reject('A buy with an attached stop and target is available for INDstocks only.');
        if ($side !== 'BUY') $reject('Only a buy can carry an attached stop and target.');
        if ($prod !== 'I') $reject('The attached stop and target are intraday only: INDstocks smart orders are valid for one day, so an overnight position would lose them.');
        if (strpos($inst, 'NSE_FO|') !== 0) $reject('Attached stops work for NSE options (Nifty, Bank Nifty, and NSE stocks). Sensex smart orders are not documented by INDstocks, so place those without a stop and set it in the INDstocks app.');
        foreach (['sl_trigger', 'sl_limit', 'tgt_trigger', 'tgt_limit'] as $k) { $att[$k] = round((float)($att[$k] ?? 0), 2); if (!t_tick_ok($att[$k])) $reject($k . ' must be above 0 and a multiple of 0.05.'); }
        if (!($att['sl_limit'] <= $att['sl_trigger'] && $att['sl_trigger'] < $price && $price < $att['tgt_trigger'] && $att['tgt_limit'] <= $att['tgt_trigger'] && $att['tgt_limit'] > $price)) $reject('The stop must sit below the entry price and the target above it (stop limit not above its trigger, target limit above the entry).');
        $dn = ($price - $att['sl_trigger']) / $price; $up = ($att['tgt_trigger'] - $price) / $price;
        if ($dn < 0.05 || $dn > 0.6) $reject('The stop must be 5% to 60% below the entry price.');
        if ($up < 0.1 || $up > 3) $reject('The target must be 10% to 300% above the entry price.');
    } elseif ($isAuto) $reject('Automatic orders must carry the stop and target.');
    if ($type === 'SL') { if (!t_tick_ok($trig)) $reject('The trigger price must be above 0 and a multiple of 0.05.'); if ($side === 'SELL' && $price > $trig) $reject('For a sell stop the limit price cannot be above the trigger.'); if ($side === 'BUY' && $price < $trig) $reject('For a buy stop the limit price cannot be below the trigger.'); }
    else $trig = 0;
    if ($qty * $price > ORDER_MAX_VALUE) $reject('This order is worth Rs ' . number_format($qty * $price) . ', above the limit of Rs ' . number_format(ORDER_MAX_VALUE) . ' set in trade.php.');
    if (strlen($ref) < 8) $reject('Missing order reference.');
    if ($mode === 'live' && !t_market_open($c)) $reject('Live orders are accepted only during market hours (9:15 AM to 3:30 PM, Monday to Friday). Switch to Dry Run to test anytime.');
    $lf = $dir . '/order-log.php'; $lg = t_read($lf); $today = t_ist()->format('Y-m-d');
    if (($lg['day'] ?? '') !== $today) $lg = ['day' => $today, 'count' => 0, 'refs' => $lg['refs'] ?? [], 'last' => 0];
    $lg['refs'] = array_filter((array)($lg['refs'] ?? []), function ($t) { return $t > time() - 86400; });
    if (isset($lg['refs'][$ref])) $reject('This order was already sent. Create a new one if you want another.');
    if (time() - (int)($lg['last'] ?? 0) < ORDER_GAP_SECONDS) $reject('Wait a few seconds between orders.');
    if ((int)$lg['count'] >= ORDER_MAX_PER_DAY) $reject('Daily order limit of ' . ORDER_MAX_PER_DAY . ' reached (set in trade.php).');
    if ($mode === 'live' && !$tk) out(422, ['status' => 'error', 'message' => 'Not connected to ' . $bn . ' today. ' . ($ind ? 'Paste today\'s token in the Paper tab.' : 'Log in from the Paper tab.')]);
    if ($ind && $side === 'BUY') { $why = t_ind_verify($c, $tk, $inst, $in['contract'] ?? null, $qty, $lot); if ($why !== '') $reject($why); }
    if ($isAuto) {   // limits for orders the runner places by itself
        $AU = t_auto_status($c, $dir, $ind, $mode); if (!$AU['enabled']) $reject('Automatic trading is switched off (ORDER_AUTO in trade-local.php, or the kill switch).');
        $n2 = t_ist(); $hm = (int)$n2->format('G') * 60 + (int)$n2->format('i'); if (!$c['anytime'] && ($hm < 585 || $hm > t_hm(AUTO_ENTRY_UNTIL))) $reject('Automatic entries are allowed only between 9:45 AM and ' . AUTO_ENTRY_UNTIL . '.');
        if ((int)($lg['autoCount'] ?? 0) >= AUTO_MAX_PER_DAY) $reject('Automatic trading daily limit reached (' . AUTO_MAX_PER_DAY . ').');
        if ($lot > 0 && $qty > $lot * AUTO_LOTS) $reject('Automatic orders are limited to ' . AUTO_LOTS . ' lot(s).');
        if ($tk) { $pp = t_ind_positions($c, $tk); if ($pp === null) $reject('Could not read your positions to check the open-position limit.'); $open = 0; foreach ($pp as $p) if ($p['quantity'] > 0 && $p['product'] === 'I') $open++; if ($open >= AUTO_MAX_OPEN) $reject('Automatic trading already has ' . $open . ' open position(s) (limit ' . AUTO_MAX_OPEN . ').'); }
        elseif ($mode === 'live') $reject('Position check unavailable.');
    }
    if ($side === 'SELL') {   // only to close what you hold
        if ($tk) {
            $pos = $ind ? t_ind_positions($c, $tk) : t_positions($c, $tk); if ($pos === null) $reject('Could not read your positions to check this sell.');
            $held = 0; foreach ($pos as $p) if ($p['instrument_token'] === $inst && $p['product'] === $prod) $held = max($held, (int)$p['quantity']);
            if ($qty > $held) $reject($held > 0 ? 'You hold only ' . $held . ' of this contract. Selling more would open a short position, which this app does not allow.' : 'You hold no long position in this contract for this product. This app only sells to close.');
        } elseif ($mode === 'live') $reject('Position check unavailable.');
    }
    $lg['refs'][$ref] = time(); $lg['last'] = time(); $lg['count'] = (int)$lg['count'] + 1; if ($isAuto) $lg['autoCount'] = (int)($lg['autoCount'] ?? 0) + 1; t_write($lf, $lg);
    $sum = ['mode' => $mode, 'inst' => $inst, 'qty' => $qty, 'side' => $side, 'type' => $type, 'product' => $prod, 'price' => $price, 'trigger' => $trig, 'label' => $label, 'ref' => $ref, 'attach' => $att, 'auto' => $isAuto];
    if ($mode === 'dry') { t_log($c, ['ev' => 'dry-order'] + $sum); out(200, ['status' => 'success', 'mode' => 'dry', 'data' => ['order_ids' => ['DRY' . time()]], 'note' => 'Dry run: the order passed every check but was NOT sent to ' . $bn . '.']); }
    if ($ind && $att) {   // smart order: the entry plus its stop-loss and target, placed in ONE request. If INDstocks rejects it, nothing is bought.
        [$code, $j] = t_icall($c, 'POST', '/smart/order', $tk['token'], ['txn_type' => 'BUY', 'exchange' => 'NSE', 'segment' => 'DERIVATIVE', 'product' => 'INTRADAY', 'order_type' => 'LIMIT', 'validity' => 'DAY',
            'security_id' => substr($inst, strpos($inst, '|') + 1), 'qty' => $qty, 'limit_price' => $price, 'sl_trigger_price' => $att['sl_trigger'], 'sl_limit_price' => $att['sl_limit'], 'tgt_trigger_price' => $att['tgt_trigger'], 'tgt_limit_price' => $att['tgt_limit'], 'algo_id' => '99999', 'remarks' => 'IDXSIG']);
        $od = $j['data']['order_data'][0] ?? null;
        if ($code === 200 && (($j['status'] ?? '') === 'error' || !$od || empty($od['order_id']))) $code = 502;
        if ($code === 200) $j['data'] = ['order_ids' => [(string)$od['order_id']], 'child_id' => (string)($od['child_order_details']['order_id'] ?? ''), 'order_status' => (string)($od['order_status'] ?? '')];
    } elseif ($ind) {
        $ex = strpos($inst, 'BSE_FO') === 0 ? 'BSE' : 'NSE';
        [$code, $j] = t_icall($c, 'POST', '/order', $tk['token'], ['txn_type' => $side, 'exchange' => $ex, 'segment' => 'DERIVATIVE', 'product' => $prod === 'I' ? 'INTRADAY' : 'MARGIN', 'order_type' => 'LIMIT', 'validity' => 'DAY',
            'security_id' => substr($inst, strpos($inst, '|') + 1), 'qty' => $qty, 'limit_price' => $price, 'is_amo' => false, 'algo_id' => $ex === 'BSE' ? '9999999999999999' : '99999', 'remarks' => 'IDXSIG']);
        if ($code === 200 && (($j['status'] ?? '') === 'error' || empty($j['data']['order_id']))) $code = 502;
        if ($code === 200) $j['data'] = ['order_ids' => [(string)$j['data']['order_id']], 'order_status' => (string)($j['data']['order_status'] ?? '')];
    } else
    [$code, $j] = t_call('POST', $c['hft'] . '/v3/order/place', $tk['token'], ['quantity' => $qty, 'product' => $prod, 'validity' => 'DAY', 'price' => $price, 'tag' => 'IDXSIG', 'instrument_token' => $inst,
        'order_type' => $type, 'transaction_type' => $side, 'disclosed_quantity' => 0, 'trigger_price' => $trig, 'is_amo' => false, 'slice' => false]);
    t_log($c, ['ev' => $code === 200 ? 'order-sent' : 'order-failed', 'http' => $code, 'reply' => $j] + $sum);
    if ($code !== 200) out(502, ['status' => 'error', 'message' => t_err($j, $bn . ' rejected the order (HTTP ' . $code . ').')]);
    out(200, ['status' => 'success', 'mode' => 'live', 'data' => $j['data'] ?? null]);
}
function t_positions($c, $tk) {
    [$code, $j] = t_call('GET', $c['api'] . '/v2/portfolio/short-term-positions', $tk['token']);
    if ($code !== 200) return null;
    $o = [];
    foreach ((array)($j['data'] ?? []) as $p) {
        $q = (int)($p['quantity'] ?? 0); $it = (string)($p['instrument_token'] ?? '');
        if ($q !== 0 && preg_match('/^(NSE_FO|BSE_FO)\|/', $it)) $o[] = ['instrument_token' => $it, 'trading_symbol' => (string)($p['trading_symbol'] ?? ''), 'quantity' => $q, 'average_price' => (float)($p['average_price'] ?? 0), 'last_price' => (float)($p['last_price'] ?? 0), 'pnl' => (float)($p['pnl'] ?? 0), 'product' => (string)($p['product'] ?? '')];
    }
    return $o;
}
