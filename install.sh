#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail
echo "Installing VSCode-Termux v1.0.0 (Developer Mode)"
PKG=pkg
if ! command -v $PKG >/dev/null 2>&1; then PKG=apt; fi
$PKG update -y || true
$PKG upgrade -y || true
$PKG install -y nodejs git wget unzip curl python -y || true
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2 --no-audit --no-fund || true
fi
cd backend || true
if [ -f package.json ]; then
  npm install --no-audit --no-fund --silent || true
fi
cd - >/dev/null 2>&1 || true
DB_DIR="$HOME/.vscode-termux"
mkdir -p "$DB_DIR"
DB_FILE="$DB_DIR/db.json"
if [ ! -f "$DB_FILE" ]; then
  echo '{"settings":{"language":"en","theme":"dark-blue","autoBackup":false},"users":[],"projects":[]}'> "$DB_FILE"
  echo "Created $DB_FILE"
fi
mkdir -p "$HOME/projects"
pm2 start backend/server.js --name vscode-termux --update-env || true
pm2 save || true
echo "Installation finished. Open http://localhost:3000"
