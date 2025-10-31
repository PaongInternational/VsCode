/**
 * backend/server.js
 * VSCode-Termux - server (improved)
 *
 * - Binds to 0.0.0.0 so Android browser can reach Termux
 * - LowDB (db.json) for settings/users/projects
 * - File operations (save/read/list/download/upload)
 * - Run simple scripts (node/python) with stdout/stderr via socket.io events
 * - GitHub backup (creates repo and pushes via provided token)
 * - Debug endpoint: /__debug/db
 *
 * Run:
 *   PORT=3000 HOST=0.0.0.0 node backend/server.js
 *
 * (Designed for developer mode; sanitize tokens & secrets in production)
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const bodyParser = require('body-parser');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const { Low, JSONFile } = require('lowdb');
const fetch = require('node-fetch');
const socketio = require('socket.io');
const simpleGit = require('simple-git');
const archiver = require('archiver');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketio(server, { cors: { origin: '*' } });

app.use(cors());
app.use(bodyParser.json({ limit: '40mb' }));
app.use(bodyParser.urlencoded({ extended: true }));

// Config
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // IMPORTANT: bind to 0.0.0.0 for Termux <-> browser access

const HOME = process.env.HOME || process.cwd();
const DB_DIR = path.join(HOME, '.vscode-termux');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const DB_FILE = path.join(DB_DIR, 'db.json');
const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter);

// Ensure projects dir
const PROJECTS_DIR = path.join(HOME, 'projects');
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });

// Initialize DB with safe defaults
(async () => {
  await db.read().catch(() => {});
  db.data = db.data || { settings: { language: 'en', theme: 'dark-blue', autoBackup: false }, users: [], projects: [] };
  // ensure default project exists in lowdb metadata (but actual files are in HOME/projects)
  if (!Array.isArray(db.data.projects)) db.data.projects = [];
  if (!db.data.projects.find(p => p.name === 'default')) {
    db.data.projects.push({ name: 'default', createdAt: new Date().toISOString() });
  }
  await db.write();
  console.log('[server] DB initialized at', DB_FILE);
})();

// Serve static frontend if exists
const DIST = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(DIST)) {
  app.use(express.static(DIST));
  console.log('[server] Serving frontend from', DIST);
} else {
  console.warn('[server] Frontend dist not found:', DIST);
}

// --- Debug endpoints
app.get('/__debug/db', async (req, res) => {
  await db.read();
  return res.json({ ok: true, db: db.data });
});

app.get('/__debug/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// --- Settings
app.get('/api/settings', async (req, res) => {
  await db.read();
  return res.json({ ok: true, settings: db.data.settings });
});

app.post('/api/settings', async (req, res) => {
  try {
    await db.read();
    db.data.settings = req.body;
    await db.write();
    return res.json({ ok: true });
  } catch (e) {
    console.error('[settings] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// --- File operations
function safeProjectPath(project) {
  // restrict to simple names, prevent path traversal
  return project && typeof project === 'string' ? project.replace(/[^\w\-_.]/g, '-') : 'default';
}

app.post('/api/files/save', async (req, res) => {
  try {
    const { project = 'default', path: pth, content = '' } = req.body || {};
    if (!pth) return res.status(400).json({ error: 'path required' });
    const proj = safeProjectPath(project);
    const projDir = path.join(PROJECTS_DIR, proj);
    fs.mkdirSync(projDir, { recursive: true });
    const full = path.join(projDir, pth);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    console.log('[files] saved', full);
    return res.json({ ok: true });
  } catch (e) {
    console.error('[files][save] error', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/read', (req, res) => {
  try {
    const { project = 'default', path: pth } = req.body || {};
    if (!pth) return res.status(400).json({ error: 'path required' });
    const proj = safeProjectPath(project);
    const full = path.join(PROJECTS_DIR, proj, pth);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    return res.json({ ok: true, content: fs.readFileSync(full, 'utf8') });
  } catch (e) {
    console.error('[files][read] error', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/list', (req, res) => {
  try {
    const { project = 'default' } = req.body || {};
    const proj = safeProjectPath(project);
    const dir = path.join(PROJECTS_DIR, proj);
    if (!fs.existsSync(dir)) return res.json({ ok: true, files: [] });
    function walk(d) {
      let out = [];
      const items = fs.readdirSync(d);
      for (const it of items) {
        const p = path.join(d, it);
        const stat = fs.statSync(p);
        if (stat.isDirectory()) out.push(...walk(p));
        else out.push(path.relative(dir, p));
      }
      return out;
    }
    const files = walk(dir);
    return res.json({ ok: true, files });
  } catch (e) {
    console.error('[files][list] error', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/download', (req, res) => {
  try {
    const { project = 'default' } = req.body || {};
    const proj = safeProjectPath(project);
    const dir = path.join(PROJECTS_DIR, proj);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'project not found' });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${proj}.zip"`);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', err => res.status(500).send({ error: err.message }));
    archive.pipe(res);
    archive.directory(dir, false);
    archive.finalize();
  } catch (e) {
    console.error('[files][download] error', e);
    return res.status(500).json({ error: e.message });
  }
});

app.post('/api/files/upload', upload.single('file'), (req, res) => {
  try {
    const { project = 'default' } = req.body || {};
    const proj = safeProjectPath(project);
    const projDir = path.join(PROJECTS_DIR, proj);
    fs.mkdirSync(projDir, { recursive: true });
    const dest = path.join(projDir, req.file.originalname);
    fs.renameSync(req.file.path, dest);
    console.log('[files] uploaded', dest);
    return res.json({ ok: true, name: req.file.originalname });
  } catch (e) {
    console.error('[files][upload] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// --- Run code (node/python) - streams to socket.io
app.post('/api/run', (req, res) => {
  try {
    const { project = 'default', path: pth } = req.body || {};
    if (!pth) return res.status(400).json({ error: 'path required' });
    const proj = safeProjectPath(project);
    const full = path.join(PROJECTS_DIR, proj, pth);
    if (!fs.existsSync(full)) return res.status(404).json({ error: 'not found' });
    const ext = path.extname(full).toLowerCase();
    let cmd, args;
    if (ext === '.js') { cmd = 'node'; args = [full]; }
    else if (ext === '.py') { cmd = 'python3'; args = [full]; }
    else return res.status(400).json({ error: 'unsupported' });

    const runId = Date.now().toString();
    const child = spawn(cmd, args, { cwd: path.dirname(full) });

    child.stdout.on('data', d => io.emit('run:output', { id: runId, type: 'stdout', text: d.toString() }));
    child.stderr.on('data', d => io.emit('run:output', { id: runId, type: 'stderr', text: d.toString() }));
    child.on('close', code => io.emit('run:exit', { id: runId, code }));

    console.log(`[run] started ${cmd} ${args.join(' ')} (id=${runId})`);
    return res.json({ ok: true, id: runId });
  } catch (e) {
    console.error('[run] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// --- GitHub backup
app.post('/api/github/backup', async (req, res) => {
  try {
    const { project = 'default', token } = req.body || {};
    if (!token) return res.status(400).json({ error: 'token required' });
    const proj = safeProjectPath(project);
    const repoName = proj.replace(/[^a-zA-Z0-9-_.]/g, '-').toLowerCase();
    const payload = { name: repoName, description: 'Backup from VSCode-Termux', private: true, auto_init: false };
    const resp = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { 'Authorization': 'token ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const j = await resp.json();
    if (resp.status >= 400) {
      console.error('[github] create repo failed', j);
      return res.status(500).json({ error: j.message || 'github error', details: j });
    }

    const projectDir = path.join(PROJECTS_DIR, proj);
    const git = simpleGit(projectDir);
    await git.init();
    await git.add('.');
    await git.commit('Backup from VSCode-Termux').catch(() => {});
    const remoteUrl = j && j.clone_url ? j.clone_url : null;

    if (remoteUrl) {
      const authUrl = remoteUrl.replace('https://', 'https://' + token + '@');
      await git.addRemote('origin', authUrl).catch(() => {});
      await git.push(['-u', 'origin', 'HEAD']).catch(e => console.warn('[github] push warning', e.message));
    }

    return res.json({ ok: true, repo: j && j.html_url ? j.html_url : null });
  } catch (e) {
    console.error('[github] error', e);
    return res.status(500).json({ error: e.message });
  }
});

// catch-all -> serve frontend index if present
app.get('*', (req, res) => {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.send('<h3>VSCode-Termux frontend not built yet</h3><p>See README</p>');
});

// Graceful shutdown
function shutdown() {
  console.log('[server] shutdown requested');
  server.close(() => {
    console.log('[server] closed http server');
    process.exit(0);
  });
  setTimeout(() => {
    console.warn('[server] forced shutdown');
    process.exit(1);
  }, 5000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start
server.listen(PORT, HOST, () => {
  console.log(`[server] VSCode-Termux listening on http://${HOST}:${PORT} (pid=${process.pid})`);
});
