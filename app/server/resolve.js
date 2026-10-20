'use strict';
// 分享链接解析：在 NAS 上用无头 Chromium 打开抖音电脑版作品页，截获页面自己发出的
// 作品详情请求（带抖音的签名），从响应里取无水印播放地址、文案和作者。
// 抖音的接口直接请求会被风控拦截，分享页也不再输出视频数据，所以只能借助真实浏览器。

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CHROMIUM_CANDIDATES = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
const CDN = /douyinvod|zjcdn|bytecdn|bytevcloud/;
const TIMEOUT_MS = 30000;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function findChromium() {
  return CHROMIUM_CANDIDATES.find((p) => p && fs.existsSync(p)) || '';
}

// UA 里的版本号必须和 Chromium 实际版本一致，否则会被识别为自动化程序，接口返回空内容
let browserInfo = null;
function getBrowserInfo(bin) {
  if (browserInfo) return browserInfo;
  let full = '147.0.0.0';
  try {
    full = (execFileSync(bin, ['--version'], { encoding: 'utf8', timeout: 10000 }).match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1] || full;
  } catch (e) {}
  const major = full.split('.')[0];
  browserInfo = {
    ua: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    meta: {
      brands: [
        { brand: 'Chromium', version: major },
        { brand: 'Google Chrome', version: major },
        { brand: 'Not.A/Brand', version: '99' },
      ],
      fullVersion: full,
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false,
    },
  };
  return browserInfo;
}

// 从分享文案里找作品 ID：支持 v.douyin.com 短链、douyin.com/video/…、iesdouyin.com/share/video/…、modal_id=…
async function findAwemeId(text) {
  text = String(text || '');
  const direct = text.match(/(?:\/video\/|\/note\/|modal_id=|aweme_id=)(\d{15,20})/);
  if (direct) return direct[1];
  const link = text.match(/https?:\/\/[^\s"'<>，。！]*douyin\.com[^\s"'<>，。！]*/);
  if (!link) {
    const bare = text.trim().match(/^\d{15,20}$/);
    if (bare) return bare[0];
    throw new Error('没有找到抖音链接，请分享或复制抖音作品的链接');
  }
  // 短链接跳转到 iesdouyin.com/share/video/<id>/，只跟随跳转，不读取页面
  let url = link[0];
  for (let i = 0; i < 5; i++) {
    const m = url.match(/(?:\/video\/|\/note\/|modal_id=)(\d{15,20})/);
    if (m) return m[1];
    const res = await fetch(url, { redirect: 'manual', headers: { 'User-Agent': MOBILE_UA }, signal: AbortSignal.timeout(10000) });
    const next = res.headers.get('location');
    if (!next) break;
    url = new URL(next, url).href;
  }
  throw new Error('无法从链接中识别作品，请确认是抖音视频的分享链接');
}

// 同一时间只开一个浏览器，避免占用过多内存
let chain = Promise.resolve();
function resolveAweme(awemeId) {
  const job = chain.then(() => runBrowser(awemeId));
  chain = job.catch(() => {});
  return job;
}

function runBrowser(awemeId) {
  const bin = findChromium();
  if (!bin) {
    return Promise.reject(new Error('NAS 上没有安装 Chromium，无法解析分享链接。请用 SSH 执行：sudo apt install chromium'));
  }
  const { ua, meta } = getBrowserInfo(bin);
  const dir = fs.mkdtempSync(path.join(process.env.TRIM_PKGTMP || os.tmpdir(), 'dydl-cr-'));
  const proc = spawn(bin, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--mute-audio', '--no-first-run',
    '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage',
    '--remote-debugging-port=0', '--user-data-dir=' + dir, '--user-agent=' + ua,
    '--lang=zh-CN', '--window-size=1280,800', 'about:blank',
  ], { stdio: 'ignore' });

  let ws = null;
  let timer = null;
  const cleanup = () => {
    clearTimeout(timer);
    try { if (ws) ws.close(); } catch (e) {}
    const rm = () => fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    if (proc.exitCode === null) {
      proc.once('exit', rm);
      proc.kill('SIGKILL');
    } else rm();
  };

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      err ? reject(err) : resolve(val);
    };
    timer = setTimeout(() => finish(new Error('解析超时，请稍后再试')), TIMEOUT_MS);
    proc.on('error', (e) => finish(new Error('启动 Chromium 失败：' + e.message)));
    proc.on('exit', () => finish(new Error('Chromium 意外退出')));

    (async () => {
      // --remote-debugging-port=0 时，实际端口写在 DevToolsActivePort 文件里
      let port = 0;
      for (let i = 0; i < 80 && !port && !settled; i++) {
        await new Promise((r) => setTimeout(r, 125));
        try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch (e) {}
      }
      if (!port) throw new Error('Chromium 启动失败');
      let page;
      for (let i = 0; i < 40 && !page; i++) {
        try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch (e) {}
        if (!page) await new Promise((r) => setTimeout(r, 125));
      }
      if (!page) throw new Error('Chromium 启动失败');

      ws = new WebSocket(page.webSocketDebuggerUrl);
      let seq = 0;
      const pending = {};
      const send = (method, params = {}) => new Promise((res) => {
        const id = ++seq;
        pending[id] = res;
        ws.send(JSON.stringify({ id, method, params }));
      });
      const detailReqs = new Set();
      let filterMsg = '';
      ws.onmessage = async (m) => {
        const d = JSON.parse(m.data);
        if (d.id && pending[d.id]) return pending[d.id](d.result || {});
        if (d.method === 'Network.responseReceived' && /\/aweme\/v1\/web\/aweme\/detail\//.test(d.params.response.url)) {
          detailReqs.add(d.params.requestId);
        }
        if (d.method === 'Network.loadingFinished' && detailReqs.has(d.params.requestId)) {
          const body = (await send('Network.getResponseBody', { requestId: d.params.requestId })).body || '';
          let j;
          try { j = JSON.parse(body); } catch (e) { return; }
          const a = j.aweme_detail;
          if (!a) {
            // 作品不可见时页面会重试几次，记下原因，超时前没有拿到就报这个原因
            if (j.filter_detail && j.filter_detail.detail_msg) {
              filterMsg = j.filter_detail.detail_msg;
              setTimeout(() => finish(new Error(filterMsg)), 3000);
            }
            return;
          }
          if (a.images && a.images.length) return finish(new Error('这是图集作品，暂不支持下载'));
          const list = (a.video && a.video.play_addr && a.video.play_addr.url_list) || [];
          const url = list.filter((u) => CDN.test(u))[0] || list[0];
          if (!url) return finish(new Error('没有找到视频地址，直播和图集暂不支持'));
          finish(null, { url, id: a.aweme_id || awemeId, title: a.desc || '', author: (a.author && a.author.nickname) || '' });
        }
      };
      await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('连接 Chromium 失败')); });
      await send('Network.enable');
      await send('Emulation.setUserAgentOverride', { userAgent: ua, acceptLanguage: 'zh-CN,zh', platform: 'Win32', userAgentMetadata: meta });
      await send('Page.addScriptToEvaluateOnNewDocument', {
        source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});window.chrome=window.chrome||{runtime:{}};",
      });
      await send('Page.navigate', { url: 'https://www.douyin.com/video/' + awemeId });
    })().catch((e) => finish(e));
  });
}

module.exports = { findAwemeId, resolveAweme, findChromium };
