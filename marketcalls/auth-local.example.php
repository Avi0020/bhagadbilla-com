<?php
/* Copy this file to auth-local.php on your server and fill it in. NEVER commit auth-local.php or share it: it holds your secrets. */
define('AUTH_MODE', 'users');                          // accounts for you and your invited friends (the safe default)
define('ADMIN_SETUP_CODE', 'PICK-A-LONG-RANDOM-CODE'); // used ONCE, as the "setup code", to create YOUR owner account. Then it does nothing.
define('UPSTOX_TOKEN', 'PASTE_YOUR_UPSTOX_ANALYTICS_TOKEN_HERE');   // read-only market data, shared by everybody
// define('RUNNER_KEY', 'at least 20 random characters');            // only if you run the 24/7 runner (service/runner.js); put the same value in its config.json
// define('DATA_DIR', '/var/www/signals-data');                      // BEST PRACTICE: a folder OUTSIDE webroot for accounts and paper trades (create it first)
// define('MAX_USERS', 200);                                         // how many accounts this server will accept (default 200)
// define('SESSION_DAYS', 30);                                       // how long a login lasts without a visit (default 30)

// --- Email OTP Settings (for user registration & verification) ---
// define('REQUIRE_EMAIL_OTP', true);                 // require email OTP verification for registration (default: true)
// define('REQUIRE_INVITE', false);                   // require an invite code in addition to email OTP (default: false)
// define('SMTP_HOST', 'smtp.gmail.com');             // SMTP server (leave empty or 'mail' to use PHP mail())
// define('SMTP_PORT', 587);                          // 587 (TLS), 465 (SSL), or 25
// define('SMTP_USER', 'your-email@gmail.com');       // SMTP username
// define('SMTP_PASS', 'your-app-password');          // SMTP password (e.g. Google 16-char App Password)
// define('SMTP_FROM', 'noreply@bhagadbilla.com');     // From email address
// define('SMTP_FROM_NAME', 'Index Signals');         // Sender display name
// define('SMTP_SECURE', 'tls');                      // 'tls', 'ssl', or 'none'
