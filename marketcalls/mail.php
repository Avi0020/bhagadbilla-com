<?php
/* =========================================================
 *  Index Signals — Email delivery (native SMTP & PHP mail fallback)
 *  Loaded by auth.php for sending verification OTPs.
 *  Settings in auth-local.php:
 *      define('SMTP_HOST', 'smtp.example.com');
 *      define('SMTP_PORT', 587);
 *      define('SMTP_USER', 'user@example.com');
 *      define('SMTP_PASS', 'secret');
 *      define('SMTP_FROM', 'noreply@bhagadbilla.com');
 *      define('SMTP_FROM_NAME', 'Index Signals');
 *      define('SMTP_SECURE', 'tls'); // 'tls', 'ssl', or 'none'
 * ========================================================= */
if (!function_exists('out')) { http_response_code(404); exit; }

defined('SMTP_HOST') || define('SMTP_HOST', '');
defined('SMTP_PORT') || define('SMTP_PORT', 587);
defined('SMTP_USER') || define('SMTP_USER', '');
defined('SMTP_PASS') || define('SMTP_PASS', '');
defined('SMTP_FROM') || define('SMTP_FROM', 'noreply@bhagadbilla.com');
defined('SMTP_FROM_NAME') || define('SMTP_FROM_NAME', 'Index Signals');
defined('SMTP_SECURE') || define('SMTP_SECURE', 'tls');

function ix_send_mail($to, $subject, $htmlContent, $textContent = '') {
    // If SMTP_HOST is set, try native SMTP first
    if (SMTP_HOST !== '' && SMTP_HOST !== 'mail') {
        $ok = ix_smtp_send($to, $subject, $htmlContent, $textContent);
        if ($ok) return true;
        // If SMTP failed, log and fallback to mail() if available
    }

    $from = SMTP_FROM ?: ('noreply@' . ($_SERVER['HTTP_HOST'] ?? 'bhagadbilla.com'));
    $fromName = SMTP_FROM_NAME ?: 'Index Signals';
    $boundary = 'b_' . bin2hex(random_bytes(12));

    $headers = [
        'MIME-Version: 1.0',
        'From: ' . sprintf('=?UTF-8?B?%s?= <%s>', base64_encode($fromName), $from),
        'Reply-To: ' . $from,
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'X-Mailer: IndexSignals/1.0',
    ];

    $body = "--{$boundary}\r\n"
          . "Content-Type: text/plain; charset=UTF-8\r\n"
          . "Content-Transfer-Encoding: base64\r\n\r\n"
          . chunk_split(base64_encode($textContent ?: strip_tags($htmlContent))) . "\r\n"
          . "--{$boundary}\r\n"
          . "Content-Type: text/html; charset=UTF-8\r\n"
          . "Content-Transfer-Encoding: base64\r\n\r\n"
          . chunk_split(base64_encode($htmlContent)) . "\r\n"
          . "--{$boundary}--\r\n";

    return @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', $body, implode("\r\n", $headers));
}

function ix_smtp_send($to, $subject, $htmlContent, $textContent = '') {
    $host = SMTP_HOST;
    $port = (int)SMTP_PORT;
    $user = SMTP_USER;
    $pass = SMTP_PASS;
    $from = SMTP_FROM ?: ($user ?: 'noreply@bhagadbilla.com');
    $fromName = SMTP_FROM_NAME ?: 'Index Signals';
    $secure = strtolower((string)SMTP_SECURE);

    $remoteHost = ($secure === 'ssl' ? 'ssl://' : '') . $host;
    $errno = 0; $errstr = '';
    $socket = @stream_socket_client($remoteHost . ':' . $port, $errno, $errstr, 10, STREAM_CLIENT_CONNECT);
    if (!$socket) {
        error_log("Index Signals SMTP Connect Error: {$errstr} ({$errno})");
        return false;
    }
    stream_set_timeout($socket, 10);

    $read = function () use ($socket) {
        $data = '';
        while (!feof($socket)) {
            $line = fgets($socket, 512);
            if ($line === false) break;
            $data .= $line;
            if (isset($line[3]) && $line[3] === ' ') break;
        }
        return $data;
    };

    $cmd = function ($c, $expect) use ($socket, $read) {
        fwrite($socket, $c . "\r\n");
        $res = $read();
        $code = (int)substr($res, 0, 3);
        if ($code !== $expect && !in_array($code, (array)$expect, true)) {
            error_log("SMTP Error on '{$c}': {$res}");
            return false;
        }
        return $res;
    };

    $banner = $read();
    if ((int)substr($banner, 0, 3) !== 220) { fclose($socket); return false; }

    $clientDomain = $_SERVER['HTTP_HOST'] ?? 'localhost';
    if (!$cmd("EHLO {$clientDomain}", [250])) {
        if (!$cmd("HELO {$clientDomain}", [250])) { fclose($socket); return false; }
    }

    if ($secure === 'tls') {
        if (!$cmd("STARTTLS", [220])) { fclose($socket); return false; }
        $cryptoOk = stream_socket_enable_crypto($socket, true, STREAM_CRYPTO_METHOD_TLS_CLIENT);
        if (!$cryptoOk) { fclose($socket); return false; }
        if (!$cmd("EHLO {$clientDomain}", [250])) { fclose($socket); return false; }
    }

    if ($user !== '' && $pass !== '') {
        if (!$cmd("AUTH LOGIN", [334])) { fclose($socket); return false; }
        if (!$cmd(base64_encode($user), [334])) { fclose($socket); return false; }
        if (!$cmd(base64_encode($pass), [235])) { fclose($socket); return false; }
    }

    if (!$cmd("MAIL FROM:<{$from}>", [250])) { fclose($socket); return false; }
    if (!$cmd("RCPT TO:<{$to}>", [250, 251])) { fclose($socket); return false; }
    if (!$cmd("DATA", [354])) { fclose($socket); return false; }

    $boundary = 'b_' . bin2hex(random_bytes(12));
    $headers = [
        'Date: ' . date('r'),
        'To: <' . $to . '>',
        'From: ' . sprintf('=?UTF-8?B?%s?= <%s>', base64_encode($fromName), $from),
        'Subject: =?UTF-8?B?' . base64_encode($subject) . '?=',
        'Message-ID: <' . bin2hex(random_bytes(16)) . '@' . $clientDomain . '>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/alternative; boundary="' . $boundary . '"',
        'X-Mailer: IndexSignals/1.0',
    ];

    $payload = implode("\r\n", $headers) . "\r\n\r\n"
             . "--{$boundary}\r\n"
             . "Content-Type: text/plain; charset=UTF-8\r\n"
             . "Content-Transfer-Encoding: base64\r\n\r\n"
             . chunk_split(base64_encode($textContent ?: strip_tags($htmlContent))) . "\r\n"
             . "--{$boundary}\r\n"
             . "Content-Type: text/html; charset=UTF-8\r\n"
             . "Content-Transfer-Encoding: base64\r\n\r\n"
             . chunk_split(base64_encode($htmlContent)) . "\r\n"
             . "--{$boundary}--\r\n";

    $payload = preg_replace('/^\./m', '..', $payload);

    fwrite($socket, $payload . "\r\n.\r\n");
    $dataRes = $read();
    if ((int)substr($dataRes, 0, 3) !== 250) {
        error_log("SMTP Error on DATA: {$dataRes}");
        fclose($socket);
        return false;
    }

    $cmd("QUIT", [221, 250]);
    fclose($socket);
    return true;
}

function ix_send_otp_email($toEmail, $otpCode, $purpose = 'registration') {
    $subject = "Your Verification Code: {$otpCode} — Index Signals";
    $text = "Your Index Signals verification code is: {$otpCode}\n\n"
          . "This code is for {$purpose} and will expire in 10 minutes.\n"
          . "Never share this code with anyone.\n\n"
          . "— Index Signals (market.bhagadbilla.com)";

    $html = '<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;background:#090d16;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#f8fafc;">
  <div style="max-width:460px;margin:0 auto;background:#131c2e;border-radius:12px;padding:32px;border:1px solid #1e293b;box-shadow:0 8px 24px rgba(0,0,0,0.4);">
    <div style="display:flex;align-items:center;margin-bottom:16px;">
      <div style="font-size:22px;font-weight:700;color:#38bdf8;letter-spacing:-0.5px;">Index Signals</div>
    </div>
    <div style="font-size:14px;color:#94a3b8;margin-bottom:24px;">Options Signals &amp; Paper Trading</div>
    <div style="font-size:15px;line-height:1.5;color:#e2e8f0;margin-bottom:16px;">
      Your verification code for <b>' . htmlspecialchars($purpose) . '</b> is:
    </div>
    <div style="background:#090d16;border:2px dashed #0284c7;border-radius:10px;padding:20px;text-align:center;margin-bottom:20px;">
      <span style="font-size:36px;font-weight:800;letter-spacing:8px;color:#38bdf8;font-family:Consolas,monospace;">' . htmlspecialchars($otpCode) . '</span>
    </div>
    <div style="font-size:13px;color:#94a3b8;line-height:1.5;margin-bottom:24px;">
      This code is valid for <b>10 minutes</b>. If you did not request this code, you can safely ignore this email.
    </div>
    <div style="border-top:1px solid #1e293b;padding-top:16px;font-size:12px;color:#64748b;text-align:center;">
      Research &amp; Paper Trading Only &bull; market.bhagadbilla.com
    </div>
  </div>
</body>
</html>';

    return ix_send_mail($toEmail, $subject, $html, $text);
}
