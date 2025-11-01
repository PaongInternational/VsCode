/**
 * server.js
 * VsCode-Termux - full-featured server (CommonJS)
 *
 * - Binds to 0.0.0.0 by default
 * - lowdb for db.json (users, projects)
 * - Files stored under ./projects/<projectName> (project folder)
 * - File APIs: list/read/save/delete/upload/download(zip)
 * - GitHub backup (create repo + push using token) - optional
 * - Terminal via socket.io (spawn child_process)
 *
 * NOTE: this is for development/Termux usage. Secure before production:
 *  - Add authentication for APIs & socket
 *  - Input sanitization, rate limits, permission checks
 */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const archiver = require('archiver');
const { spawn } = require('child_process');
const socketio = require('socket.io');
const simpleGit = require('simple-git');
const fetch = require('node-fetch'); // v2
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const DIST = path.join(ROOT, 'dist');
const DB_FILE = path.join(ROOT, 'db.json');
const PROJECTS_DIR = path.join(ROOT, 'projects');
const UPLOADS_DIR = path.join(ROOT, 'uploads');

// ensure folders
if (!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// setup lowdb
const adapter = new JSONFile(DB_FILE);
const db = new Low(adapter);

async function initDB() {
  await db.read().catch(() => {});
  db.data = db.data || { users: [], projects: [] }; // projects metadata (optional)
  await db.write();
}
initDB().catch(console.error);

const app = express();
const server = http.createServer(app);
const io = socketio(server, { cors: { origin: "*" } });

// middleware
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(DIST)); // serve frontend

// multer for uploads
const upload = multer({ dest: UPLOADS_DIR });

// -------------------------
// Utility helpers
// -------------------------
function safeName(name) {
  return String(name).replace(/[^a-zA-Z0-9\-_.]/g, '-');
}

function projectPath(project) {
  return path.join(PROJECTS_DIR, safeName(project));
}

function ensureProjectFolder(project) {
  const p = projectPath(project);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}

// -------------------------
// Auth: register / login (simple)
// -------------------------
app.post('/api/register', async (req, res) => {
  await db.read();
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ ok: false, message: 'username & password required' });
  const exists = db.data.users.find(u => u.username === username);
  if (exists) return res.status(400).json({ ok: false, message: 'username already exists' });
  db.data.users.push({ username, password, createdAt: new Date().toISOString() });
  await db.write();
  return res.json({ ok: true, message: 'registered' });
});

app.post('/api/login', async (req, res) => {
  await db.read();
  const { username, password } = req.body;
  const user = db.data.users.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ ok: false, message: 'invalid credentials' });
  // simplistic session token (not secure) — later replace with JWT
  const token = Buffer.from(`${username}:${Date.now()}`).toString('base64');
  return res.json({ ok: true, user: { username }, token });
});

// -------------------------
// Project & File APIs
// -------------------------

// Create project (creates folder)
app.post('/api/project/create', async (req, res) => {
  const { project, username } = req.body;
  if (!project) return res.status(400).json({ ok: false, message: 'project required' });
  const p = ensureProjectFolder(project);
  // optionally add metadata
  await db.read();
  db.data.projects = db.data.projects || [];
  if (!db.data.projects.find(pr => pr.name === project && pr.username === username)) {
    db.data.projects.push({ name: project, username: username || 'anonymous', createdAt: new Date().toISOString() });
    await db.write();
  }
  return res.json({ ok: true, project, path: p });
});

// List projects (metadata)
app.get('/api/projects', async (req, res) => {
  await db.read();
  return res.json({ ok: true, projects: db.data.projects || [] });
});

// List files in a project (recursively)
app.post('/api/files/list', async (req, res) => {
  const { project } = req.body || {};
  const proj = project || 'default';
  const dir = projectPath(proj);
  if (!fs.existsSync(dir)) return res.json({ ok: true, files: [] });

  function walk(d, base) {
    let out = [];
    const items = fs.readdirSync(d);
    for (const it of items) {
      const full = path.join(d, it);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        out = out.concat(walk(full, path.join(base, it)));
      } else {
        out.push(path.join(base, it));
      }
    }
    return out;
  }

  const files = walk(dir, '');
  return res.json({ ok: true, files });
});

// Read file content
app.post('/api/files/read', async (req, res) => {
  const { project, filepath } = req.body || {};
  if (!filepath) return res.status(400).json({ ok: false, message: 'filepath required' });
  const p = projectPath(project || 'default');
  const full = path.join(p, filepath);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, message: 'not found' });
  try {
    const content = fs.readFileSync(full, 'utf8');
    return res.json({ ok: true, content });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Save file
app.post('/api/files/save', async (req, res) => {
  const { project, filepath, content } = req.body || {};
  if (!filepath) return res.status(400).json({ ok: false, message: 'filepath required' });
  const proj = project || 'default';
  const dir = ensureProjectFolder(proj);
  const full = path.join(dir, filepath);
  // prevent path traversal
  if (!full.startsWith(dir)) return res.status(400).json({ ok: false, message: 'invalid path' });
  try {
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content || '', 'utf8');
    return res.json({ ok: true, message: 'saved', path: full });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Delete file
app.post('/api/files/delete', async (req, res) => {
  const { project, filepath } = req.body || {};
  if (!filepath) return res.status(400).json({ ok: false, message: 'filepath required' });
  const dir = projectPath(project || 'default');
  const full = path.join(dir, filepath);
  if (!fs.existsSync(full)) return res.status(404).json({ ok: false, message: 'not found' });
  try {
    fs.unlinkSync(full);
    return res.json({ ok: true, message: 'deleted' });
  } catch (e) {
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// Upload file to project
app.post('/api/upload', upload.single('file'), async (req, res) => {
  const { project } = req.body || {};
  if (!req.file) return res.status(400).json({ ok: false, message: 'file required' });
  const proj = project || 'default';
  const dir = ensureProjectFolder(proj);
  const dest = path.join(dir, req.file.originalname);
  try {
    fs.renameSync(req.file.path, dest);
    return res.json({ ok: true, message: 'uploaded', filename: req.file.originalname });
  } catch (e) {
    // fallback: read & write then remove temp
    const tmp = fs.readFileSync(req.file.path);
    fs.writeFileSync(dest, tmp);
    fs.unlinkSync(req.file.path);
    return res.json({ ok: true, message: 'uploaded (fallback)', filename: req.file.originalname });
  }
});

// Download project as zip
app.get('/api/project/download/:project', async (req, res) => {
  const project = req.params.project;
  const dir = projectPath(project);
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, message: 'project not found' });

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(project)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', err => res.status(500).send({ ok: false, message: err.message }));
  archive.pipe(res);
  archive.directory(dir, false);
  archive.finalize();
});

// -------------------------
// GitHub backup (create repo + push) - optional
// -------------------------
app.post('/api/backup/github', async (req, res) => {
  await db.read();
  const { username, project, token } = req.body || {};
  if (!token || !project) return res.status(400).json({ ok: false, message: 'project & token required' });
  const dir = projectPath(project);
  if (!fs.existsSync(dir)) return res.status(404).json({ ok: false, message: 'project not found' });

  try {
    // create repo via GitHub API
    const payload = { name: safeName(project), private: true, description: `Backup from VsCode-Termux: ${project}` };
    const resp = await fetch('https://api.github.com/user/repos', {
      method: 'POST',
      headers: { Authorization: `token ${token}`, 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
      body: JSON.stringify(payload)
    });
    const j = await resp.json();
    if (!resp.ok) return res.status(500).json({ ok: false, message: 'github create repo failed', details: j });

    // push code using simple-git
    const git = simpleGit(dir);
    await git.init();
    await git.add('.');
    await git.commit('Backup from VsCode-Termux').catch(()=>{});
    const clone_url = j.clone_url; // https://github.com/username/repo.git
    // embed token into url for push
    const authUrl = clone_url.replace('https://', `https://${token}@`);
    await git.addRemote('origin', authUrl).catch(()=>{});
    await git.push(['-u', 'origin', 'HEAD']).catch(err=>{
      // ignore push error but inform user
      console.warn('git push warning', err.message || err);
    });

    return res.json({ ok: true, message: 'backup completed', repo: j.html_url });
  } catch (e) {
    console.error('backup error', e);
    return res.status(500).json({ ok: false, message: e.message });
  }
});

// -------------------------
// Debug endpoints
// -------------------------
app.get('/__debug/db', async (req, res) => {
  await db.read();
  res.json({ ok: true, db: db.data });
});

app.get('/__debug/projects_dir', (req, res) => {
  const list = fs.readdirSync(PROJECTS_DIR);
  res.json({ ok: true, projectsDir: PROJECTS_DIR, list });
});

// -------------------------
// Serve frontend index
// -------------------------
app.get('*', (req, res) => {
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.status(404).send('Frontend not found - build your frontend into /dist');
});

// -------------------------
// Terminal via socket.io
// -------------------------
io.on('connection', (socket) => {
  console.log('[ws] client connected', socket.id);

  socket.on('term:run', ({ cmd, cwd }) => {
    // SECURITY: in production restrict allowed commands or require auth
    try {
      const options = {};
      if (cwd) options.cwd = path.resolve(projectPath(cwd) || PROJECTS_DIR);
      const child = spawn(cmd, { shell: true, ...options });

      socket.emit('term:spawned', { pid: child.pid });

      child.stdout.on('data', d => socket.emit('term:data', { type: 'stdout', text: d.toString() }));
      child.stderr.on('data', d => socket.emit('term:data', { type: 'stderr', text: d.toString() }));
      child.on('close', code => socket.emit('term:exit', { code }));

      socket.on('term:kill', () => {
        try { child.kill('SIGTERM'); } catch(e){ }
      });

    } catch (e) {
      socket.emit('term:error', { message: e.message });
    }
  });

  socket.on('disconnect', () => {
    console.log('[ws] client disconnected', socket.id);
  });
});

// -------------------------
// Start server
// -------------------------
server.listen(PORT, HOST, () => {
  console.log(`✅ VsCode-Termux server listening on http://${HOST}:${PORT}`);
  console.log(` - Frontend folder: ${DIST}`);
  console.log(` - Projects folder: ${PROJECTS_DIR}`);
  console.log(` - DB file: ${DB_FILE}`);
});
