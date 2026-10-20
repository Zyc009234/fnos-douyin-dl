'use strict';
// 抖音视频 NAS 下载服务：接收书签小工具发来的视频地址，下载到飞牛共享目录。
// 仅依赖 Node.js 标准库。

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const os = require('os');
const { findAwemeId, resolveAweme, findChromium } = require('./resolve');

// 部分网络环境 IPv6 不通，优先使用 IPv4
dns.setDefaultResultOrder('ipv4first');

const PORT = Number(process.env.TRIM_SERVICE_PORT || process.env.PORT || 8866);
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', 'var');
const DEFAULT_SAVE_DIR =
  (process.env.TRIM_DATA_SHARE_PATHS || '').split(':').filter(Boolean)[0] ||
  process.env.SAVE_DIR ||
  path.join(VAR_DIR, 'videos');
const WWW_DIR = path.join(__dirname, '..', 'www');
const HISTORY_FILE = path.join(VAR_DIR, 'history.json');
const MAX_CONCURRENT = 2;
const MAX_HISTORY = 200;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

fs.mkdirSync(VAR_DIR, { recursive: true });
fs.mkdirSync(DEFAULT_SAVE_DIR, { recursive: true });

// ---------- 保存位置 ----------
// 默认存到应用的共享目录；也可以改成其他文件夹，但应用以独立账号运行，
// 需要先在飞牛「系统设置 → 应用 → 抖音下载 → 访问权限」里给本应用授权该文件夹的读写权限。

const SETTINGS_FILE = path.join(VAR_DIR, 'settings.json');
let saveDir = DEFAULT_SAVE_DIR;
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (s.saveDir) saveDir = s.saveDir;
} catch (e) {}

const NO_PERMISSION_TIP = '应用没有这个文件夹的写入权限。请在飞牛「系统设置 → 应用 → 抖音下载 → 访问权限」里点「添加」，选择这个文件夹并给读写权限，然后再保存一次。';

// 实际写一个文件来检查，ACL 授权用 fs.access 判断不准
function checkWritable(dir) {
  if (!path.isAbsolute(dir)) throw new Error('请填写完整路径，例如 /vol1/1000/视频/抖音');
  dir = path.normalize(dir).replace(/\/+$/, '') || '/';
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.douyindl-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') throw Object.assign(new Error(NO_PERMISSION_TIP), { reason: 'no_permission' });
    if (e.code === 'EROFS') throw new Error('这个文件夹所在的存储是只读的');
    throw new Error('无法使用这个文件夹：' + e.message);
  }
  return dir;
}

function setSaveDir(dir) {
  saveDir = dir ? checkWritable(String(dir).trim()) : DEFAULT_SAVE_DIR;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(saveDir === DEFAULT_SAVE_DIR ? {} : { saveDir }));
  return saveDir;
}

// 已授权给本应用的文件夹（飞牛通过环境变量传入），在设置里作为快捷选项
function accessiblePaths() {
  return [...new Set([DEFAULT_SAVE_DIR].concat((process.env.TRIM_DATA_ACCESSIBLE_PATHS || '').split(':').filter(Boolean)))];
}

// ---------- 任务与历史 ----------

let tasks = [];
try {
  tasks = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  // 上次退出时未完成的任务标记为失败
  for (const t of tasks) {
    if (t.status === 'queued' || t.status === 'downloading' || t.status === 'resolving') {
      t.status = 'error';
      t.error = '服务重启，任务中断';
    }
  }
} catch (e) {
  tasks = [];
}

let saveTimer = null;
function saveHistory() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(HISTORY_FILE, JSON.stringify(tasks.slice(0, MAX_HISTORY)), () => {});
  }, 500);
}

function sanitize(name) {
  return String(name || '')
    .replace(/[\\/:*?"<>|\r\n\t#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, base + ext);
  for (let i = 2; fs.existsSync(p); i++) p = path.join(dir, `${base} (${i})${ext}`);
  return p;
}

function isAllowedMediaUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch (e) {
    return false;
  }
}

function findExisting(id) {
  return id && tasks.find((t) => t.awemeId === id && t.status !== 'error');
}

function newTask(id, status) {
  const task = {
    tid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    awemeId: id,
    title: '抖音视频',
    author: '',
    pageUrl: '',
    videoUrl: '',
    status,
    received: 0,
    total: 0,
    file: '',
    error: '',
    createdAt: Date.now(),
  };
  tasks.unshift(task);
  return task;
}

function addTask(info) {
  const id = info.id ? String(info.id).replace(/\D/g, '') : '';
  const existing = findExisting(id);
  if (existing) return { task: existing, duplicate: true };

  const task = newTask(id, 'queued');
  task.title = sanitize(info.title) || '抖音视频';
  task.author = sanitize(info.author);
  task.pageUrl = String(info.pageUrl || '');
  task.videoUrl = String(info.url);
  saveHistory();
  pump();
  return { task, duplicate: false };
}

// 分享链接：先在 NAS 上解析出无水印地址（见 resolve.js），再加入下载队列
async function shareTask(text) {
  const id = await findAwemeId(text);
  const existing = findExisting(id);
  if (existing) return { task: existing, duplicate: true };

  const task = newTask(id, 'resolving');
  task.title = '正在解析…';
  task.pageUrl = 'https://www.douyin.com/video/' + id;
  saveHistory();
  try {
    const info = await resolveAweme(id);
    task.title = sanitize(info.title) || '抖音视频';
    task.author = sanitize(info.author);
    task.videoUrl = info.url;
    task.status = 'queued';
    saveHistory();
    pump();
    return { task, duplicate: false };
  } catch (e) {
    task.title = '抖音视频 ' + id;
    task.status = 'error';
    task.error = e.message || String(e);
    saveHistory();
    throw e;
  }
}

// 快捷指令不带飞牛的登录状态，走不了 CGI 入口，只能直连服务端口；列出局域网地址供管理页显示
function shareUrls() {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !/^(172\.(1[6-9]|2\d|3[01])|169\.254)\./.test(a.address)) ips.push(a.address);
    }
  }
  return ips.map((ip) => `http://${ip}:${PORT}/api/share`);
}

// 快捷指令可能以 JSON、表单或纯文本发送分享内容，也可能放在 ?text= 里，统一拼成一段文本再找链接
function shareText(raw, url) {
  const parts = [url.searchParams.get('text') || ''];
  try {
    const j = JSON.parse(raw);
    parts.push(j && typeof j === 'object' ? Object.values(j).join(' ') : String(j));
  } catch (e) {
    parts.push(raw);
    try { parts.push(decodeURIComponent(raw.replace(/\+/g, ' '))); } catch (e2) {}
  }
  return parts.join(' ');
}

let running = 0;
function pump() {
  while (running < MAX_CONCURRENT) {
    const next = tasks.slice().reverse().find((t) => t.status === 'queued');
    if (!next) return;
    running++;
    next.status = 'downloading';
    download(next)
      .then(() => {
        next.status = 'done';
      })
      .catch((e) => {
        next.status = 'error';
        next.error = e.message || String(e);
      })
      .finally(() => {
        delete next.videoUrl; // 带签名的临时地址，完成后无需保留
        running--;
        saveHistory();
        pump();
      });
  }
}

async function download(task) {
  // 保存位置可能是后来被取消授权的文件夹，或拔掉的外接硬盘
  let dir;
  try {
    dir = checkWritable(saveDir);
  } catch (e) {
    throw new Error('保存位置 ' + saveDir + ' 不可用：' + e.message);
  }
  const res = await fetch(task.videoUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（链接可能已过期，请回到抖音页面重新发送）`);
  const type = res.headers.get('content-type') || '';
  if (/text\/html|json/.test(type)) throw new Error('返回的不是视频文件，链接可能已失效');

  task.total = Number(res.headers.get('content-length')) || 0;
  const base = sanitize([task.author, task.title, task.awemeId].filter(Boolean).join('_')) || task.tid;
  const finalPath = uniquePath(dir, base, '.mp4');
  const tmpPath = finalPath + '.part';

  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    task.received += chunk.length;
  });
  try {
    await pipeline(body, fs.createWriteStream(tmpPath));
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    fs.rm(tmpPath, { force: true }, () => {});
    throw e;
  }
  task.file = path.basename(finalPath);
}

// ---------- HTTP ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

function sendJson(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求过大'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

// 视频文件支持 Range，便于网页内预览拖动
function serveVideo(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendJson(res, 404, { error: '文件不存在' });
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(path.basename(file))}`,
    };
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
      if (start >= st.size || start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      fs.createReadStream(file, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      fs.createReadStream(file).pipe(res);
    }
  });
}

function safeSavedFile(name) {
  const base = path.basename(String(name || ''));
  if (!base || base.startsWith('.') || !base.endsWith('.mp4')) return null;
  return path.join(saveDir, base);
}

function publicTask(t) {
  const { videoUrl, ...rest } = t;
  return rest;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveStatic(res, path.join(WWW_DIR, 'index.html'));
    }
    if (req.method === 'GET' && p === '/add') {
      return serveStatic(res, path.join(WWW_DIR, 'add.html'));
    }
    if (req.method === 'GET' && p.startsWith('/static/')) {
      const f = path.join(WWW_DIR, path.normalize(p.slice('/static/'.length)).replace(/^(\.\.[\\/])+/, ''));
      if (!f.startsWith(WWW_DIR)) return sendJson(res, 400, { error: 'bad path' });
      return serveStatic(res, f);
    }

    if (req.method === 'POST' && p === '/api/download') {
      const info = JSON.parse((await readBody(req)) || '{}');
      if (!isAllowedMediaUrl(info.url)) return sendJson(res, 400, { error: '视频地址无效' });
      const { task, duplicate } = addTask(info);
      return sendJson(res, 200, { ok: true, duplicate, task: publicTask(task) });
    }
    // 分享链接下载：默认返回纯文本，方便快捷指令直接显示为通知；管理页带 ?json=1
    if ((req.method === 'POST' || req.method === 'GET') && p === '/api/share') {
      const text = shareText(req.method === 'POST' ? await readBody(req) : '', url);
      let code = 200;
      let data;
      try {
        const { task, duplicate } = await shareTask(text);
        data = { ok: true, duplicate, message: (duplicate ? '已经在下载列表里了：' : '已加入下载：') + task.title, task: publicTask(task) };
      } catch (e) {
        code = 400;
        data = { error: e.message || String(e), message: '下载失败：' + (e.message || String(e)) };
      }
      if (url.searchParams.has('json')) return sendJson(res, code, data);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(data.message);
    }
    if (req.method === 'GET' && p === '/api/tasks') {
      return sendJson(res, 200, { saveDir: saveDir, shareUrls: shareUrls(), chromium: !!findChromium(), tasks: tasks.map(publicTask) });
    }
    if (req.method === 'POST' && p === '/api/tasks/clear') {
      tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'downloading' || t.status === 'resolving');
      saveHistory();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/files') {
      let entries;
      try {
        entries = fs.readdirSync(saveDir, { withFileTypes: true });
      } catch (e) {
        return sendJson(res, 200, { saveDir, files: [], error: '无法读取保存位置：' + e.message });
      }
      const files = entries
        .filter((d) => d.isFile() && d.name.endsWith('.mp4'))
        .map((d) => {
          const st = fs.statSync(path.join(saveDir, d.name));
          return { name: d.name, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { saveDir, files });
    }
    if (req.method === 'GET' && p === '/api/settings') {
      return sendJson(res, 200, { saveDir, defaultDir: DEFAULT_SAVE_DIR, accessible: accessiblePaths() });
    }
    // saveDir 为空表示恢复默认的共享目录
    if (req.method === 'POST' && p === '/api/settings') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        setSaveDir(body.saveDir);
      } catch (e) {
        return sendJson(res, 400, { error: e.message, code: e.reason || '' });
      }
      return sendJson(res, 200, { ok: true, saveDir, defaultDir: DEFAULT_SAVE_DIR, accessible: accessiblePaths() });
    }
    if (p.startsWith('/files/')) {
      const f = safeSavedFile(decodeURIComponent(p.slice('/files/'.length)));
      if (!f) return sendJson(res, 400, { error: '文件名无效' });
      if (req.method === 'GET') return serveVideo(req, res, f);
      if (req.method === 'DELETE') {
        fs.rmSync(f, { force: true });
        return sendJson(res, 200, { ok: true });
      }
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 500, { error: e.message || String(e) });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[douyin-dl] listening on :${PORT}, saving to ${saveDir}`);
});
