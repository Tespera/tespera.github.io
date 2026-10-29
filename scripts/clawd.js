/**
 * Clawd — 在当前屏幕里的某条横线上随机出没的像素小螃蟹
 *
 * 找线：每次出场扫描视口内可见的横线（边框线 / hr / 图片和代码框的上边缘），
 *       找出线上方不压文字和图片的空白段，随机挑一条，从线下冒出来。
 * 表演：在空白段里随机做动作——走动、东张西望、敲笔记本、看书、举牌、跳舞……
 *       动作数据在 clawd-sprites.js（由 tools/clawd/build.mjs 生成），这里逐帧画到 canvas 上。
 * 互动：鼠标靠近时挥手或逃开（逃不开就钻回线下），被追急了会转晕；点它会蹦一下；
 *       待着不动时眼睛跟着鼠标转。
 * 退场：表演几轮后沉回线下；所站的线滚出屏幕或窗口宽度变化时提前退场。
 */
(function () {
  'use strict';

  var DATA = window.CLAWD_SPRITES;
  var horizon = document.querySelector('[data-clawd-horizon]');
  if (!DATA || !horizon) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  var canvas = horizon.querySelector('canvas');
  var ctx = canvas.getContext('2d');

  var GAP = 10;            // 与文字 / 图片保持的最小距离
  var MIN_LINE = 240;      // 太短的线不算地平线
  var RETRY_MS = 1500;     // 屏幕里没有合适的线时，隔多久再找
  var NEAR = 90;           // 鼠标进入这个距离算「靠近」
  var LOOK = 420;          // 鼠标在这个距离内，螃蟹的眼睛会跟着转
  var CRAB_PX = 24;        // 螃蟹站姿的像素宽度（含两只钳子）
  var MEDIA = 'img,svg,video,canvas,iframe,picture,input,textarea,select,button';
  // 没有边框、但上边缘也能当地平线的元素：图片、代码框
  var SURFACES = { IMG: 1, PRE: 1, VIDEO: 1 };
  var mobile = window.matchMedia('(max-width: 640px)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');

  // 一个像素放大几倍：目标是和原先视频里的螃蟹一样大（桌面约 42px 宽、手机约 30px），
  // 再按屏幕像素密度取整，让每个像素落在整数个物理像素上，保证像素画清晰
  function S() {
    var dpr = window.devicePixelRatio || 1;
    var target = mobile.matches ? 1.25 : 1.75;
    return Math.max(1, Math.floor(target * dpr + 0.25)) / dpr;
  }
  function rand(min, max) { return min + Math.random() * (max - min); }
  function pick(list) { return list[Math.floor(Math.random() * list.length)]; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // ── 可取消的令牌：一次出场一个（visit），出场里每个动作一个（act）──────────────────
  function Token(parent) {
    var t = { cancelled: false, fns: [], cancel: cancel, on: on };
    function cancel() {
      if (t.cancelled) return;
      t.cancelled = true;
      t.fns.splice(0).forEach(function (f) { f(); });
    }
    function on(f) { if (t.cancelled) f(); else t.fns.push(f); }
    if (parent) parent.on(cancel);
    return t;
  }

  function wait(ms, token) {
    return new Promise(function (r) {
      var id = setTimeout(r, ms);
      token.on(function () { clearTimeout(id); r(); });
    });
  }

  // ── 精灵：按需解码，每帧缓存成离屏 canvas ─────────────────────────────────────────
  var spriteCache = {};

  function sprite(name) {
    if (spriteCache[name]) return spriteCache[name];
    var src = DATA.sprites[name];
    var cur = Array.prototype.map.call(src.b, function (c) { return c === '.' ? 255 : parseInt(c, 36); });
    var frames = [Uint8Array.from(cur)];
    src.d.split('(').forEach(function (d) {
      if (d) d.split(',').forEach(function (tok) {
        var k = tok.length - 1;
        cur[parseInt(tok.slice(0, k), 36)] = tok[k] === '.' ? 255 : parseInt(tok[k], 36);
      });
      frames.push(Uint8Array.from(cur));
    });
    var rgb = src.p.map(function (h) { return [1, 3, 5].map(function (i) { return parseInt(h.slice(i, i + 2), 16); }); });
    return (spriteCache[name] = { name: name, w: src.w, h: src.h, ax: src.ax, ay: src.ay, noFlip: !!src.nf, fine: src.fine || null, frames: frames, rgb: rgb, images: [] });
  }

  function paint(w, h, pixels, rgb) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    var img = g.createImageData(w, h);
    for (var k = 0; k < pixels.length; k++) {
      if (pixels[k] === 255) continue;
      var p = rgb[pixels[k]];
      img.data[k * 4] = p[0]; img.data[k * 4 + 1] = p[1]; img.data[k * 4 + 2] = p[2]; img.data[k * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return c;
  }

  // 细像素图层（举牌的牌子）：像素约为螃蟹的一半大
  function fineImage(sp) {
    if (!sp.fineImage) {
      var px = Array.prototype.map.call(sp.fine.b, function (c) { return c === '.' ? 255 : parseInt(c, 36); });
      sp.fineImage = paint(sp.fine.w, sp.fine.h, px, sp.rgb);
    }
    return sp.fineImage;
  }

  function frameImage(sp, i) {
    return sp.images[i] || (sp.images[i] = paint(sp.w, sp.h, sp.frames[i], sp.rgb));
  }

  function animSprite(name) { return sprite(DATA.anims[name].sp); }

  // 正面朝向的动作（看书、举牌）不做镜像，否则牌子上的字会反过来
  function facingOf(sp, facing) { return sp.noFlip ? 1 : facing; }

  // 只转眼珠那套动作：算出每帧眼睛的偏移，用来让眼睛朝向鼠标（做法同 Clawd Quest）
  var eyeDirs = null;
  function eyeFrameToward(dx, dy) {
    var sp = sprite('LookingAroundEyesOnly');
    if (!eyeDirs) {
      var dark = 0;
      var lum = function (p) { return p[0] * 0.3 + p[1] * 0.6 + p[2] * 0.1; };
      sp.rgb.forEach(function (p, i) { if (lum(p) < lum(sp.rgb[dark])) dark = i; });
      var centers = sp.frames.map(function (f) {
        var sx = 0, sy = 0, n = 0;
        for (var k = 0; k < f.length; k++) if (f[k] === dark) { sx += k % sp.w; sy += (k / sp.w) | 0; n++; }
        return [sx / n, sy / n];
      });
      var seen = {};
      eyeDirs = [];
      centers.forEach(function (c, i) {
        var ex = Math.round(c[0] - centers[0][0]), ey = Math.round(c[1] - centers[0][1]);
        if (!seen[ex + ',' + ey]) { seen[ex + ',' + ey] = 1; eyeDirs.push({ dx: ex, dy: ey, f: i }); }
      });
    }
    var nx = Math.max(-1, Math.min(1, dx / 170)), ny = Math.max(-1, Math.min(1, dy / 150));
    ny = ny < 0 ? ny : ny * 2;
    var best = 0, bestD = Infinity;
    eyeDirs.forEach(function (e) {
      var d = (e.dx - nx) * (e.dx - nx) + (e.dy - ny) * (e.dy - ny);
      if (d < bestD) { bestD = d; best = e.f; }
    });
    return best;
  }

  // ── 角色状态与绘制 ────────────────────────────────────────────────────────────────
  var state = {
    anim: 'stand', f: 0, done: null, // done：当前单次动作播完时的回调
    x: 0, facing: 1, lift: 0,        // x：身体中心在地平线上的位置；lift：沉到线下的深度
    lifting: null,                   // 正在进行的升起 / 沉下
    move: null,                      // { to, speed, done }
    eyes: false,                     // 站着时眼睛是否跟随鼠标
  };
  // 空白段：宽度、整体可用高度上限，以及上方各个障碍物（相对空白段左端和地平线的位置）
  var span = { width: 0, ceiling: 0, above: [] };
  var pointer = { x: -1e4, y: -1e4, movedAt: 0 };
  var drawn = '';

  function setAnim(name) {
    var a = DATA.anims[name];
    if (state.done) { var d = state.done; state.done = null; d(); }
    state.anim = name;
    state.f = a.start;
  }

  // 播放一个动作：单次动作播完即返回；循环动作播 duration 毫秒后返回
  function play(name, token, duration) {
    setAnim(name);
    var a = DATA.anims[name];
    if (a.loop) return wait(duration || 3000, token);
    return new Promise(function (r) {
      state.done = r;
      token.on(function () { if (state.done === r) { state.done = null; r(); } });
    });
  }

  function crabCenter() {
    var r = horizon.getBoundingClientRect();
    return { x: r.left + state.x, y: r.bottom - 8 * S() };
  }

  function render() {
    var a = DATA.anims[state.anim];
    var sp = sprite(a.sp);
    var frame = Math.min(sp.frames.length - 1, state.f | 0);
    if (state.anim === 'stand' && state.eyes) {
      var c = crabCenter();
      sp = sprite('LookingAroundEyesOnly');
      frame = eyeFrameToward((pointer.x - c.x) * state.facing, pointer.y - c.y);
    }
    var s = S();
    var facing = facingOf(sp, state.facing);
    // 按屏幕物理像素绘制：每个精灵像素占 k 个物理像素（S() 已保证 k 为整数）
    var k = Math.round(s * (window.devicePixelRatio || 1));
    var key = sp.name + frame + '|' + facing + '|' + k;
    if (key !== drawn) {
      drawn = key;
      if (canvas.width !== sp.w * k || canvas.height !== sp.h * k) {
        canvas.width = sp.w * k; canvas.height = sp.h * k;
      }
      canvas.style.width = sp.w * s + 'px';
      canvas.style.height = sp.h * s + 'px';
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(facing < 0 ? -k : k, 0, 0, k, facing < 0 ? sp.w * k : 0, 0);
      ctx.drawImage(frameImage(sp, frame), 0, 0);
      if (sp.fine) {
        // pos：牌子底边中点，单位是半个精灵像素；牌子的像素约为螃蟹像素的一半，
        // 取整到物理像素，保证字的笔画清晰
        var pos = sp.fine.pos[frame], fp = k >= 2 ? Math.round(k / 2) : k / 2;
        var bw = sp.fine.w * fp, bh = sp.fine.h * fp;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.drawImage(fineImage(sp), Math.round(pos[0] * k / 2 - bw / 2), Math.round(pos[1] * k / 2) - bh, bw, bh);
      }
    }
    var anchorX = facing < 0 ? sp.w - sp.ax : sp.ax;
    var left = state.x - anchorX * s;
    var top = horizon.clientHeight - sp.ay * s + state.lift;
    canvas.style.transform = 'translate(' + left.toFixed(1) + 'px,' + top.toFixed(1) + 'px)';
  }

  // 当前这一帧螃蟹实际像素占的区域（视口坐标），用于点击判定
  function crabBox() {
    var sp = animSprite(state.anim);
    var f = sp.frames[Math.min(sp.frames.length - 1, state.f | 0)];
    var x0 = sp.w, x1 = -1, y0 = sp.h, y1 = -1;
    for (var k = 0; k < f.length; k++) if (f[k] !== 255) {
      var x = k % sp.w, y = (k / sp.w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    var r = canvas.getBoundingClientRect(), s = S();
    if (facingOf(sp, state.facing) < 0) { var t = x0; x0 = sp.w - 1 - x1; x1 = sp.w - 1 - t; }
    return { left: r.left + x0 * s, right: r.left + (x1 + 1) * s, top: r.top + y0 * s, bottom: r.top + (y1 + 1) * s };
  }

  var running = false, last = 0;
  function tick(now) {
    if (!running) return;
    var dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;

    var a = DATA.anims[state.anim];
    state.f += a.fps * dt;
    if (a.loop) {
      var n = a.loop[1] - a.loop[0] + 1;
      if (state.f >= a.loop[1] + 1) state.f = a.loop[0] + ((state.f - a.loop[0]) % n);
    } else if (state.f >= a.end + 1) {
      state.f = a.end;
      if (state.done) { var d = state.done; state.done = null; d(); }
    }

    if (state.move) {
      var m = state.move;
      var step = m.speed * dt * (m.to > state.x ? 1 : -1);
      if (Math.abs(m.to - state.x) <= Math.abs(step)) { state.x = m.to; m.done(); }
      else state.x += step;
    }

    if (state.lifting) state.lifting(now);
    if (visit) follow(visit);
    if (finePointer.matches) watchPointer();
    render();
    requestAnimationFrame(tick);
  }

  function start() {
    if (running) return;
    running = true;
    last = performance.now();
    requestAnimationFrame(tick);
  }
  function stop() { running = false; }

  // ── 基本动作：升起 / 沉下 / 走到某处 ──────────────────────────────────────────────
  function liftTo(target, ms, ease, token) {
    var from = state.lift, t0 = performance.now();
    return new Promise(function (r) {
      var finished = false;
      function done() {
        if (finished) return;
        finished = true;
        state.lifting = null;
        state.lift = target;
        r();
      }
      state.lifting = function (now) {
        var p = Math.min(1, (now - t0) / ms);
        state.lift = from + (target - from) * ease(p);
        if (p >= 1) done();
      };
      token.on(done);
    });
  }
  function depth() { return 20 * S() + 4; }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function easeIn(p) { return p * p * p; }
  function rise(token) { setAnim('stand'); return liftTo(0, 450, easeOut, token); }
  function sink(token) { setAnim('stand'); state.eyes = false; return liftTo(depth(), 350, easeIn, token); }

  // 移动方式与速度（像素/秒，再乘放大倍数）：走、横着爬、跑
  var GAITS = { walk: 20, crabWalk: 24, run: 60 };

  function moveTo(target, gait, token) {
    target = Math.max(minX(), Math.min(maxX(), target));
    if (Math.abs(target - state.x) < 4) return Promise.resolve();
    // 横着爬时不一定面朝前进方向，更像螃蟹
    if (gait !== 'crabWalk' || Math.random() < 0.5) state.facing = target > state.x ? 1 : -1;
    setAnim(gait);
    return new Promise(function (r) {
      var finished = false;
      function done() {
        if (finished) return;
        finished = true;
        state.move = null;
        setAnim('stand');
        r();
      }
      state.move = { to: target, speed: GAITS[gait] * S(), done: done };
      token.on(done);
    });
  }

  // 螃蟹身体中心可活动的范围（保证站姿完整地落在空白段里）
  function minX() { return CRAB_PX / 2 * S(); }
  function maxX() { return Math.max(minX(), span.width - CRAB_PX / 2 * S()); }

  // 某个动作在当前位置、给定朝向下放不放得下（宽的往两侧伸、高的往上伸）
  function fits(animName, facing) {
    var sp = animSprite(animName), s = S();
    facing = facingOf(sp, facing);
    var left = (facing < 0 ? sp.w - sp.ax : sp.ax) * s;
    var right = (facing < 0 ? sp.ax : sp.w - sp.ax) * s;
    var from = state.x - left, to = state.x + right;
    return from >= -2 && to <= span.width + 2 && sp.ay * s <= headroomAt(from, to);
  }

  // 空白段里 [from, to] 这一截的正上方还有多高的空间
  function headroomAt(from, to) {
    var room = span.ceiling;
    span.above.forEach(function (o) {
      if (o.right > from && o.left < to) room = Math.min(room, o.gap);
    });
    return room;
  }

  // 放得下就按需转身，返回能否表演
  function prepare(animName) {
    if (fits(animName, state.facing)) return true;
    if (fits(animName, -state.facing)) { state.facing = -state.facing; return true; }
    return false;
  }

  // ── 表演节目单 ────────────────────────────────────────────────────────────────────
  function oneShot(name) {
    return { need: name, run: function (t) { return play(name, t); } };
  }
  function session(name, outName, minMs, maxMs) {
    return {
      need: name,
      run: async function (t) {
        await play(name, t, rand(minMs, maxMs));
        // 被打断时也把道具收好（合上电脑、放下书）再去做别的
        if (outName) await play(outName, Token());
      },
    };
  }
  var stroll = {
    run: function (t) {
      var room = maxX() - minX();
      if (room < 40) return play('lookAround', t);
      var target;
      do { target = rand(minX(), maxX()); } while (Math.abs(target - state.x) < Math.min(70, room / 2));
      return moveTo(target, Math.random() < 0.6 ? 'walk' : 'crabWalk', t);
    },
  };

  var PROGRAM = [
    [stroll, 5],
    [oneShot('lookAround'), 3],
    [session('laptop', 'laptopOut', 3000, 6000), 3],
    [session('read', 'readOut', 4500, 7000), 3],
    [session('sign', 'signOut', 2500, 4000), 2],
    [session('desktop', 'desktopOut', 3000, 5500), 1],
    [session('hula', null, 2000, 3500), 1],
    [oneShot('sway'), 1.5],
    [oneShot('turning'), 1],
    [oneShot('point'), 1],
    [oneShot('dance'), 1],
    [oneShot('meditate'), 1],
    [oneShot('thinking'), 1],
    [oneShot('lightbulb'), 1],
    [oneShot('excited'), 0.5],
    [oneShot('hop'), 0.5],
    [oneShot('wave'), 0.5],
  ];

  // 空白段里离当前位置最近、能放下某个动作的位置；放不下返回 null
  function placeFor(animName) {
    var here = state.x, best = null;
    for (var x = minX(); x <= maxX(); x += 6) {
      state.x = x;
      if ((fits(animName, 1) || fits(animName, -1)) && (best === null || Math.abs(x - here) < Math.abs(best - here))) best = x;
    }
    state.x = here;
    return best;
  }

  // 按权重抽下一个节目；当前位置放不下的，先走到放得下的地方再表演
  function choose(lastItem) {
    var options = [];
    PROGRAM.forEach(function (p) {
      if (p[0] === lastItem) return;
      if (!p[0].need) { options.push([p[0], p[1], null]); return; }
      var x = placeFor(p[0].need);
      if (x !== null) options.push([p[0], p[1], x]);
    });
    var total = options.reduce(function (sum, p) { return sum + p[1]; }, 0);
    var r = Math.random() * total;
    for (var i = 0; i < options.length; i++) {
      r -= options[i][1];
      if (r <= 0) return { item: options[i][0], at: options[i][2] };
    }
    return { item: stroll, at: null };
  }

  // ── 鼠标互动 ──────────────────────────────────────────────────────────────────────
  var visit = null;      // 当前这次出场
  var act = null;        // 当前正在表演的动作
  var reaction = null;   // 待处理的互动反应
  var calmUntil = 0;     // 互动冷却：这之前鼠标靠近不再触发
  var chases = [];       // 最近几次被追的时间，追得太勤会转晕

  function watchPointer() {
    if (!visit || state.lift > 1) return;
    var c = crabCenter();
    var dx = pointer.x - c.x, dy = pointer.y - c.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    state.eyes = dist < LOOK;
    // 只有鼠标在动、主动凑过来才算靠近；滚动页面把螃蟹带到静止的鼠标底下不算
    var now = performance.now();
    if (!reaction && dist < NEAR && now - pointer.movedAt < 300 && now >= calmUntil) trigger(Math.random() < 0.5 ? 'wave' : 'flee');
  }

  function trigger(kind) {
    reaction = kind;
    if (act) act.cancel();
  }

  async function react(v) {
    var kind = reaction;
    var t = act = Token(v);
    var c = crabCenter();
    var away = pointer.x < c.x ? 1 : -1;

    if (kind === 'wave') {
      state.facing = -away;
      if (prepare('wave')) await play('wave', t);
      setAnim('stand');
      await wait(700, t);
    } else if (kind === 'flee') {
      var now = performance.now();
      chases = chases.filter(function (x) { return now - x < 12000; }).concat(now);
      var room = away > 0 ? maxX() - state.x : state.x - minX();
      if (room > 60) {
        await moveTo(state.x + away * Math.min(room, rand(40, 80) * S()), 'run', t);
        if (chases.length >= 3 && prepare('dizzy')) { chases = []; await play('dizzy', t); }
        else { state.facing = -away; setAnim('stand'); await wait(600, t); }
      } else {
        // 退无可退：钻回线下，等一会儿从另一头冒出来
        await sink(t);
        await wait(rand(1200, 2500), t);
        var third = (maxX() - minX()) / 3;
        state.x = away > 0 ? rand(minX(), minX() + third) : rand(maxX() - third, maxX());
        state.facing = Math.random() < 0.5 ? 1 : -1;
        await rise(Token(v));
      }
    } else if (kind === 'poke') {
      var options = ['hop', 'excited', 'confetti', 'dance'].filter(prepare);
      if (options.length) await play(pick(options), t);
      setAnim('stand');
    }
    calmUntil = performance.now() + 2500;
    // 反应途中被点了一下：保留新的反应，交给下一轮处理
    if (reaction === kind) reaction = null;
  }

  document.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'mouse') return;
    pointer.x = e.clientX; pointer.y = e.clientY;
    pointer.movedAt = performance.now();
  }, { passive: true });

  document.addEventListener('pointerdown', function (e) {
    // 点击优先于其他反应：追上逃跑的螃蟹点一下，它会蹦起来
    if (!visit || reaction === 'poke' || state.lift > 1) return;
    var b = crabBox();
    if (e.clientX >= b.left - 6 && e.clientX <= b.right + 6 && e.clientY >= b.top - 6 && e.clientY <= b.bottom + 6) trigger('poke');
  }, { passive: true });

  // ── 找线 ──────────────────────────────────────────────────────────────────────────
  // 是否属于固定 / 粘性定位的浮层（页头、折叠菜单、弹窗等），这些不算页面里的线和障碍
  function isPinned(el, cache) {
    if (!el || el === document.body) return false;
    if (cache.has(el)) return cache.get(el);
    var pos = getComputedStyle(el).position;
    var pinned = pos === 'fixed' || pos === 'sticky' || isPinned(el.parentElement, cache);
    cache.set(el, pinned);
    return pinned;
  }

  function topObstruction() {
    // 固定 / 粘性定位的页头会盖住视口上沿，线要在它下面
    var bottom = 0;
    Array.prototype.forEach.call(document.body.children, function (el) {
      var pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') return;
      var r = el.getBoundingClientRect();
      if (r.top <= 1 && r.width > window.innerWidth / 2) bottom = Math.max(bottom, r.bottom);
    });
    return bottom;
  }

  // 视口内所有横线：{ el, edge: 'top' | 'bottom', y, left, right }
  function findLines(viewTop, viewBottom) {
    var lines = [];
    var all = document.body.getElementsByTagName('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (horizon.contains(el)) continue;
      var r = el.getBoundingClientRect();
      if (r.width < MIN_LINE || r.bottom < viewTop || r.top > viewBottom) continue;
      var s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.opacity === '0') continue;
      var bt = parseFloat(s.borderTopWidth), bb = parseFloat(s.borderBottomWidth);
      if (el.tagName === 'HR' || SURFACES[el.tagName] || (bt > 0 && s.borderTopStyle !== 'none')) {
        lines.push({ el: el, edge: 'top', border: 0, y: r.top, left: r.left, right: r.right });
      }
      if (bb > 0 && s.borderBottomStyle !== 'none') {
        lines.push({ el: el, edge: 'bottom', border: bb, y: r.bottom - bb, left: r.left, right: r.right });
      }
    }
    var pinned = new Map();
    return lines.filter(function (l) { return !isPinned(l.el, pinned); });
  }

  // 视口内会被螃蟹挡住的东西：文字行 + 图片等
  function collectObstacles(viewTop, viewBottom) {
    var rects = [];
    var pinned = new Map();
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
        if (isPinned(p, pinned)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var range = document.createRange();
    for (var n; (n = walker.nextNode());) {
      range.selectNodeContents(n);
      Array.prototype.forEach.call(range.getClientRects(), keep);
    }
    document.querySelectorAll(MEDIA).forEach(function (el) {
      if (!horizon.contains(el) && !isPinned(el, pinned)) keep(el.getBoundingClientRect());
    });
    return rects;
  }

  // 一条线上方能让螃蟹站立的最长空白段，以及这一段上方还有多高的空间
  function freeSpan(line, obstacles, ceilingTop) {
    var s = S();
    var bandTop = line.y - 16 * s - GAP;
    var blocked = [];
    obstacles.forEach(function (r) {
      if (r.bottom > bandTop && r.top < line.y - 1) blocked.push([r.left - GAP, r.right + GAP]);
    });
    blocked.sort(function (a, b) { return a[0] - b[0]; });
    var best = null, cursor = line.left;
    blocked.concat([[line.right, line.right]]).forEach(function (b) {
      var from = Math.max(cursor, line.left), to = Math.min(b[0], line.right);
      if (to - from > (best ? best.to - best.from : 0)) best = { from: from, to: to };
      cursor = Math.max(cursor, b[1]);
    });
    if (!best || best.to - best.from < CRAB_PX * s * 1.6) return null;
    best.ceiling = line.y - ceilingTop;
    best.above = [];
    obstacles.forEach(function (r) {
      if (r.right > best.from && r.left < best.to && r.bottom <= bandTop + 1) {
        best.above.push({ left: r.left - GAP - best.from, right: r.right + GAP - best.from, gap: line.y - r.bottom - GAP });
      }
    });
    return best;
  }

  function pickSpot() {
    var s = S();
    var top = topObstruction();
    var viewTop = top + 18 * s;
    var viewBottom = window.innerHeight - 8;
    var lines = findLines(viewTop, viewBottom).filter(function (l) {
      return l.y >= viewTop && l.y <= viewBottom;
    });
    if (!lines.length) return null;
    var obstacles = collectObstacles(top, viewBottom);
    var spots = [];
    lines.forEach(function (l) {
      var sp = freeSpan(l, obstacles, top);
      if (sp) spots.push({ line: l, span: sp });
    });
    return spots.length ? pick(spots) : null;
  }

  var tallest = 0;
  function place(spot) {
    if (!tallest) Object.keys(DATA.sprites).forEach(function (k) { tallest = Math.max(tallest, DATA.sprites[k].ay); });
    var h = tallest * S() + 4;
    var base = (horizon.offsetParent || document.documentElement).getBoundingClientRect();
    span.width = spot.span.to - spot.span.from;
    span.ceiling = spot.span.ceiling;
    span.above = spot.span.above;
    horizon.style.top = (spot.line.y - h - base.top) + 'px';
    horizon.style.left = (spot.span.from - base.left) + 'px';
    horizon.style.width = span.width + 'px';
    horizon.style.height = h + 'px';
    horizon.hidden = false;
  }

  // 线在整个页面里的位置（不受滚动影响）
  function linePageXY(line) {
    var r = line.el.getBoundingClientRect();
    var y = line.edge === 'top' ? r.top : r.bottom - line.border;
    return { x: r.left + window.scrollX, y: y + window.scrollY, ok: r.width > 0 };
  }

  // 排版在螃蟹出场期间变化（图片加载、字体替换等）时，跟着线走；每帧检查一次
  function follow(v) {
    var p = linePageXY(v.spot.line);
    if (!p.ok) return;
    var dx = p.x - v.lineAt.x, dy = p.y - v.lineAt.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    v.lineAt = p;
    horizon.style.left = (parseFloat(horizon.style.left) + dx) + 'px';
    horizon.style.top = (parseFloat(horizon.style.top) + dy) + 'px';
  }

  // ── 一次出场 ──────────────────────────────────────────────────────────────────────
  async function appear(spot) {
    var v = visit = Token();
    v.spot = spot;
    place(spot);
    v.lineAt = linePageXY(spot.line);
    state.x = rand(minX(), maxX());
    state.facing = Math.random() < 0.5 ? 1 : -1;
    state.lift = depth();
    state.eyes = false;
    drawn = '';
    setAnim('stand');
    start();

    await rise(v);
    if (!v.cancelled && Math.random() < 0.4 && prepare('hop')) await play('hop', Token(v));

    var acts = Math.floor(rand(3, 6)), lastItem = null;
    while (acts > 0 && !v.cancelled) {
      if (reaction) { await react(v); continue; }
      var t = act = Token(v);
      setAnim('stand');
      await wait(rand(300, 900), t);
      if (t.cancelled) continue;
      var next = choose(lastItem), item = next.item;
      lastItem = item;
      if (next.at !== null && Math.abs(next.at - state.x) > 3) await moveTo(next.at, 'walk', t);
      if (t.cancelled) continue;
      if (!item.need || prepare(item.need)) await item.run(t);
      acts--;
    }

    if (!v.cancelled) {
      var bye = Token(v);
      if (Math.random() < 0.35 && prepare('wave')) await play('wave', bye);
      await sink(bye);
    }
    stop();
    horizon.hidden = true;
    if (visit === v) visit = null;
    act = null;
    reaction = null;
  }

  function cancelVisit() {
    if (visit) visit.cancel();
  }

  async function live() {
    await sleep(rand(1200, 3000));
    for (;;) {
      if (document.hidden) { await sleep(RETRY_MS); continue; }
      var spot = pickSpot();
      if (!spot) { await sleep(RETRY_MS); continue; }
      await appear(spot);
      await sleep(rand(4000, 12000));
    }
  }

  // 所站的线滚出屏幕 → 提前退场
  new IntersectionObserver(function (entries) {
    if (!entries[0].isIntersecting && !horizon.hidden) cancelVisit();
  }).observe(horizon);

  var lastWidth = window.innerWidth;
  window.addEventListener('resize', function () {
    if (window.innerWidth !== lastWidth) { lastWidth = window.innerWidth; cancelVisit(); }
  });

  live();
})();
