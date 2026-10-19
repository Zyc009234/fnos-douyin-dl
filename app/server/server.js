'use strict';
// 抖音视频 NAS 下载服务：接收书签小工具发来的视频地址，下载到飞牛共享目录。
// 仅依赖 Node.js 标准库。

const http = require('http');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// 部分网络环境 IPv6 不通，优先使用 IPv4
dns.setDefaultResultOrder('ipv4first');

const PORT = Number(process.env.TRIM_SERVICE_PORT || process.env.PORT || 8866);
const VAR_DIR = process.env.TRIM_PKGVAR || path.join(__dirname, '..', '..', 'var');
const SAVE_DIR =
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
fs.mkdirSync(SAVE_DIR, { recursive: true });

// ---------- 任务与历史 ----------

let tasks = [];
try {
  tasks = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  // 上次退出时未完成的任务标记为失败
  for (const t of tasks) {
    if (t.status === 'queued' || t.status === 'downloading') {
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

function addTask(info) {
  const id = info.id ? String(info.id).replace(/\D/g, '') : '';
  const existing = id && tasks.find((t) => t.awemeId === id && t.status !== 'error');
  if (existing) return { task: existing, duplicate: true };

  const task = {
    tid: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    awemeId: id,
    title: sanitize(info.title) || '抖音视频',
    author: sanitize(info.author),
    pageUrl: String(info.pageUrl || ''),
    videoUrl: String(info.url),
    status: 'queued',
    received: 0,
    total: 0,
    file: '',
    error: '',
    createdAt: Date.now(),
  };
  tasks.unshift(task);
  saveHistory();
  pump();
  return { task, duplicate: false };
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
  const res = await fetch(task.videoUrl, {
    headers: { 'User-Agent': UA, Referer: 'https://www.douyin.com/' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}（链接可能已过期，请回到抖音页面重新发送）`);
  const type = res.headers.get('content-type') || '';
  if (/text\/html|json/.test(type)) throw new Error('返回的不是视频文件，链接可能已失效');

  task.total = Number(res.headers.get('content-length')) || 0;
  const base = sanitize([task.author, task.title, task.awemeId].filter(Boolean).join('_')) || task.tid;
  const finalPath = uniquePath(SAVE_DIR, base, '.mp4');
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
  return path.join(SAVE_DIR, base);
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
    if (req.method === 'GET' && p === '/api/tasks') {
      return sendJson(res, 200, { saveDir: SAVE_DIR, tasks: tasks.map(publicTask) });
    }
    if (req.method === 'POST' && p === '/api/tasks/clear') {
      tasks = tasks.filter((t) => t.status === 'queued' || t.status === 'downloading');
      saveHistory();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && p === '/api/files') {
      const files = fs
        .readdirSync(SAVE_DIR, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith('.mp4'))
        .map((d) => {
          const st = fs.statSync(path.join(SAVE_DIR, d.name));
          return { name: d.name, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
      return sendJson(res, 200, { saveDir: SAVE_DIR, files });
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
  console.log(`[douyin-dl] listening on :${PORT}, saving to ${SAVE_DIR}`);
});
