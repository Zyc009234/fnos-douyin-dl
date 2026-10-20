// 书签小工具源码。index.html 会把它和 NAS 地址拼成 javascript: 链接。
// 在 https 的抖音页面里不能直接请求 http 的 NAS（混合内容会被拦截），
// 所以用 window.open 打开 NAS 的 /add 页面，把视频信息放在查询参数里。
function douyinToNas(NAS) {
  // 电脑：www.douyin.com；手机：分享链接打开的 www.iesdouyin.com/share/video/...
  if (!/(^|\.)(ies)?douyin\.com$/.test(location.hostname)) {
    alert('请在抖音视频页面使用：电脑打开 www.douyin.com，手机用浏览器打开抖音分享链接');
    return;
  }
  var NOT_FOUND = '没有找到可下载的视频。\n请先打开视频并让它开始播放；直播、图集暂不支持。';
  var CDN = /douyinvod|zjcdn|bytecdn|bytevcloud/;
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
  function idFromAttrs(e) {
    for (var i = 0; e && e.attributes && i < e.attributes.length; i++) {
      var a = e.attributes[i].value.match(/^(\d{18,20})$|\/video\/(\d{18,20})|modal_id=(\d{18,20})/);
      if (a) return a[1] || a[2] || a[3];
    }
    return '';
  }
  // 推荐流的地址栏里没有作品 ID：依次从视频所在卡片的属性（如 data-e2e-vid）、
  // 当前作品卡片里的作品链接、最近请求过的视频地址（带 __vid=）里找
  function idFromDom(v) {
    var id = '';
    for (var e = v; !id && e && e !== document.body; e = e.parentElement) id = idFromAttrs(e);
    var active = v.closest('[data-e2e="feed-active-video"]') || document.querySelector('[data-e2e="feed-active-video"]');
    if (!id && active) {
      id = idFromAttrs(active);
      if (!id) [].some.call(active.querySelectorAll('a[href*="/video/"],[data-e2e-vid]'), function (e) { return (id = idFromAttrs(e)); });
    }
    if (!id && window.performance && performance.getEntriesByType) {
      var hits = performance.getEntriesByType('resource').map(function (r) {
        var x = CDN.test(r.name) && r.name.match(/[?&]__vid=(\d+)/);
        return x ? x[1] : '';
      }).filter(Boolean);
      id = hits[hits.length - 1] || '';
    }
    return id;
  }
  // 优先选正在播放的，其次选屏幕上露出面积最大的
  var videos = [].slice.call(document.querySelectorAll('video'));
  videos.sort(function (a, b) {
    return (a.paused - b.paused) || (visibleArea(b) - visibleArea(a));
  });
  var v = videos[0];
  if (!v) {
    alert(NOT_FOUND);
    return;
  }
  // 推荐流现在用 MSE 播放，src 是 blob:，这时拿不到直链，url 留空，后面走作品详情接口
  var srcs = httpSources(v);
  var url = srcs.filter(function (u) { return CDN.test(u); })[0] || srcs[0] || '';
  // 手机分享页播放的是带水印的 /aweme/v1/playwm/，换成 /play/ 即为无水印原片
  url = url.replace('/aweme/v1/playwm/', '/aweme/v1/play/');

  var m = url.match(/[?&]__vid=(\d+)/) ||
    location.href.match(/[?&]modal_id=(\d+)/) ||
    location.href.match(/\/video\/(\d+)/);
  var id = m ? m[1] : idFromDom(v);

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

  function send(w) {
    var q = 'url=' + encodeURIComponent(url) + '&id=' + encodeURIComponent(id) +
      '&title=' + encodeURIComponent(title.slice(0, 120)) + '&author=' + encodeURIComponent(author.slice(0, 40)) +
      '&page=' + encodeURIComponent(location.origin + location.pathname);
    var target = NAS + '/add?' + q;
    if (w) w.location.href = target;
    else w = window.open(target, 'douyin_to_nas', 'width=460,height=360');
    // 弹窗被拦截（手机浏览器常见）时直接在当前页打开
    if (!w) location.href = target;
  }

  if (url) return send(null);
  if (!id) {
    alert(NOT_FOUND);
    return;
  }
  // 先同步打开空白弹窗，等接口返回后再跳转；否则异步之后再 window.open 会被当成广告弹窗拦截
  var w = window.open('', 'douyin_to_nas', 'width=460,height=360');
  fetch('/aweme/v1/web/aweme/detail/?device_platform=webapp&aid=6383&channel=channel_pc_web&aweme_id=' + id, { credentials: 'include' })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var d = j.aweme_detail || {};
      var list = (d.video && d.video.play_addr && d.video.play_addr.url_list) || [];
      url = list.filter(function (u) { return CDN.test(u); })[0] || list[0] || '';
      if (!url) throw new Error('no url');
      title = title || d.desc || '';
      author = author || (d.author && d.author.nickname) || '';
      send(w);
    })
    .catch(function () {
      if (w) w.close();
      alert('获取视频地址失败，请刷新页面后再试一次。');
    });
}
