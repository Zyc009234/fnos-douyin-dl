// 书签小工具源码。index.html 会把它和 NAS 地址拼成 javascript: 链接。
// 在 https 的抖音页面里不能直接请求 http 的 NAS（混合内容会被拦截），
// 所以用 window.open 打开 NAS 的 /add 页面，把视频信息放在查询参数里。
function douyinToNas(NAS) {
  // 电脑：www.douyin.com；手机：分享链接打开的 www.iesdouyin.com/share/video/...
  if (!/(^|\.)(ies)?douyin\.com$/.test(location.hostname)) {
    alert('请在抖音视频页面使用：电脑打开 www.douyin.com，手机用浏览器打开抖音分享链接');
    return;
  }
  function httpSources(v) {
    var list = [v.currentSrc].concat([].map.call(v.querySelectorAll('source'), function (s) { return s.src; }));
    return list.filter(function (u, i) { return /^https?:/.test(u || '') && list.indexOf(u) === i; });
  }
  function visibleArea(v) {
    var r = v.getBoundingClientRect();
    var vw = innerWidth || document.documentElement.clientWidth;
    var vh = innerHeight || document.documentElement.clientHeight;
    var w = Math.min(r.right, vw) - Math.max(r.left, 0);
    var h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    return Math.max(0, w) * Math.max(0, h);
  }
  // 优先选正在播放的，其次选屏幕上露出面积最大的
  var videos = [].slice.call(document.querySelectorAll('video')).filter(function (v) {
    return httpSources(v).length;
  });
  videos.sort(function (a, b) {
    return (a.paused - b.paused) || (visibleArea(b) - visibleArea(a));
  });
  var v = videos[0];
  if (!v) {
    alert('没有找到可下载的视频。\n请先打开视频并让它开始播放；直播、图集暂不支持。');
    return;
  }
  var srcs = httpSources(v);
  var url = srcs.filter(function (u) { return /douyinvod|zjcdn|bytecdn|bytevcloud/.test(u); })[0] || srcs[0];
  // 手机分享页播放的是带水印的 /aweme/v1/playwm/，换成 /play/ 即为无水印原片
  url = url.replace('/aweme/v1/playwm/', '/aweme/v1/play/');

  var m = url.match(/[?&]__vid=(\d+)/) ||
    location.href.match(/\/video\/(\d+)/) ||
    location.href.match(/[?&]modal_id=(\d+)/);
  var id = m ? m[1] : '';

  var box = v.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"],[data-e2e="feed-item"]') || document;
  function text(sel, root) {
    var e = (root || box).querySelector(sel);
    return e ? e.innerText.trim().split('\n')[0] : '';
  }
  // 没有文案的作品，页面标题形如「作者在抖音记录美好生活…」，这时标题留空
  var pageTitle = /在抖音记录美好生活/.test(document.title) ? '' : document.title.replace(/\s*-\s*抖音\s*$/, '');
  var title = text('[data-e2e="video-desc"]') || text('[data-e2e="detail-video-info"] h1', document) || pageTitle;
  var userLink = [].filter.call(document.querySelectorAll('[data-e2e="user-info"] a[href*="/user/"]'), function (a) {
    return a.innerText.trim();
  })[0];
  var author = text('[data-e2e="feed-video-nickname"]') || text('[data-e2e="video-author-name"]') ||
    (userLink ? userLink.innerText.trim().split('\n')[0] : '');
  if (!author) {
    // 手机分享页：<meta name="description" content="作者于20250601发布在抖音…">
    var meta = document.querySelector('meta[name="description"]');
    var am = meta && meta.content.match(/(?:^|\s-\s)(\S+?)于\d{8}发布在抖音/);
    author = am ? am[1] : '';
  }

  var q = 'url=' + encodeURIComponent(url) + '&id=' + encodeURIComponent(id) +
    '&title=' + encodeURIComponent(title.slice(0, 120)) + '&author=' + encodeURIComponent(author.slice(0, 40)) +
    '&page=' + encodeURIComponent(location.origin + location.pathname);
  var target = NAS + '/add?' + q;
  var w = window.open(target, 'douyin_to_nas', 'width=460,height=360');
  // 弹窗被拦截（手机浏览器常见）时直接在当前页打开
  if (!w) location.href = target;
}
