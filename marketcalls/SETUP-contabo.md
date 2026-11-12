# Index Signals — Contabo VPS Deployment Guide
**Subdomain:** `market.bhagadbilla.com`  
**Stack:** Ubuntu Linux (Contabo VPS) + Nginx + PHP 8.3 FPM + Node.js (Runner) + Let's Encrypt SSL

---

## 1. DNS Setup (Do This First)

Log in to your DNS manager (Cloudflare, GoDaddy, Namecheap, or Contabo DNS):
1. Add an **A Record**:
   - **Type:** `A`
   - **Name / Host:** `market` (or `market.bhagadbilla.com`)
   - **Value / Target:** `<Your Contabo VPS Public IPv4 Address>`
   - **TTL:** Auto or 300 seconds
   - *(If using Cloudflare, set proxy to DNS Only / Grey Cloud initially to ensure Certbot SSL verification completes smoothly, or keep Proxied with Full (Strict) SSL).*

---

## 2. Server Setup on Contabo (Ubuntu 22.04 / 24.04 LTS)

SSH into your Contabo server as `root` (or sudo user):
```bash
ssh root@<YOUR_CONTABO_IP>
```

### Option A: Use the automated script
Clone or copy the repository files, or run:
```bash
# Update and install git
sudo apt-get update && sudo apt-get install -y git

# Create webroot directory
sudo mkdir -p /var/www/market.bhagadbilla.com
sudo chown -R $USER:$USER /var/www/market.bhagadbilla.com

# Clone your repository
git clone <YOUR_GIT_REPO_URL> /var/www/market.bhagadbilla.com

# Run the setup script
cd /var/www/market.bhagadbilla.com
chmod +x deploy/setup-contabo.sh
sudo ./deploy/setup-contabo.sh
```

### Option B: Manual Step-by-Step
```bash
# 1. Update packages
sudo apt update && sudo apt upgrade -y

# 2. Install Nginx and PHP 8.3
sudo add-apt-repository -y ppa:ondrej/php
sudo apt update
sudo apt install -y nginx php8.3-fpm php8.3-cli php8.3-curl php8.3-mbstring php8.3-xml php8.3-zip certbot python3-certbot-nginx

# 3. Create app and secure data directory
sudo mkdir -p /var/www/market.bhagadbilla.com
sudo mkdir -p /var/www/signals-data
sudo chown -R www-data:www-data /var/www/market.bhagadbilla.com /var/www/signals-data
sudo chmod -R 775 /var/www/signals-data

# 4. Configure Nginx
sudo cp /var/www/market.bhagadbilla.com/deploy/nginx/market.bhagadbilla.com.conf /etc/nginx/sites-available/market.bhagadbilla.com
sudo ln -sf /etc/nginx/sites-available/market.bhagadbilla.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

## 3. Configure Local Credentials (`auth-local.php`)

On the Contabo server:
```bash
cd /var/www/market.bhagadbilla.com
cp auth-local.example.php auth-local.php
nano auth-local.php
```

Fill in your configuration:
```php
<?php
define('AUTH_MODE', 'users');
define('ADMIN_SETUP_CODE', 'ChooseAStrongSetupCodeHere');   // Used once to create the OWNER account
define('UPSTOX_TOKEN', 'YOUR_UPSTOX_ANALYTICS_TOKEN');       // Valid 1-year token from Upstox Dev Portal
define('RUNNER_KEY', 'RandomSecretStringForRunner20Chars'); // If using 24/7 runner
define('DATA_DIR', '/var/www/signals-data');                 // Outside webroot for maximum security

// --- Email OTP Settings (User Registration & Password Reset) ---
define('REQUIRE_EMAIL_OTP', true);                           // Require email verification via OTP
define('REQUIRE_INVITE', false);                             // false = email OTP verification is sufficient
define('SMTP_HOST', 'smtp.gmail.com');                       // Or mail.bhagadbilla.com, or leave empty for PHP mail()
define('SMTP_PORT', 587);                                    // 587 (TLS) or 465 (SSL)
define('SMTP_USER', 'your-email@gmail.com');
define('SMTP_PASS', 'your-16-char-app-password');
define('SMTP_FROM', 'noreply@bhagadbilla.com');
define('SMTP_FROM_NAME', 'Index Signals');
define('SMTP_SECURE', 'tls');                                // 'tls' or 'ssl'
```

Set permissions so only the web server can read it:
```bash
sudo chown www-data:www-data auth-local.php
sudo chmod 600 auth-local.php
```

---

## 4. Install Free SSL (Let's Encrypt)

Once your DNS `market.bhagadbilla.com` points to the Contabo IP:
```bash
sudo certbot --nginx -d market.bhagadbilla.com
```
Follow prompts:
- Enter your email address.
- Agree to Terms of Service.
- Certbot will automatically issue the certificate and update Nginx to redirect HTTP to HTTPS.

Verify Nginx config:
```bash
sudo nginx -t && sudo systemctl reload nginx
```

---

## 5. First-Time Account Setup

1. Open `https://market.bhagadbilla.com` in your browser.
2. Click **Create account**.
3. Enter:
   - Your desired username
   - A strong password
   - The `ADMIN_SETUP_CODE` you set in `auth-local.php`
4. The first account created automatically becomes the **OWNER**.
5. Once your account is created, edit `auth-local.php` and remove or comment out `ADMIN_SETUP_CODE` so no one else can claim admin:
```php
// define('ADMIN_SETUP_CODE', '...');
```

---

## 6. (Optional) 24/7 Headless Runner Setup

The headless runner keeps index scans alive 24/7, maintains engine paper trades, and triggers alerts:

1. Install Node.js dependencies:
```bash
cd /var/www/market.bhagadbilla.com/service
npm install --omit=dev
```

2. Create config:
```bash
cp config.example.json config.json
nano config.json
```
Set:
- `"baseUrl": "https://market.bhagadbilla.com/"`
- `"runnerKey": "<Same RUNNER_KEY as in auth-local.php>"`

3. Install systemd service:
```bash
sudo cp /var/www/market.bhagadbilla.com/deploy/systemd/signals-runner.service /etc/systemd/system/signals-runner.service
sudo systemctl daemon-reload
sudo systemctl enable --now signals-runner
```

Check runner status:
```bash
sudo systemctl status signals-runner
# Or view live logs:
journalctl -u signals-runner -f
```

---

## 7. Firewall (UFW)
Ensure ports 80, 443, and SSH (22) are open:
```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```
