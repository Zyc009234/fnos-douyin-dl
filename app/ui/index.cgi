#!/var/apps/nodejs_v22/target/bin/node
'use strict';
// CGI 入口：把 /cgi/ThirdParty/DouyinDL/index.cgi/<path> 转发给本机下载服务。
// 走飞牛自身的域名和端口，远程访问（FN Connect / 域名 / 反代）也能打开，并由飞牛校验登录态。

const http = require('http');

const PORT = 8866;
const env = process.env;
const out = process.stdout;

function reply(status, type, body, extra = '') {
  out.write(`Status: ${status}\r\nContent-Type: ${type}\r\n${extra}\r\n`);
  out.end(body);
}

const uri = env.REQUEST_URI || '/';
const pathOnly = uri.split('?')[0];
const idx = pathOnly.indexOf('index.cgi');
let rel = idx >= 0 ? pathOnly.slice(idx + 'index.cgi'.length) : '/';

// 没有结尾斜杠时补上，否则页面里的相对路径会解析错
if (rel === '') {
  const qs = env.QUERY_STRING ? '?' + env.QUERY_STRING : '';
  reply('302 Found', 'text/plain; charset=utf-8', '', `Location: ${pathOnly}/${qs}\r\n`);
  return;
}
if (rel.includes('..')) {
  reply('400 Bad Request', 'text/plain; charset=utf-8', 'Bad Request');
  return;
}

const headers = {};
if (env.CONTENT_TYPE) headers['Content-Type'] = env.CONTENT_TYPE;
if (env.CONTENT_LENGTH) headers['Content-Length'] = env.CONTENT_LENGTH;
if (env.HTTP_RANGE) headers['Range'] = env.HTTP_RANGE;

const req = http.request(
  {
    host: '127.0.0.1',
    port: PORT,
    method: env.REQUEST_METHOD || 'GET',
    path: rel + (env.QUERY_STRING ? '?' + env.QUERY_STRING : ''),
    headers,
  },
  (res) => {
    let head = `Status: ${res.statusCode} ${res.statusMessage || ''}\r\n`;
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'cache-control', 'location']) {
      if (res.headers[k]) head += `${k}: ${res.headers[k]}\r\n`;
    }
    out.write(head + '\r\n');
    res.pipe(out);
  }
);
req.on('error', () => {
  reply('502 Bad Gateway', 'text/html; charset=utf-8',
    '<meta charset="utf-8"><p style="font-family:sans-serif">下载服务没有运行，请在应用中心启动「抖音下载」。</p>');
});

const len = Number(env.CONTENT_LENGTH) || 0;
if (len > 0) process.stdin.pipe(req);
else req.end();
