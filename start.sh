#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────
#  SmartMart POS — one-command start (macOS / Linux)
#
#  Usage:   bash start.sh
#           (or: ./start.sh, or double-click start-mac.command on macOS)
#
#  What it does:
#    0. if the app is already running — just opens it in the browser
#    1. checks Node.js is installed
#    2. installs packages                       (first run only)
#    3. creates .env from the included example  (first run only)
#    4. creates the database tables
#    5. restores the included data backup       (first run only)
#    6. starts the app and opens http://smartmart.local when ready
# ─────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"
export DB_PROVIDER=sqlite
export DATABASE_URL=file:../db/custom.db

echo ""
echo "======================================"
echo "   SmartMart POS  —  starting up"
echo "======================================"
echo ""

# 0. already running? then just open the app
if node -e "require('http').get('http://smartmart.local',r=>{r.resume();process.exit(0)}).on('error',()=>process.exit(1))" >/dev/null 2>&1; then
  echo "SmartMart POS is already running — opening it..."
  open "http://smartmart.local" 2>/dev/null || xdg-open "http://smartmart.local" 2>/dev/null || true
  exit 0
fi

# 1. Node.js present?
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed."
  echo "Install Node.js 20 or newer from https://nodejs.org and run this again."
  exit 1
fi
echo "[1/5] Node.js $(node -v) found"

# 2. packages
if [ ! -f node_modules/next/package.json ]; then
  echo "[2/5] Installing packages (first run only, 2-5 minutes)..."
  npm install --no-audit --no-fund
else
  echo "[2/5] Packages already installed"
fi

# 3. .env
if [ ! -f .env ]; then
  cp .env.example .env
  echo "[3/5] Created .env (local database mode)"
else
  echo "[3/5] .env already exists"
fi

# 4. database tables (only when creating a fresh local database)
FRESH=0
if [ ! -f db/custom.db ]; then FRESH=1; fi
if [ "$FRESH" = "1" ]; then
  echo "[4/5] Preparing database..."
  npm run db:push >/dev/null
else
  echo "[4/5] Existing local database found; preserving it."
fi

# 5. restore data on the very first run
BACKUP="$(ls data-backup/*.json 2>/dev/null | head -n 1 || true)"
if [ "$FRESH" = "1" ]; then
  if [ -n "$BACKUP" ]; then
    echo "[5/5] First run — restoring your data (products, sales, customers)..."
    node scripts/restore-with-env.mjs "$BACKUP" \
      || echo "      Restore had a problem — you can retry later with:  npm run restore"
  else
    echo "[5/5] No data backup found — starting with an empty database"
  fi
else
  echo "[5/5] Keeping your existing data"
fi

echo ""
echo "======================================"
echo "   SmartMart POS is starting..."
echo ""
echo "   The browser opens BY ITSELF when ready."
echo "   First start: 10-60 seconds."
echo "   Open:   http://smartmart.local"
echo "   Login:  manager@smartmart.app / SmartMart@123"
echo "           (change the password after first login)"
echo "   Stop:   press Ctrl+C"
echo "======================================"
echo ""

# open the browser as soon as the server answers
node open-when-ready.js &

npm run dev



