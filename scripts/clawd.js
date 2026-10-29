/**
 * Clawd — 在当前屏幕里的某条横线上随机出没的像素小螃蟹
 *
 * 每次出场：扫描视口内可见的横线（边框线 / hr），找出线上方不压文字和图片的空白段，
 * 随机挑一条，从线下冒出 → 若干次「原地敲键盘 / 走到别处」 → 沉回线下。
 * 螃蟹跟着页面滚动；所站的线滚出屏幕或窗口尺寸变化时提前退场，下次在新屏幕里重新找线。
 * 标签页在后台时暂停。
 */
(function () {
  'use strict';

  var horizon = document.querySelector('[data-clawd-horizon]');
  if (!horizon) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var crab = horizon.querySelector('.clawd');
  var video = horizon.querySelector('video');

  var VIDEO_RATIO = 1850 / 2750;
  // 螃蟹在视频画面里实际占据的区域（逐帧测得的包围盒），用来判断会不会压到内容
  var SPRITE = { left: 0.265, right: 0.89, top: 0.38 };
  var GAP = 10;          // 与文字 / 图片保持的最小距离
  var MIN_LINE = 240;    // 太短的线不算地平线
  var WALK_SPEED = 45;   // px/s
  var RISE_MS = 600;
  var RETRY_MS = 1500;   // 屏幕里没有合适的线时，隔多久再找

  var MEDIA = 'img,svg,video,canvas,iframe,picture,input,textarea,select,button';

  var visit = null;      // 当前这次出场；退场时置空
  var x = 0;
  var spanWidth = 0;

  function rand(min, max) { return min + Math.random() * (max - min); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 可被打断的等待：本次出场被取消时立刻结束
  function wait(v, ms) {
    return new Promise(function (r) {
      var t = setTimeout(done, ms);
      v.onCancel.push(done);
      function done() { clearTimeout(t); r(); }
    });
  }

  function whenVisible() {
    if (!document.hidden) return Promise.resolve();
    return new Promise(function (r) {
      document.addEventListener('visibilitychange', function on() {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', on);
        r();
      });
    });
  }

  function crabWidth() { return crab.offsetWidth; }

  function topObstruction() {
    // 固定 / 粘性定位的页头会盖住视口上沿，线要在它下面
    var bottom = 0;
    document.querySelectorAll('body > *').forEach(function (el) {
      var pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      var r = el.getBoundingClientRect();
      if (r.top <= 1 && r.width > window.innerWidth / 2) bottom = Math.max(bottom, r.bottom);
    });
    return bottom;
  }

  function isPinned(el) {
    for (; el && el !== document.body; el = el.parentElement) {
      var pos = getComputedStyle(el).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    return false;
  }

  // 视口内所有横线：{ el, edge: 'top' | 'bottom', y, left, right }
  function findLines(viewTop, viewBottom) {
    var lines = [];
    var all = document.body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === horizon || horizon.contains(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < MIN_LINE || r.bottom < viewTop || r.top > viewBottom) continue;
      var s = getComputedStyle(el);
      if (s.visibility === 'hidden') continue;
      var bt = parseFloat(s.borderTopWidth), bb = parseFloat(s.borderBottomWidth);
      if (el.tagName === 'HR' || (bt > 0 && s.borderTopStyle !== 'none')) {
        lines.push({ el: el, edge: 'top', y: r.top, left: r.left, right: r.right });
      }
      if (bb > 0 && s.borderBottomStyle !== 'none') {
        lines.push({ el: el, edge: 'bottom', y: r.bottom - bb, left: r.left, right: r.right });
      }
    }
    return lines.filter(function (l) { return !isPinned(l.el); });
  }

  // 视口内会被螃蟹挡住的东西：文字行 + 图片等
  function collectObstacles(viewTop, viewBottom) {
    var rects = [];
    function keep(r) {
      if (r.width && r.height && r.bottom > viewTop && r.top < viewBottom) rects.push(r);
    }
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var p = n.parentElement;
        if (!p || horizon.contains(p)) return NodeFilter.FILTER_REJECT;
        var pr = p.getBoundingClientRect();
        if (pr.bottom < viewTop || pr.top > viewBottom) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var range = document.createRange();
    for (var n; (n = walker.nextNode());) {
      range.selectNodeContents(n);
      Array.prototype.forEach.call(range.getClientRects(), keep);
    }
    document.querySelectorAll(MEDIA).forEach(function (el) {
      if (!horizon.contains(el)) keep(el.getBoundingClientRect());
    });
    return rects;
  }

  // 一条线上方能让螃蟹站立的最长空白段
  function freeSpan(line, obstacles, w) {
    var h = w * VIDEO_RATIO;
    var bandTop = line.y - h * (1 - SPRITE.top) - GAP;
    var blocked = [];
    obstacles.forEach(function (r) {
      if (r.bottom > bandTop && r.top < line.y - 1) blocked.push([r.left - GAP, r.right + GAP]);
    });
    blocked.sort(function (a, b) { return a[0] - b[0]; });
    // 螃蟹画面左右两侧是透明的，允许这部分越过空白段
    var padL = w * SPRITE.left, padR = w * (1 - SPRITE.right);
    var best = null, cursor = line.left;
    blocked.concat([[line.right, line.right]]).forEach(function (b) {
      var from = Math.max(cursor, line.left), to = Math.min(b[0], line.right);
      if (to - from > (best ? best.to - best.from : 0)) best = { from: from, to: to };
      cursor = Math.max(cursor, b[1]);
    });
    if (!best) return null;
    best.from -= padL;
    best.to += padR;
    return best.to - best.from >= w * 1.6 ? best : null;
  }

  function pickSpot() {
    var w = crabWidth();
    var h = w * VIDEO_RATIO;
    var viewTop = topObstruction() + h;
    var viewBottom = window.innerHeight - 8;
    var lines = findLines(viewTop, viewBottom).filter(function (l) {
      return l.y >= viewTop && l.y <= viewBottom;
    });
    if (!lines.length) return null;
    var obstacles = collectObstacles(viewTop - h, viewBottom);
    var spots = [];
    lines.forEach(function (l) {
      var span = freeSpan(l, obstacles, w);
      if (span) spots.push({ line: l, span: span });
    });
    return spots.length ? spots[Math.floor(Math.random() * spots.length)] : null;
  }

  function place(spot) {
    var w = crabWidth();
    var h = Math.ceil(w * VIDEO_RATIO);
    var base = (horizon.offsetParent || document.documentElement).getBoundingClientRect();
    spanWidth = spot.span.to - spot.span.from;
    horizon.style.top = (spot.line.y - h - base.top) + 'px';
    horizon.style.left = (spot.span.from - base.left) + 'px';
    horizon.style.width = spanWidth + 'px';
    horizon.style.height = h + 'px';
    horizon.hidden = false;
  }

  // 布局在螃蟹出场期间有变化（图片加载、字体替换等）时，跟着线走
  function follow(v) {
    var r = v.spot.line.el.getBoundingClientRect();
    if (!r.width) return;
    var dy = (v.spot.line.edge === 'top' ? r.top : r.bottom - parseFloat(getComputedStyle(v.spot.line.el).borderBottomWidth)) - v.lineY;
    if (Math.abs(dy) < 0.5) return;
    v.lineY += dy;
    horizon.style.top = (parseFloat(horizon.style.top) + dy) + 'px';
  }

  function setX(value, durationMs) {
    x = value;
    crab.style.transition = durationMs ? 'transform ' + durationMs + 'ms linear' : 'none';
    crab.style.setProperty('--clawd-x', value + 'px');
  }

  function face(dir) { crab.style.setProperty('--clawd-facing', dir); }

  function play() {
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  function cancel() {
    if (!visit) return;
    var v = visit;
    visit = null;
    v.cancelled = true;
    v.onCancel.forEach(function (f) { f(); });
  }

  async function walk(v) {
    var limit = spanWidth - crabWidth();
    if (limit < 60) return wait(v, rand(2500, 6000));
    var target;
    do { target = rand(0, limit); } while (Math.abs(target - x) < Math.min(80, limit / 2));
    var duration = Math.abs(target - x) / WALK_SPEED * 1000;
    face(target > x ? 1 : -1);
    crab.classList.add('is-walking');
    setX(target, duration);
    await wait(v, duration);
    crab.classList.remove('is-walking');
  }

  async function appear(spot) {
    var v = visit = { spot: spot, lineY: spot.line.y, cancelled: false, onCancel: [] };
    place(spot);
    setX(rand(0, Math.max(0, spanWidth - crabWidth())), 0);
    face(Math.random() < 0.5 ? -1 : 1);
    if (video.preload === 'none') video.preload = 'auto';
    play();
    crab.classList.remove('is-sinking');
    // 先让初始位置生效，再加 is-up，升起动画才会播放
    void crab.offsetWidth;
    crab.classList.add('is-up');
    await wait(v, RISE_MS);

    var acts = Math.floor(rand(2, 5));
    for (var i = 0; i < acts && !v.cancelled; i++) {
      follow(v);
      await (Math.random() < 0.5 ? walk(v) : wait(v, rand(2500, 6000)));
    }

    crab.classList.remove('is-walking');
    if (v.cancelled) {
      // 线已经不在屏幕里了，直接收起，不必播退场动画
      crab.classList.remove('is-up');
      horizon.hidden = true;
      video.pause();
      return;
    }
    crab.classList.add('is-sinking');
    crab.classList.remove('is-up');
    await sleep(RISE_MS);
    horizon.hidden = true;
    video.pause();
    visit = null;
  }

  async function live() {
    await sleep(rand(1200, 3000));
    for (;;) {
      await whenVisible();
      var spot = pickSpot();
      if (!spot) { await sleep(RETRY_MS); continue; }
      await appear(spot);
      await sleep(rand(4000, 12000));
    }
  }

  // 所站的线滚出屏幕 → 提前退场
  new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting) cancel();
  }).observe(horizon);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) video.pause();
    else if (visit) play();
  });

  var lastWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; cancel(); }
  });

  live();
})();
