<?php
/* =========================================================
 *  Signals — accounts (loaded by api.php; never opened directly)
 *  ---------------------------------------------------------
 *  Many people can use one site. Everyone signs up once (owner invite required), logs in with a username and password, and gets a PRIVATE paper-trading
 *  account. Accounts never touch each other: the account id always comes from the login session on the server, never from anything the page sends.
 *  Friends can research and paper trade only. Real-order features (trade.php) and phone alerts stay with the owner (role admin) and the owner's 24/7 runner.
 *
 *  Your settings go in auth-local.php next to this file (see auth-local.example.php). It is git-ignored and must never be uploaded to a public place:
 *      define('AUTH_MODE', 'users');            // 'users' (accounts, the default) or 'pin' (one person, the old single PIN: local use only)
 *      define('ADMIN_SETUP_CODE', '...');      // lets the FIRST account (yours) be created; ignored once an owner exists
 *      define('RUNNER_KEY', '...');            // 20+ random characters; the 24/7 runner sends it (X-Runner-Key). Leave empty if you have no runner.
 *      define('UPSTOX_TOKEN', '...');          // Upstox analytics token (read-only market data)
 *
 *  Safety rules enforced here:
 *   - passwords are stored only as bcrypt hashes; 8 to 72 characters; common passwords refused
 *   - 5 wrong passwords lock that username for 15 minutes; sign-ups are rate limited; a wrong username and a wrong password look the same
 *   - sessions are HttpOnly, SameSite=Lax cookies (Secure on https); every state-changing request must carry the app's own header and a matching Origin
 *   - disabling a user, resetting or changing a password ends their other sessions
 *   - all files are .php files that start with an exit line, so opening one in a browser shows nothing
 * ========================================================= */
if (!function_exists('out')) { http_response_code(404); exit; }

$__t = getenv('SIGNALS_TEST_UPSTOX');   // set only by the automated tests
if ($__t) {
    /* tests: every setting comes from the test environment; only the market-data token may be read from auth-local.php */
    if (is_file(__DIR__ . '/auth-local.php') && preg_match("/define\(\s*'UPSTOX_TOKEN'\s*,\s*'([^']+)'/", (string)file_get_contents(__DIR__ . '/auth-local.php'), $__m)) define('UPSTOX_TOKEN', $__m[1]);
    defined('ADMIN_SETUP_CODE') || define('ADMIN_SETUP_CODE', (string)getenv('SIGNALS_TEST_SETUP'));
    defined('RUNNER_KEY') || define('RUNNER_KEY', (string)getenv('SIGNALS_TEST_RUNNER_KEY'));
} elseif (is_file(__DIR__ . '/auth-local.php')) require __DIR__ . '/auth-local.php';
require_once __DIR__ . '/mail.php';

defined('T_HEAD') || define('T_HEAD', "<?php http_response_code(404); exit; ?>\n");
defined('UPSTOX_TOKEN') || define('UPSTOX_TOKEN', 'PASTE_YOUR_UPSTOX_ANALYTICS_TOKEN_HERE');
defined('APP_PIN') || define('APP_PIN', '2468');   // 'pin' mode only
defined('AUTH_MODE') || define('AUTH_MODE', getenv('SIGNALS_TEST_AUTH') ?: ($__t ? 'pin' : 'users'));
defined('ADMIN_SETUP_CODE') || define('ADMIN_SETUP_CODE', '');
defined('RUNNER_KEY') || define('RUNNER_KEY', '');
defined('SESSION_DAYS') || define('SESSION_DAYS', 30);
defined('MAX_USERS') || define('MAX_USERS', 200);
defined('RATE_PER_MIN') || define('RATE_PER_MIN', getenv('SIGNALS_TEST_RL') ? (int)getenv('SIGNALS_TEST_RL') : 240);   // market-data requests per person per minute
defined('TEST_FAST_HASH') || define('TEST_FAST_HASH', $__t ? true : false);
defined('REQUIRE_EMAIL_OTP') || define('REQUIRE_EMAIL_OTP', $__t ? false : true);
defined('REQUIRE_INVITE') || define('REQUIRE_INVITE', false);

/* ---------------- storage ---------------- */
function ix_data_dir() {
    $t = getenv('SIGNALS_TEST_UPSTOX');
    if ($t) $d = getenv('SIGNALS_TEST_DATA') ?: sys_get_temp_dir() . '/signals-test';
    elseif (defined('DATA_DIR') && DATA_DIR) $d = DATA_DIR;
    else $d = __DIR__ . '/data';
    if (!is_dir($d)) @mkdir($d, 0755, true);
    if (!is_file($d . '/.htaccess')) @file_put_contents($d . '/.htaccess', "Require all denied\nDeny from all\n");
    return $d;
}
function a_read($f, $d = []) { if (!is_file($f)) return $d; $raw = (string)file_get_contents($f); if (strpos($raw, T_HEAD) === 0) $raw = substr($raw, strlen(T_HEAD)); $j = json_decode($raw, true); return is_array($j) ? $j : $d; }
function a_write($f, $v) {
    $tmp = dirname($f) . '/.w' . bin2hex(random_bytes(6)) . '.php';
    file_put_contents($tmp, T_HEAD . json_encode($v), LOCK_EX); @chmod($tmp, 0600);
    if (!@rename($tmp, $f)) { file_put_contents($f, T_HEAD . json_encode($v), LOCK_EX); @unlink($tmp); }
}
function a_with_lock($fn) {
    $h = fopen(ix_data_dir() . '/auth.lock', 'c'); flock($h, LOCK_EX);
    try { return $fn(); } finally { flock($h, LOCK_UN); fclose($h); }
}
/* one private folder per account; the id is validated so a path can never leave it */
function a_udir($uid) {
    if (!preg_match('/^([a-f0-9]{16}|owner|engine)$/', (string)$uid)) out(400, ['status' => 'error', 'message' => 'Bad account id']);
    $d = ix_data_dir() . '/u/' . $uid; if (!is_dir($d)) @mkdir($d, 0755, true); return $d;
}
function a_users() { return a_read(ix_data_dir() . '/users.php', ['users' => []]); }
function a_save_users($d) { a_write(ix_data_dir() . '/users.php', $d); }
function a_invites() { return a_read(ix_data_dir() . '/invites.php', ['list' => []]); }
function a_save_invites($d) { a_write(ix_data_dir() . '/invites.php', $d); }
function a_otps() { return a_read(ix_data_dir() . '/otps.php', ['otps' => []]); }
function a_save_otps($d) { a_write(ix_data_dir() . '/otps.php', $d); }
function a_email_ok($e) { return (bool)filter_var($e, FILTER_VALIDATE_EMAIL) && strlen($e) <= 100; }
function a_find_user($query) {
    $q = strtolower(trim((string)$query));
    if ($q === '') return null;
    foreach (a_users()['users'] as $u) {
        if (strtolower($u['username']) === $q || (!empty($u['email']) && strtolower($u['email']) === $q)) return $u;
    }
    return null;
}
function a_ip() { return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0'; }
function a_https() { return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https'); }
function a_is_local() { $h = strtolower(preg_replace('/:\d+$/', '', $_SERVER['HTTP_HOST'] ?? '')); return in_array($h, ['localhost', '127.0.0.1', '[::1]'], true) || substr($h, -10) === '.localhost'; }

/* ---------------- rate limits (wrong passwords, sign-ups, market-data requests) ---------------- */
function a_locked($key) {   // seconds still locked, 0 if free
    $d = a_read(ix_data_dir() . '/auth-fail.php'); $e = $d[$key] ?? null; return ($e && ($e['u'] ?? 0) > time()) ? (int)$e['u'] - time() : 0;
}
function a_fail($key, $max, $window, $lock) {
    a_with_lock(function () use ($key, $max, $window, $lock) {
        $f = ix_data_dir() . '/auth-fail.php'; $d = a_read($f); $now = time();
        foreach ($d as $k => $e) if (($e['t'] ?? 0) < $now - 86400 && ($e['u'] ?? 0) < $now) unset($d[$k]);
        $e = $d[$key] ?? ['n' => 0, 't' => $now, 'u' => 0]; if ($now - $e['t'] > $window) $e = ['n' => 0, 't' => $now, 'u' => 0];
        $e['n']++; if ($e['n'] >= $max) { $e['u'] = $now + $lock; $e['n'] = 0; $e['t'] = $now; } $d[$key] = $e; a_write($f, $d);
    });
}
function a_clear($key) { a_with_lock(function () use ($key) { $f = ix_data_dir() . '/auth-fail.php'; $d = a_read($f); if (isset($d[$key])) { unset($d[$key]); a_write($f, $d); } }); }
function a_hit($key, $max, $window) {   // true if still allowed; counts this attempt
    return a_with_lock(function () use ($key, $max, $window) {
        $f = ix_data_dir() . '/auth-hits.php'; $d = a_read($f); $now = time();
        foreach ($d as $k => $e) if (($e['t'] ?? 0) < $now - 86400) unset($d[$k]);
        $e = $d[$key] ?? ['n' => 0, 't' => $now]; if ($now - $e['t'] > $window) $e = ['n' => 0, 't' => $now];
        $e['n']++; $d[$key] = $e; a_write($f, $d); return $e['n'] <= $max;
    });
}
function auth_rate($uid) {   // keeps one person from using up the shared Upstox quota
    if (RATE_PER_MIN <= 0) return;
    $dir = ix_data_dir() . '/rl'; if (!is_dir($dir)) @mkdir($dir, 0755, true);
    $h = fopen($dir . '/' . preg_replace('/[^a-z0-9]/', '', (string)$uid) . '.cnt', 'c+'); if (!$h) return; flock($h, LOCK_EX);
    $raw = trim((string)stream_get_contents($h)); [$t0, $n] = $raw !== '' ? array_map('intval', explode(' ', $raw . ' 0')) : [0, 0]; $now = time();
    if ($now - $t0 >= 60) { $t0 = $now; $n = 0; } $n++; ftruncate($h, 0); rewind($h); fwrite($h, $t0 . ' ' . $n); flock($h, LOCK_UN); fclose($h);
    if ($n > RATE_PER_MIN) out(429, ['status' => 'error', 'message' => 'Too many requests. Wait a minute and try again.']);
}

/* ---------------- sessions ---------------- */
function a_session($create = false) {
    if (session_status() === PHP_SESSION_ACTIVE) return true;
    if (!$create && empty($_COOKIE['ixs'])) return false;
    $dir = ix_data_dir() . '/sessions'; if (!is_dir($dir)) @mkdir($dir, 0700, true);
    session_save_path($dir); session_name('ixs');
    ini_set('session.use_strict_mode', '1'); ini_set('session.use_only_cookies', '1'); ini_set('session.gc_maxlifetime', (string)(SESSION_DAYS * 86400)); ini_set('session.gc_probability', '1'); ini_set('session.gc_divisor', '100');
    session_set_cookie_params(['lifetime' => SESSION_DAYS * 86400, 'path' => a_cookie_path(), 'secure' => a_https(), 'httponly' => true, 'samesite' => 'Lax']);
    return @session_start($create ? [] : ['read_and_close' => true]);   // read_and_close: the page fires many requests at once and must not queue on a session lock
}
function a_cookie_path() { return rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/')), '/') . '/'; }
function a_set_cookie($sid) { setcookie('ixs', $sid, ['expires' => time() + SESSION_DAYS * 86400, 'path' => a_cookie_path(), 'secure' => a_https(), 'httponly' => true, 'samesite' => 'Lax']); }

/* a short audit trail for the owner (data/auth-log.php): sign-ups, log-ins, failures, admin actions. Never passwords, codes or tokens. */
function a_log($ev, $name = '', $extra = '') {
    $f = ix_data_dir() . '/auth-log.php';
    if (is_file($f) && filesize($f) > 300000) @rename($f, ix_data_dir() . '/auth-log.old.php');
    if (!is_file($f)) @file_put_contents($f, T_HEAD, LOCK_EX);
    @file_put_contents($f, json_encode(['t' => date('c'), 'ev' => $ev, 'user' => substr((string)$name, 0, 40), 'ip' => a_ip(), 'note' => substr((string)$extra, 0, 80)]) . "\n", FILE_APPEND | LOCK_EX); @chmod($f, 0600);
}

/* ---------------- who is calling ---------------- */
function a_pub($u) { return ['id' => $u['id'], 'username' => $u['username'], 'email' => $u['email'] ?? '', 'role' => $u['role'], 'mustChange' => !empty($u['mustChange'])]; }
function a_pin_ok() { return !(APP_PIN === '2468' && !a_is_local()); }   // the default PIN is never accepted on a public host
function auth_user() {
    static $u = false; if ($u !== false) return $u;
    $rk = $_SERVER['HTTP_X_RUNNER_KEY'] ?? '';
    if ($rk !== '') {   // the owner's 24/7 runner
        if (RUNNER_KEY !== '' && strlen(RUNNER_KEY) >= 20 && hash_equals(RUNNER_KEY, $rk)) return $u = ['id' => 'engine', 'username' => 'engine', 'role' => 'runner', 'via' => 'key'];
        return $u = null;
    }
    if (AUTH_MODE === 'pin') {
        $pin = (string)($_SERVER['HTTP_X_APP_PIN'] ?? '');
        return $u = (a_pin_ok() && hash_equals(APP_PIN, $pin)) ? ['id' => 'owner', 'username' => 'owner', 'role' => 'admin', 'via' => 'pin'] : null;
    }
    if (!a_session(false)) return $u = null;
    $uid = (string)($_SESSION['uid'] ?? ''); $pwv = (int)($_SESSION['pwv'] ?? 0);
    if ($uid === '' || !preg_match('/^[a-f0-9]{16}$/', $uid)) return $u = null;
    $rec = a_users()['users'][$uid] ?? null;
    if (!$rec || !empty($rec['disabled']) || (int)($rec['pwv'] ?? 0) !== $pwv) return $u = null;
    a_set_cookie($_COOKIE['ixs']);   // sliding expiry: every visit renews the 30 days
    return $u = a_pub($rec) + ['via' => 'session'];
}
function a_csrf() {
    if (($_SERVER['HTTP_X_IX'] ?? '') !== '1') out(403, ['status' => 'error', 'message' => 'Blocked: this request did not come from the app.']);
    $o = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($o !== '') { $h = (string)parse_url($o, PHP_URL_HOST); $p = parse_url($o, PHP_URL_PORT); if (strtolower($h . ($p ? ':' . $p : '')) !== strtolower($_SERVER['HTTP_HOST'] ?? '')) out(403, ['status' => 'error', 'message' => 'Blocked: the request came from another site.']); }
}
function auth_gate($roles = null) {
    $u = auth_user();
    if (!$u) out(401, ['status' => 'error', 'auth' => 'login', 'message' => AUTH_MODE === 'pin' ? (a_pin_ok() ? 'Wrong PIN' : 'This server still uses the default PIN. Set APP_PIN in auth-local.php (or switch on accounts).') : 'Please log in.']);
    if (($u['via'] ?? '') === 'session') { if ($_SERVER['REQUEST_METHOD'] !== 'GET') a_csrf(); if (!empty($u['mustChange'])) out(403, ['status' => 'error', 'auth' => 'change', 'message' => 'Change your password first.']); }
    if ($roles && !in_array($u['role'], $roles, true)) out(403, ['status' => 'error', 'message' => 'This is not available on your account.']);
    return $u;
}
function auth_public() {
    $d = AUTH_MODE === 'users' ? a_users() : ['users' => []]; $u = auth_user();
    return ['mode' => AUTH_MODE, 'user' => $u ? a_pub($u) : null, 'firstRun' => AUTH_MODE === 'users' && !$d['users'], 'setupReady' => ADMIN_SETUP_CODE !== '',
            'open' => AUTH_MODE === 'users' && count($d['users']) < MAX_USERS, 'pinDefault' => AUTH_MODE === 'pin' && !a_pin_ok(),
            'emailOtp' => REQUIRE_EMAIL_OTP, 'requireInvite' => REQUIRE_INVITE];
}

/* ---------------- passwords and names ---------------- */
function a_name_ok($n) { return (bool)preg_match('/^[a-z0-9][a-z0-9_.-]{2,23}$/', $n); }
function a_name_reserved($n) { return in_array($n, ['admin', 'administrator', 'owner', 'engine', 'root', 'system', 'support', 'signals', 'moderator'], true); }
function a_pw_check($pw, $name) {
    if (strlen($pw) < 8) return 'The password must be at least 8 characters.';
    if (strlen($pw) > 72) return 'The password can be at most 72 characters.';
    if (preg_match('/^(.)\1+$/', $pw)) return 'That password is too easy to guess.';
    if (in_array(strtolower($pw), ['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwertyuiop', 'qwerty123', 'iloveyou', 'admin123', 'welcome1', 'abcd1234', 'india1234', 'letmein123'], true)) return 'That password is too common. Pick something longer or less usual.';
    if (strlen($name) >= 4 && stripos($pw, $name) !== false) return 'The password must not contain your username.';
    return '';
}
function a_hash($pw) { return password_hash($pw, PASSWORD_BCRYPT, ['cost' => TEST_FAST_HASH ? 4 : 11]); }
function a_dummy_verify($pw) { static $h = null; if ($h === null) $h = a_hash(bin2hex(random_bytes(8))); password_verify($pw, $h); }
function a_code() { $al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; $s = ''; for ($i = 0; $i < 12; $i++) $s .= $al[random_int(0, strlen($al) - 1)]; return substr($s, 0, 4) . '-' . substr($s, 4, 4) . '-' . substr($s, 8, 4); }
function a_user_dir_remove($uid) { if (!preg_match('/^[a-f0-9]{16}$/', (string)$uid)) return; $d = ix_data_dir() . '/u/' . $uid; if (!is_dir($d)) return; foreach (scandir($d) ?: [] as $f) { if ($f !== '.' && $f !== '..' && is_file($d . '/' . $f)) @unlink($d . '/' . $f); } @rmdir($d); }
function a_start_session_for($rec) {
    a_session(true); session_regenerate_id(true); $_SESSION['uid'] = $rec['id']; $_SESSION['pwv'] = (int)($rec['pwv'] ?? 0); $sid = session_id(); session_write_close(); a_set_cookie($sid);
}
/* an old single-account paper file (data/paper.json) moves to the first owner account so nothing is lost */
function a_adopt_legacy($uid) {
    $old = ix_data_dir() . '/paper.json'; $new = a_udir($uid) . '/paper.php';
    if (is_file($old) && !is_file($new)) { $j = json_decode((string)file_get_contents($old), true); if (is_array($j)) { a_write($new, $j); @rename($old, $old . '.migrated'); } }
}

/* ---------------- ?auth=... ---------------- */
function auth_handle($action) {
    $m = $_SERVER['REQUEST_METHOD'];
    if ($action === 'me') out(200, ['status' => 'success'] + auth_public());
    if (AUTH_MODE !== 'users') out(400, ['status' => 'error', 'message' => 'Accounts are switched off on this server (single-PIN mode).']);
    if ($m !== 'POST' && $action !== 'admin_users' && $action !== 'admin_invites') out(405, ['status' => 'error', 'message' => 'POST required']);
    if ($m === 'POST') a_csrf();
    $in = $m === 'POST' ? (json_decode((string)file_get_contents('php://input'), true) ?: []) : [];
    $ip = a_ip();

    if ($action === 'send_otp') {
        $email = strtolower(trim((string)($in['email'] ?? '')));
        $name = strtolower(trim((string)($in['username'] ?? '')));
        $purpose = trim((string)($in['purpose'] ?? 'registration'));

        if (!a_email_ok($email)) out(422, ['status' => 'error', 'message' => 'Please enter a valid email address.']);

        $existing = a_find_user($email);
        if ($purpose === 'registration') {
            if ($existing) out(422, ['status' => 'error', 'message' => 'That email address is already registered. Please log in.']);
            if ($name !== '') {
                if (!a_name_ok($name)) out(422, ['status' => 'error', 'message' => 'Username: 3 to 24 letters, digits, dot, dash or underscore.']);
                if (a_name_reserved($name)) out(422, ['status' => 'error', 'message' => 'That username is reserved. Pick another.']);
                if (a_find_user($name)) out(422, ['status' => 'error', 'message' => 'That username is taken.']);
            }
        } elseif ($purpose === 'reset') {
            if (!$existing) out(422, ['status' => 'error', 'message' => 'No account found with that email address.']);
        }

        $otps = a_otps();
        if (isset($otps['otps'][$email])) {
            $last = (int)($otps['otps'][$email]['created'] ?? 0);
            if (time() - $last < 60) {
                $wait = 60 - (time() - $last);
                out(429, ['status' => 'error', 'message' => "Please wait {$wait}s before requesting a new code."]);
            }
        }
        if (!a_hit('otp:' . $ip, 6, 3600)) {
            out(429, ['status' => 'error', 'message' => 'Too many verification code requests from this network. Try again later.']);
        }

        $otp = sprintf('%06d', random_int(100000, 999999));
        $otps['otps'][$email] = [
            'hash' => a_hash($otp),
            'exp' => time() + 600,
            'attempts' => 0,
            'created' => time(),
            'purpose' => $purpose,
        ];
        a_save_otps($otps);
        a_log('otp-requested', $email, $purpose);

        $sent = ix_send_otp_email($email, $otp, $purpose === 'reset' ? 'Password Reset' : 'Account Registration');
        if (!$sent && a_is_local()) {
            @file_put_contents(ix_data_dir() . '/otp-last.txt', "Email: {$email}\nOTP: {$otp}\nTime: " . date('c'));
        }

        $resp = ['status' => 'success', 'message' => 'Verification code sent to your email. Check your inbox and spam folder.'];
        if ((defined('DEV_SHOW_OTP') && DEV_SHOW_OTP) || getenv('SIGNALS_TEST_OTP')) {
            $resp['debug_otp'] = $otp;
        }
        out(200, $resp);
    }

    if ($action === 'reset_password_otp') {
        $email = strtolower(trim((string)($in['email'] ?? '')));
        $otp = trim((string)($in['otp'] ?? ''));
        $new = (string)($in['password'] ?? '');
        if (!a_email_ok($email)) out(422, ['status' => 'error', 'message' => 'Please enter a valid email address.']);
        $rec = a_find_user($email);
        if (!$rec) out(422, ['status' => 'error', 'message' => 'No account found with that email address.']);
        if (($why = a_pw_check($new, $rec['username'])) !== '') out(422, ['status' => 'error', 'message' => $why]);

        $otps = a_otps();
        $o = $otps['otps'][$email] ?? null;
        if (!$o || ($o['exp'] ?? 0) < time()) out(422, ['status' => 'error', 'message' => 'Verification code expired or not requested. Click Send OTP to get a new code.']);
        if (!password_verify($otp, $o['hash'])) out(422, ['status' => 'error', 'message' => 'Incorrect verification code.']);

        unset($otps['otps'][$email]); a_save_otps($otps);
        a_with_lock(function () use ($rec, $new) {
            $d = a_users();
            if (isset($d['users'][$rec['id']])) {
                $d['users'][$rec['id']]['hash'] = a_hash($new);
                $d['users'][$rec['id']]['pwv'] = (int)($d['users'][$rec['id']]['pwv'] ?? 0) + 1;
                unset($d['users'][$rec['id']]['mustChange'], $d['users'][$rec['id']]['disabled']);
                a_save_users($d);
            }
        });
        a_log('password-reset-otp', $rec['username'], $email);
        out(200, ['status' => 'success', 'message' => 'Password reset successfully! Please log in.']);
    }

    if ($action === 'signup') {
        if ($l = a_locked('sf:' . $ip)) out(429, ['status' => 'error', 'message' => 'Too many failed sign-ups from here. Try again in about ' . max(1, (int)ceil($l / 60)) . ' minute(s).']);
        if (!a_hit('s:' . $ip, 30, 3600)) out(429, ['status' => 'error', 'message' => 'Too many sign-up attempts from here. Try again later.']);
        $name = strtolower(trim((string)($in['username'] ?? '')));
        $pw = (string)($in['password'] ?? '');
        $code = trim((string)($in['invite'] ?? ''));
        $email = strtolower(trim((string)($in['email'] ?? '')));
        $otp = trim((string)($in['otp'] ?? ''));

        if (empty($in['accept'])) out(422, ['status' => 'error', 'message' => 'Please tick the box to confirm you understand this is a research and paper-trading tool.']);
        if (!a_name_ok($name)) out(422, ['status' => 'error', 'message' => 'Username: 3 to 24 letters, digits, dot, dash or underscore, starting with a letter or digit.']);
        if (a_name_reserved($name)) out(422, ['status' => 'error', 'message' => 'That username is reserved. Pick another.']);
        if (($why = a_pw_check($pw, $name)) !== '') out(422, ['status' => 'error', 'message' => $why]);

        // If email or REQUIRE_EMAIL_OTP is active, verify OTP
        if ($email !== '' || REQUIRE_EMAIL_OTP) {
            if (!a_email_ok($email)) out(422, ['status' => 'error', 'message' => 'Please enter a valid email address.']);
            if ($otp === '') out(422, ['status' => 'error', 'message' => 'Please enter the 6-digit verification code sent to your email.']);
            $otps = a_otps();
            $o = $otps['otps'][$email] ?? null;
            if (!$o || ($o['exp'] ?? 0) < time()) {
                out(422, ['status' => 'error', 'message' => 'Verification code expired or not requested. Click Send OTP to get a new code.']);
            }
            if (($o['attempts'] ?? 0) >= 5) {
                unset($otps['otps'][$email]); a_save_otps($otps);
                out(422, ['status' => 'error', 'message' => 'Too many incorrect code attempts. Please request a new verification code.']);
            }
            if (!password_verify($otp, $o['hash'])) {
                $otps['otps'][$email]['attempts'] = ($o['attempts'] ?? 0) + 1;
                a_save_otps($otps);
                out(422, ['status' => 'error', 'message' => 'Incorrect verification code. Please check and try again.']);
            }
            unset($otps['otps'][$email]);
            a_save_otps($otps);
        }

        $rec = a_with_lock(function () use ($name, $pw, $code, $email) {
            $d = a_users(); if (count($d['users']) >= MAX_USERS) return ['err' => 'Sign-ups are full on this server.'];
            foreach ($d['users'] as $x) {
                if ($x['username'] === $name) return ['err' => 'That username is taken.'];
                if ($email !== '' && !empty($x['email']) && strtolower($x['email']) === $email) return ['err' => 'That email is already registered.'];
            }
            $first = !$d['users']; $role = 'member';
            $hit = null;
            if ($first) {   // the very first account is the owner and needs the setup code from auth-local.php
                if (ADMIN_SETUP_CODE === '') return ['err' => 'This server is not set up yet: the owner must set ADMIN_SETUP_CODE in auth-local.php (see SETUP-hostinger.txt).'];
                if (!hash_equals(ADMIN_SETUP_CODE, $code)) return ['err' => 'Wrong setup code.', 'guess' => true];
                $role = 'admin';
            } else {
                $reqInvite = REQUIRE_INVITE;
                if ($code !== '' || $reqInvite) {
                    $inv = a_invites(); $h = hash('sha256', preg_replace('/[^A-Z0-9]/', '', strtoupper($code)));
                    foreach ($inv['list'] as $k => $i) if (hash_equals($i['hash'], $h)) { $hit = $k; break; }
                    if ($hit === null || !empty($inv['list'][$hit]['used']) || ($inv['list'][$hit]['exp'] ?? PHP_INT_MAX) < time()) return ['err' => 'That invite code is not valid. Ask the owner for a new one.', 'guess' => true];
                }
            }
            $id = bin2hex(random_bytes(8));
            $rec = ['id' => $id, 'username' => $name, 'email' => $email, 'hash' => a_hash($pw), 'role' => $role, 'created' => time(), 'last' => time(), 'pwv' => 1, 'accepted' => time()];
            $d['users'][$id] = $rec; a_save_users($d);
            if (!$first && $hit !== null) { $inv['list'][$hit]['used'] = true; $inv['list'][$hit]['usedBy'] = $name; $inv['list'][$hit]['usedAt'] = time(); a_save_invites($inv); }
            return ['rec' => $rec, 'first' => $first];
        });
        if (isset($rec['err'])) { a_log('signup-refused', $name, !empty($rec['guess']) ? 'wrong code' : 'other'); if (!empty($rec['guess'])) a_fail('sf:' . $ip, 8, 3600, 3600); out(422, ['status' => 'error', 'message' => $rec['err']]); }
        a_udir($rec['rec']['id']); if ($rec['first']) a_adopt_legacy(RUNNER_KEY !== '' ? 'engine' : $rec['rec']['id']);
        a_log('signup', $rec['rec']['username'], $rec['first'] ? 'owner' : 'member');
        a_start_session_for($rec['rec']);
        out(200, ['status' => 'success', 'user' => a_pub($rec['rec'])]);
    }
    if ($action === 'login') {
        $login = strtolower(trim((string)($in['username'] ?? ''))); $pw = (string)($in['password'] ?? '');
        $left = max(a_locked('u:' . $login), a_locked('i:' . $ip));
        if ($left > 0) a_log('login-blocked', $login);
        if ($left > 0) out(429, ['status' => 'error', 'message' => 'Too many wrong attempts. Try again in about ' . max(1, (int)ceil($left / 60)) . ' minute(s).']);
        $rec = a_find_user($login);
        $ok = $rec ? password_verify($pw, $rec['hash']) : (a_dummy_verify($pw) && false);
        if (!$ok) { a_log('login-failed', $login); a_fail('u:' . $login, 5, 900, 900); a_fail('i:' . $ip, 30, 900, 900); out(401, ['status' => 'error', 'message' => 'Wrong username or password.']); }
        if (!empty($rec['disabled'])) out(403, ['status' => 'error', 'message' => 'This account is switched off. Ask the owner.']);
        a_clear('u:' . $login);
        a_with_lock(function () use ($rec) { $d = a_users(); if (isset($d['users'][$rec['id']])) { $d['users'][$rec['id']]['last'] = time(); a_save_users($d); } });
        a_start_session_for($rec); a_log('login', $rec['username']);
        out(200, ['status' => 'success', 'user' => a_pub($rec)]);
    }
    if ($action === 'recover') {   // the owner lost their password: works only while ADMIN_SETUP_CODE is set in auth-local.php (take it out again afterwards)
        if ($l = a_locked('sf:' . $ip)) out(429, ['status' => 'error', 'message' => 'Too many failed attempts from here. Try again in about ' . max(1, (int)ceil($l / 60)) . ' minute(s).']);
        $name = strtolower(trim((string)($in['username'] ?? ''))); $code = (string)($in['code'] ?? ''); $new = (string)($in['password'] ?? '');
        if (ADMIN_SETUP_CODE === '' || !hash_equals(ADMIN_SETUP_CODE, $code)) { a_log('recover-refused', $name); a_fail('sf:' . $ip, 8, 3600, 3600); out(422, ['status' => 'error', 'message' => 'Wrong setup code, or recovery is switched off (set ADMIN_SETUP_CODE in auth-local.php on the server first).']); }
        if (($why = a_pw_check($new, $name)) !== '') out(422, ['status' => 'error', 'message' => $why]);
        $res = a_with_lock(function () use ($name, $new) {
            $d = a_users(); foreach ($d['users'] as $id => $x) if ($x['username'] === $name && $x['role'] === 'admin') { $x['hash'] = a_hash($new); $x['pwv'] = (int)($x['pwv'] ?? 0) + 1; unset($x['mustChange'], $x['disabled']); $d['users'][$id] = $x; a_save_users($d); return true; }
            return false;
        });
        if (!$res) { a_fail('sf:' . $ip, 8, 3600, 3600); out(422, ['status' => 'error', 'message' => 'There is no owner account with that username.']); }
        a_log('owner-password-recovered', $name); out(200, ['status' => 'success']);
    }
    if ($action === 'logout') {
        if (a_session(true)) { $_SESSION = []; session_destroy(); }
        setcookie('ixs', '', ['expires' => 1, 'path' => a_cookie_path(), 'secure' => a_https(), 'httponly' => true, 'samesite' => 'Lax']);
        out(200, ['status' => 'success']);
    }

    /* everything below needs a logged-in person */
    $me = auth_user(); if (!$me || ($me['via'] ?? '') !== 'session') out(401, ['status' => 'error', 'auth' => 'login', 'message' => 'Please log in.']);

    if ($action === 'password') {
        $old = (string)($in['old'] ?? ''); $new = (string)($in['new'] ?? '');
        if (($why = a_pw_check($new, $me['username'])) !== '') out(422, ['status' => 'error', 'message' => $why]);
        $r = a_with_lock(function () use ($me, $old, $new) {
            $d = a_users(); $rec = $d['users'][$me['id']] ?? null; if (!$rec) return 'gone';
            if (!password_verify($old, $rec['hash'])) return 'bad';
            $rec['hash'] = a_hash($new); $rec['pwv'] = (int)($rec['pwv'] ?? 0) + 1; unset($rec['mustChange']); $d['users'][$me['id']] = $rec; a_save_users($d); return $rec;
        });
        if ($r === 'bad') { a_fail('u:' . $me['username'], 5, 900, 900); out(401, ['status' => 'error', 'message' => 'Your current password is wrong.']); }
        if (!is_array($r)) out(404, ['status' => 'error', 'message' => 'Account not found.']);
        a_start_session_for($r); a_log('password-changed', $me['username']);   // this device stays logged in; every other session ends
        out(200, ['status' => 'success']);
    }
    if ($action === 'delete_me') {
        $pw = (string)($in['password'] ?? ''); $rec = a_users()['users'][$me['id']] ?? null;
        if (!$rec || !password_verify($pw, $rec['hash'])) out(401, ['status' => 'error', 'message' => 'Wrong password.']);
        if ($rec['role'] === 'admin') { $admins = 0; foreach (a_users()['users'] as $x) if ($x['role'] === 'admin' && empty($x['disabled'])) $admins++; if ($admins < 2) out(422, ['status' => 'error', 'message' => 'You are the only owner. Make another owner first, or keep this account.']); }
        a_with_lock(function () use ($me) { $d = a_users(); unset($d['users'][$me['id']]); a_save_users($d); });
        a_user_dir_remove($me['id']); a_log('account-deleted', $me['username']);
        if (a_session(true)) { $_SESSION = []; session_destroy(); }
        out(200, ['status' => 'success']);
    }

    /* ---- owner only ---- */
    if ($me['role'] !== 'admin') out(403, ['status' => 'error', 'message' => 'Only the owner can do this.']);
    if ($action === 'admin_users') {
        $rows = []; foreach (a_users()['users'] as $x) {
            $book = a_read(a_udir($x['id']) . '/paper.php')['book'] ?? [];
            $rows[] = ['id' => $x['id'], 'username' => $x['username'], 'email' => $x['email'] ?? '', 'role' => $x['role'], 'created' => $x['created'], 'last' => $x['last'] ?? 0, 'disabled' => !empty($x['disabled']), 'trades' => count((array)($book['hist'] ?? [])), 'open' => count((array)($book['pos'] ?? []))];
        }
        usort($rows, function ($a, $b) { return $b['created'] <=> $a['created']; });
        out(200, ['status' => 'success', 'users' => $rows, 'max' => MAX_USERS]);
    }
    if ($action === 'admin_invites') {
        $rows = []; foreach (a_invites()['list'] as $i) $rows[] = ['hint' => $i['hint'], 'created' => $i['created'], 'exp' => $i['exp'], 'note' => $i['note'] ?? '', 'used' => !empty($i['used']), 'usedBy' => $i['usedBy'] ?? '', 'expired' => $i['exp'] < time()];
        usort($rows, function ($a, $b) { return $b['created'] <=> $a['created']; });
        out(200, ['status' => 'success', 'invites' => array_slice($rows, 0, 100)]);
    }
    if ($action === 'admin_invite') {
        $n = max(1, min(10, (int)($in['count'] ?? 1))); $days = max(1, min(60, (int)($in['days'] ?? 14))); $note = substr(preg_replace('/[^A-Za-z0-9 ._-]/', '', (string)($in['note'] ?? '')), 0, 40); $codes = [];
        a_with_lock(function () use ($n, $days, $note, $me, &$codes) {
            $inv = a_invites(); $inv['list'] = array_slice($inv['list'], -300);
            for ($i = 0; $i < $n; $i++) { $c = a_code(); $codes[] = $c; $inv['list'][] = ['hash' => hash('sha256', str_replace('-', '', $c)), 'hint' => substr($c, -4), 'created' => time(), 'exp' => time() + $days * 86400, 'by' => $me['username'], 'note' => $note]; }
            a_save_invites($inv);
        });
        a_log('admin-invite', $me['username'], count($codes) . ' code(s)');
        out(200, ['status' => 'success', 'codes' => $codes, 'days' => $days]);
    }
    if (in_array($action, ['admin_disable', 'admin_enable', 'admin_reset', 'admin_delete', 'admin_role'], true)) {
        $id = (string)($in['id'] ?? ''); if (!preg_match('/^[a-f0-9]{16}$/', $id)) out(400, ['status' => 'error', 'message' => 'Bad user id']);
        if ($id === $me['id'] && $action !== 'admin_reset') out(422, ['status' => 'error', 'message' => 'Use the account menu for your own account.']);
        $res = a_with_lock(function () use ($id, $action, $in) {
            $d = a_users(); $rec = $d['users'][$id] ?? null; if (!$rec) return ['err' => 'User not found.']; $extra = [];
            if ($action === 'admin_disable') { $rec['disabled'] = true; $rec['pwv'] = (int)($rec['pwv'] ?? 0) + 1; }
            elseif ($action === 'admin_enable') { unset($rec['disabled']); }
            elseif ($action === 'admin_role') { $r = (string)($in['role'] ?? ''); if (!in_array($r, ['member', 'admin'], true)) return ['err' => 'Bad role.']; $rec['role'] = $r; }
            elseif ($action === 'admin_reset') { $al = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'; $tmp = ''; for ($i = 0; $i < 12; $i++) $tmp .= $al[random_int(0, strlen($al) - 1)]; $rec['hash'] = a_hash($tmp); $rec['pwv'] = (int)($rec['pwv'] ?? 0) + 1; $rec['mustChange'] = true; $extra['temp'] = $tmp; }
            elseif ($action === 'admin_delete') { unset($d['users'][$id]); a_save_users($d); return ['deleted' => $rec['username']]; }
            $d['users'][$id] = $rec; a_save_users($d); return ['ok' => true, 'username' => $rec['username']] + $extra;
        });
        if (isset($res['err'])) out(422, ['status' => 'error', 'message' => $res['err']]);
        if (isset($res['deleted'])) a_user_dir_remove($id);
        a_log('admin-' . substr($action, 6), $me['username'], isset($res['username']) ? $res['username'] : (isset($res['deleted']) ? $res['deleted'] : $id));
        out(200, ['status' => 'success'] + $res);
    }
    out(400, ['status' => 'error', 'message' => 'Unknown action']);
}
