# VSCode-Termux v1.0.0 (Developer Mode)

Developer-mode build. Includes verbose logs for debugging and developer utilities.

Developer: Paong & Evelyn
Logo: https://cdn.yupra.my.id/yp/qm656enk.jpg
Discord: https://discord.gg/h29Hrudn7
WhatsApp Channel: https://whatsapp.com/channel/0029Vb6cgi6LSmbec90kZv02

Quick install (Termux):
```bash
termux-setup-storage
pkg update -y && pkg upgrade -y
pkg install -y nodejs git wget unzip curl python
# move zip to /sdcard/Download then:
cd /sdcard/Download
unzip VSCode-Termux-v1.0.0-dev.zip -d VSCode-Termux
cd VSCode-Termux
chmod +x install.sh
./install.sh
# open http://localhost:3000
```

Notes:
- This is developer mode: logs are verbose, debug endpoints present, and files are not minified to allow editing.
- Settings are stored in LowDB `db.json` under `~/.vscode-termux/db.json`.
- Create a GitHub OAuth App if you want backup features (callback: http://localhost:3000/auth/github/callback).

