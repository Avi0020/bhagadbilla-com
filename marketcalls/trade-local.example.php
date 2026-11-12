<?php
/* Copy this file to trade-local.php on your server and fill it in. trade-local.php is ignored by git. */
define('ORDER_MODE', 'dry');
define('ORDER_BROKER', 'upstox');         // 'upstox' or 'indstocks'. INDstocks needs no key or secret here: you paste its daily token in the app            // 'off' | 'dry' | 'live'  - start with 'dry'
define('UPSTOX_CLIENT_ID', '');          // API key of your Upstox Developer App
define('UPSTOX_CLIENT_SECRET', '');      // API secret
define('UPSTOX_REDIRECT_URI', 'https://YOURDOMAIN/signals/api.php?callback=1');   // must match the app's redirect URL exactly
// optional limits (defaults: Rs 50,000 per order, 5000 units, 10 orders a day):
// define('ORDER_MAX_VALUE', 30000);
// define('ORDER_MAX_PER_DAY', 6);
// AUTOMATIC TRADING (INDstocks only, OFF unless you set this; also needs "autoTrade": true in service/config.json). Keep ORDER_MODE 'dry' for the first 1-2 weeks: it then only shadows trades.
// define('ORDER_AUTO', true);
// optional auto limits (defaults shown): lots 1, open at once 1, buys a day 2, stop 40%, target 80%, trail starts +30% and follows 25% below the high, entries until 14:00, square-off 15:10
// define('AUTO_LOTS', 1); define('AUTO_MAX_OPEN', 1); define('AUTO_MAX_PER_DAY', 2); define('AUTO_SL', 0.40); define('AUTO_TARGET', 0.80);
// define('AUTO_TRAIL_START', 0.30); define('AUTO_TRAIL_GIVE', 0.25); define('AUTO_ENTRY_UNTIL', '14:00'); define('AUTO_SQUAREOFF', '15:10');
