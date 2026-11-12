<?php
/* =========================================================
 *  Signals — 24/7 runner support (loaded by api.php for ?svc=...)
 *  - beat   : the runner (service/runner.js on your VPS) says "I am alive" every 15 seconds
 *  - status : browsers ask whether a runner is alive; if so they become read-only viewers of the server paper account
 *  - notify : the runner sends a phone alert (ntfy.sh topic and/or Telegram bot). Keys stay on the server.
 *  Settings go in trade-local.php (git-ignored), for example:
 *      define('NTFY_TOPIC', 'a-long-random-secret-topic');     // install the ntfy app and subscribe to the same topic
 *      define('TELEGRAM_BOT_TOKEN', '...'); define('TELEGRAM_CHAT_ID', '...');   // optional alternative
 * ========================================================= */
if (!function_exists('out')) { http_response_code(404); exit; }
require_once __DIR__ . '/trade.php';   // shares its settings file, data folder helpers and test hooks

defined('NTFY_TOPIC') || define('NTFY_TOPIC', '');
defined('NTFY_SERVER') || define('NTFY_SERVER', 'https://ntfy.sh');
defined('TELEGRAM_BOT_TOKEN') || define('TELEGRAM_BOT_TOKEN', '');
defined('TELEGRAM_CHAT_ID') || define('TELEGRAM_CHAT_ID', '');
defined('NOTIFY_MAX_PER_HOUR') || define('NOTIFY_MAX_PER_HOUR', 40);

function svc_handle($action) {
    $c = t_conf(); $dir = t_dir($c); $me = $GLOBALS['IX_ME'];   // set by api.php after the login check
    /* one writer at a time (per person: each account has its own lease): a browser window must hold the lease to change the paper account; the runner always wins. Others are read-only viewers. */
    if ($action === 'lease' || $action === 'release') {
        if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['status' => 'error', 'message' => 'POST required']);
        $in = json_decode((string)file_get_contents('php://input'), true); $id = preg_replace('/[^A-Za-z0-9]/', '', (string)($in['id'] ?? '')); if ($id === '') out(400, ['status' => 'error', 'message' => 'id missing']);
        $lf = a_udir($me['id']) . '/writer-lease.php'; $l = t_read($lf); $now = time(); $live = !empty($l['id']) && ($now - (int)$l['t']) < 90;
        if ($action === 'release') { if ($live && $l['id'] === $id) t_write($lf, []); out(200, ['status' => 'success']); }
        $runner = !empty($in['runner']);
        $force = !empty($in['force']) && !($live && !empty($l['runner']));   // a person can take over from another window, never from a live runner
        if (!$live || $l['id'] === $id || ($runner && empty($l['runner'])) || $force) { t_write($lf, ['id' => $id, 't' => $now, 'runner' => $runner]); out(200, ['status' => 'success', 'granted' => true, 'runnerAlive' => $runner]); }
        out(200, ['status' => 'success', 'granted' => false, 'runnerAlive' => !empty($l['runner'])]);
    }
    if ($action === 'status') {
        $l = t_read(a_udir($me['id']) . '/writer-lease.php'); $age = time() - (int)($l['t'] ?? 0); $live = !empty($l['id']) && $age < 90;
        out(200, ['status' => 'success', 'runnerAlive' => $live && !empty($l['runner']), 'writerAlive' => $live, 'age' => $age]);
    }
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') out(405, ['status' => 'error', 'message' => 'POST required']);
    if ($action !== 'notify') out(400, ['status' => 'error', 'message' => 'Unknown action']);
    if (!in_array($me['role'], ['admin', 'runner'], true)) out(403, ['status' => 'error', 'message' => 'Phone alerts are for the owner only.']);

    $in = json_decode((string)file_get_contents('php://input'), true);
    $title = substr(trim((string)($in['title'] ?? 'Signals')), 0, 80); $msg = substr(trim((string)($in['message'] ?? '')), 0, 600);
    if ($msg === '') out(400, ['status' => 'error', 'message' => 'Empty message']);
    $nf = $dir . '/notify-log.php'; $lg = t_read($nf, ['sent' => [], 'seen' => []]);
    $lg['sent'] = array_values(array_filter((array)$lg['sent'], function ($t) { return $t > time() - 3600; }));
    $lg['seen'] = array_filter((array)$lg['seen'], function ($t) { return $t > time() - 600; });
    $h = md5($title . '|' . $msg);
    if (isset($lg['seen'][$h])) out(200, ['status' => 'success', 'sent' => false, 'note' => 'Duplicate alert suppressed']);
    if (count($lg['sent']) >= NOTIFY_MAX_PER_HOUR) out(200, ['status' => 'success', 'sent' => false, 'note' => 'Hourly alert limit reached']);
    $test = getenv('SIGNALS_TEST_UPSTOX') ? getenv('SIGNALS_TEST_NTFY') : '';
    $server = $test ?: NTFY_SERVER; $topic = $test ? 'testtopic' : NTFY_TOPIC; $sentTo = [];
    if ($topic !== '') {
        $ch = curl_init(rtrim($server, '/') . '/');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_POST => true, CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_POSTFIELDS => json_encode(['topic' => $topic, 'title' => $title, 'message' => $msg, 'priority' => 4, 'tags' => ['chart_with_upwards_trend']])]);
        curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch); if ($code >= 200 && $code < 300) $sentTo[] = 'ntfy';
    }
    if (!$test && TELEGRAM_BOT_TOKEN !== '' && TELEGRAM_CHAT_ID !== '') {
        $ch = curl_init('https://api.telegram.org/bot' . TELEGRAM_BOT_TOKEN . '/sendMessage');
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 8, CURLOPT_POST => true, CURLOPT_POSTFIELDS => ['chat_id' => TELEGRAM_CHAT_ID, 'text' => $title . "\n" . $msg]]);
        curl_exec($ch); $code = curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch); if ($code === 200) $sentTo[] = 'telegram';
    }
    if (!$sentTo) out(200, ['status' => 'success', 'sent' => false, 'note' => ($topic === '' && TELEGRAM_BOT_TOKEN === '') ? 'No alert channel is configured (NTFY_TOPIC or Telegram in trade-local.php)' : 'The alert service did not accept the message']);
    $lg['sent'][] = time(); $lg['seen'][$h] = time(); t_write($nf, $lg);
    out(200, ['status' => 'success', 'sent' => true, 'via' => $sentTo]);
}
