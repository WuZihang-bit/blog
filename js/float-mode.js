/* ==========================================================================
   吴子航的博客 · 漂浮模式 v2
   --------------------------------------------------------------------------
   - 卡片像星体一样自由漂浮：缓慢漂移、轻微自转、边界软反弹、
     卡片之间弹性碰撞（圆形近似 + 法向冲量 + 恢复系数）
   - 鼠标是斥力场：光标靠近时卡片被推开
   - v2：卡片可以抓取拖拽，松手带惯性甩出；
     拖拽超过阈值时不算点击，只有轻点才会打开文章
   - 卡片更小、初始贴屏幕两侧分布，把中央让给太阳系背景
   ========================================================================== */

(function () {
  'use strict';

  var btn = document.getElementById('float-toggle');
  if (!btn) return;

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var cards = Array.prototype.slice.call(
    document.querySelectorAll('.post-item, .archive-list li')
  );
  if (REDUCED || cards.length === 0) {
    btn.style.display = 'none';
    return;
  }

  var bodies = [];
  var active = false;
  var raf = null;
  var pointer = { x: -9999, y: -9999 };
  var drag = null;      // { b, dx, dy, lx, ly, vx, vy, moved }
  var REPEL_R = 190;
  var MAX_SPEED = 2.6;
  var THROW_MAX = 9;

  function onMove(e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    if (drag) {
      drag.vx = e.clientX - drag.lx;
      drag.vy = e.clientY - drag.ly;
      drag.moved += Math.abs(e.clientX - drag.lx) + Math.abs(e.clientY - drag.ly);
      drag.lx = e.clientX;
      drag.ly = e.clientY;
      drag.b.x = e.clientX - drag.dx;
      drag.b.y = e.clientY - drag.dy;
    }
  }

  function onDown(e) {
    if (!active || drag) return;
    var el = e.target.closest ? e.target.closest('.post-item, .archive-list li') : null;
    if (!el) return;
    var b = null;
    for (var i = 0; i < bodies.length; i++) {
      if (bodies[i].card === el) { b = bodies[i]; break; }
    }
    if (!b) return;
    var r = el.getBoundingClientRect();
    drag = {
      b: b,
      dx: e.clientX - r.left,
      dy: e.clientY - r.top,
      lx: e.clientX,
      ly: e.clientY,
      vx: 0,
      vy: 0,
      moved: 0
    };
    b.dragging = true;
    b.card.style.zIndex = '7';
    document.body.style.cursor = 'grabbing';
    document.body.classList.add('no-select');
  }

  function onUp() {
    if (!drag) return;
    var b = drag.b;
    b.dragging = false;
    b.card.style.zIndex = '5';
    document.body.style.cursor = '';
    document.body.classList.remove('no-select');
    if (drag.moved > 8) {
      /* 拖拽过：惯性甩出，并吞掉随后的 click，避免误开文章 */
      b.vx = Math.max(-THROW_MAX, Math.min(THROW_MAX, drag.vx * 1.15));
      b.vy = Math.max(-THROW_MAX, Math.min(THROW_MAX, drag.vy * 1.15));
      b.suppressClick = true;
    }
    drag = null;
  }

  /* 捕获阶段的 click 守卫：拖拽刚结束的那一下点击不打开链接 */
  function clickGuard(e) {
    var el = e.target.closest ? e.target.closest('.post-item, .archive-list li') : null;
    if (!el) return;
    for (var i = 0; i < bodies.length; i++) {
      if (bodies[i].card === el && bodies[i].suppressClick) {
        bodies[i].suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    }
  }

  function enable() {
    active = true;
    document.body.classList.add('float-mode');
    btn.setAttribute('aria-pressed', 'true');
    document.body.setAttribute('data-float-hint', '');

    var W = window.innerWidth;
    var H = window.innerHeight;
    /* 更小的卡片，像「星体牌」 */
    var cardW = Math.min(310, Math.max(230, W * 0.28));

    bodies = cards.map(function (card) {
      card.style.position = 'fixed';
      card.style.left = '0';
      card.style.top = '0';
      card.style.width = cardW + 'px';
      card.style.zIndex = '5';
      card.style.margin = '0';
      card.addEventListener('click', clickGuard, true);
      return { card: card, w: cardW };
    });

    /* 初始贴两侧分布，中央留给太阳系 */
    bodies.forEach(function (b, i) {
      var rect = b.card.getBoundingClientRect();
      b.h = rect.height || 150;
      var leftSide = i % 2 === 0;
      b.x = leftSide
        ? 12 + Math.random() * 26
        : W - b.w - 12 - Math.random() * 26;
      b.y = 100 + (H - b.h - 140) * (i / Math.max(bodies.length - 1, 1)) + (Math.random() - 0.5) * 30;
      b.y = Math.max(96, Math.min(b.y, H - b.h - 14));
      b.vx = (Math.random() - 0.5) * 0.7;
      b.vy = (Math.random() - 0.5) * 0.7;
      b.rot = (Math.random() - 0.5) * 3;
      b.vr = (Math.random() - 0.5) * 0.05;
      b.dragging = false;
      b.suppressClick = false;
    });

    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerdown', onDown, { passive: true });
    window.addEventListener('pointerup', onUp, { passive: true });
    raf = requestAnimationFrame(tick);

    var r = btn.getBoundingClientRect();
    window.dispatchEvent(new CustomEvent('starburst', {
      detail: { x: r.left + r.width / 2, y: r.top + r.height / 2, scale: 1.2 }
    }));

    setTimeout(function () {
      document.body.removeAttribute('data-float-hint');
    }, 3600);
  }

  function disable() {
    active = false;
    cancelAnimationFrame(raf);
    document.body.classList.remove('float-mode');
    btn.setAttribute('aria-pressed', 'false');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointerup', onUp);
    bodies.forEach(function (b) {
      b.card.removeEventListener('click', clickGuard, true);
      b.card.style.position = '';
      b.card.style.left = '';
      b.card.style.top = '';
      b.card.style.width = '';
      b.card.style.zIndex = '';
      b.card.style.margin = '';
      b.card.style.transform = '';
    });
    bodies = [];
    drag = null;
    document.body.style.cursor = '';
  }

  function tick() {
    var W = window.innerWidth;
    var H = window.innerHeight;
    var TOP = 86;

    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i];

      if (b.dragging) {
        /* 拖拽中：位置由指针控制，仅做边界钳制与轻微回正 */
        b.x = Math.max(6, Math.min(b.x, W - b.w - 6));
        b.y = Math.max(TOP, Math.min(b.y, H - b.h - 8));
        b.rot *= 0.9;
        b.card.style.transform = 'translate(' + b.x.toFixed(1) + 'px,' +
          b.y.toFixed(1) + 'px) rotate(' + b.rot.toFixed(2) + 'deg)';
        continue;
      }

      /* 光标斥力 */
      var mcx = b.x + b.w / 2 - pointer.x;
      var mcy = b.y + b.h / 2 - pointer.y;
      var md2 = mcx * mcx + mcy * mcy;
      if (md2 > 1 && md2 < REPEL_R * REPEL_R) {
        var md = Math.sqrt(md2);
        var mf = (1 - md / REPEL_R) * 0.85;
        b.vx += (mcx / md) * mf;
        b.vy += (mcy / md) * mf;
      }

      b.x += b.vx;
      b.y += b.vy;
      b.vx *= 0.985;
      b.vy *= 0.985;
      var spd = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      if (spd > MAX_SPEED * 2.2) {
        /* 刚甩出时允许更快，随后自然衰减到限速以下 */
        b.vx = b.vx / spd * MAX_SPEED * 2.2;
        b.vy = b.vy / spd * MAX_SPEED * 2.2;
      }
      if (spd < 0.08) {
        b.vx += (Math.random() - 0.5) * 0.12;
        b.vy += (Math.random() - 0.5) * 0.12;
      }

      if (b.x < 10) { b.x = 10; b.vx = Math.abs(b.vx) * 0.8; }
      if (b.x + b.w > W - 10) { b.x = W - 10 - b.w; b.vx = -Math.abs(b.vx) * 0.8; }
      if (b.y < TOP) { b.y = TOP; b.vy = Math.abs(b.vy) * 0.8; }
      if (b.y + b.h > H - 12) { b.y = H - 12 - b.h; b.vy = -Math.abs(b.vy) * 0.8; }

      b.rot += b.vr;
      b.vr *= 0.99;
      b.rot *= 0.995;
      if (b.rot > 5) b.rot = 5;
      if (b.rot < -5) b.rot = -5;

      b.card.style.transform = 'translate(' + b.x.toFixed(1) + 'px,' +
        b.y.toFixed(1) + 'px) rotate(' + b.rot.toFixed(2) + 'deg)';
    }

    /* 两两碰撞：拖拽中的卡片视为不可推动的「重物」 */
    for (var a = 0; a < bodies.length - 1; a++) {
      for (var c = a + 1; c < bodies.length; c++) {
        var A = bodies[a];
        var B = bodies[c];
        var ra = Math.max(A.w, A.h) / 2 * 0.72;
        var rb = Math.max(B.w, B.h) / 2 * 0.72;
        var ax = A.x + A.w / 2, ay = A.y + A.h / 2;
        var bx = B.x + B.w / 2, by = B.y + B.h / 2;
        var dx = bx - ax, dy = by - ay;
        var d2 = dx * dx + dy * dy;
        var rSum = ra + rb;
        if (d2 > 0.01 && d2 < rSum * rSum) {
          var d = Math.sqrt(d2);
          var nx = dx / d, ny = dy / d;
          var overlap = rSum - d;
          var aFix = A.dragging ? 0 : (B.dragging ? 1 : 0.5);
          var bFix = 1 - aFix;
          A.x -= nx * overlap * aFix;
          A.y -= ny * overlap * aFix;
          B.x += nx * overlap * bFix;
          B.y += ny * overlap * bFix;

          var rvn = (B.vx - A.vx) * nx + (B.vy - A.vy) * ny;
          if (rvn < 0 && !A.dragging && !B.dragging) {
            var imp = -rvn * 0.75;
            A.vx -= nx * imp;
            A.vy -= ny * imp;
            B.vx += nx * imp;
            B.vy += ny * imp;
          }
        }
      }
    }

    raf = requestAnimationFrame(tick);
  }

  btn.addEventListener('click', function () {
    if (active) disable();
    else enable();
  });
})();
