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

const HOME = process.env.HOME || __dirname;
const DB_DIR = path.join(HOME, '.vscode-termux');
if(!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive:true });
const adapter = new JSONFile(path.join(DB_DIR, 'db.json'));
const db = new Low(adapter);

(async ()=>{
  await db.read();
  db.data = db.data || { settings:{language:'en',theme:'dark-blue',autoBackup:false}, users:[], projects:[] };
  await db.write();
  console.log('DB loaded', db.data);
})();

const PROJECTS_DIR = path.join(HOME, 'projects');
if(!fs.existsSync(PROJECTS_DIR)) fs.mkdirSync(PROJECTS_DIR, { recursive:true });

// serve frontend
const DIST = path.join(__dirname, '..', 'frontend', 'dist');
if(fs.existsSync(DIST)) app.use(express.static(DIST));

// debug endpoint
app.get('/__debug/db', async (req,res)=>{ await db.read(); res.json({ ok:true, db: db.data }); });

// settings
app.get('/api/settings', async (req,res)=>{ await db.read(); res.json({ ok:true, settings: db.data.settings }); });
app.post('/api/settings', async (req,res)=>{ try{ await db.read(); db.data.settings = req.body; await db.write(); return res.json({ ok:true }); }catch(e){ return res.status(500).json({ error:e.message }); } });

// files endpoints
app.post('/api/files/save', async (req,res)=>{ try{ const { project='default', path: pth, content='' } = req.body || {}; if(!pth) return res.status(400).json({ error:'path required' }); const projDir = path.join(PROJECTS_DIR, project); fs.mkdirSync(projDir, { recursive:true }); const full = path.join(projDir, pth); fs.mkdirSync(path.dirname(full), { recursive:true }); fs.writeFileSync(full, content, 'utf8'); console.log('Saved', full); return res.json({ ok:true }); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });
app.post('/api/files/read', (req,res)=>{ try{ const { project='default', path: pth } = req.body || {}; const full = path.join(PROJECTS_DIR, project, pth); if(!fs.existsSync(full)) return res.status(404).json({ error:'not found' }); return res.json({ ok:true, content: fs.readFileSync(full,'utf8') }); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });
app.post('/api/files/list', (req,res)=>{ try{ const { project='default' } = req.body || {}; const dir = path.join(PROJECTS_DIR, project); if(!fs.existsSync(dir)) return res.json({ ok:true, files:[] }); function walk(d){ let out=[]; const items = fs.readdirSync(d); for(const it of items){ const p=path.join(d,it); const stat=fs.statSync(p); if(stat.isDirectory()) out.push(...walk(p)); else out.push(path.relative(dir,p)); } return out; } const files = walk(dir); return res.json({ ok:true, files }); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });
app.post('/api/files/download', (req,res)=>{ try{ const { project='default' } = req.body || {}; const dir = path.join(PROJECTS_DIR, project); if(!fs.existsSync(dir)) return res.status(404).json({ error:'project not found' }); res.setHeader('Content-Type','application/zip'); res.setHeader('Content-Disposition','attachment; filename="'+project+'.zip"'); const archive = archiver('zip', { zlib: { level: 9 } }); archive.on('error', err=> res.status(500).send({ error: err.message })); archive.pipe(res); archive.directory(dir, false); archive.finalize(); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });

// upload file
app.post('/api/files/upload', upload.single('file'), (req,res)=>{ try{ const { project='default' } = req.body || {}; const projDir = path.join(PROJECTS_DIR, project); fs.mkdirSync(projDir, { recursive:true }); const dest = path.join(projDir, req.file.originalname); fs.renameSync(req.file.path, dest); console.log('Uploaded', dest); return res.json({ ok:true, name:req.file.originalname }); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });

// run commands (node/python)
app.post('/api/run', (req,res)=>{ try{ const { project='default', path: pth } = req.body || {}; const full = path.join(PROJECTS_DIR, project, pth); if(!fs.existsSync(full)) return res.status(404).json({ error:'not found' }); const ext = path.extname(full).toLowerCase(); let cmd,args; if(ext==='.js'){ cmd='node'; args=[full]; } else if(ext==='.py'){ cmd='python3'; args=[full]; } else { return res.status(400).json({ error:'unsupported' }); } const runId = Date.now().toString(); const child = spawn(cmd, args, { cwd: path.dirname(full) }); child.stdout.on('data', d=> io.emit('run:output', { id: runId, type:'stdout', text: d.toString() })); child.stderr.on('data', d=> io.emit('run:output', { id: runId, type:'stderr', text: d.toString() })); child.on('close', code=> io.emit('run:exit', { id: runId, code })); return res.json({ ok:true, id: runId }); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });

// github backup (manual)
app.post('/api/github/backup', async (req,res)=>{ try{ const { project='default', token } = req.body || {}; if(!token) return res.status(400).json({ error:'token required' }); const repoName = project.replace(/[^a-zA-Z0-9-_.]/g,'-').toLowerCase(); const payload = { name: repoName, description: 'Backup from VsCode-Termux', private: true, auto_init: false }; const resp = await fetch('https://api.github.com/user/repos', { method: 'POST', headers: { 'Authorization': 'token ' + token, 'Accept':'application/vnd.github+json','Content-Type':'application/json' }, body: JSON.stringify(payload) }); const j = await resp.json(); const projectDir = path.join(PROJECTS_DIR, project); const git = simpleGit(projectDir); await git.init(); await git.add('.'); await git.commit('Backup from VsCode-Termux'); const remoteUrl = (j && j.clone_url) ? j.clone_url : null; if(remoteUrl){ const authUrl = remoteUrl.replace('https://', 'https://' + token + '@'); await git.addRemote('origin', authUrl).catch(()=>{}); await git.push(['-u', 'origin', 'HEAD']).catch(()=>{}); } return res.json({ ok:true, repo: (j && j.html_url) ? j.html_url : null }); }catch(e){ console.error(e); return res.status(500).json({ error:e.message }); } });

app.get('*', (req,res)=>{ const index = path.join(DIST,'index.html'); if(fs.existsSync(index)) return res.sendFile(index); res.send('<h3>VsCode frontend missing</h3>'); });

const port = process.env.PORT || 3000;
server.listen(port, ()=> console.log('VsCode-Termux listening on', port));
