/* ==========================================================================
   吴子航的博客 · 星海粒子背景引擎 v5「真实太阳系」
   --------------------------------------------------------------------------
   v5 新增：
   - 行星真实质感：程序化纹理（条纹/海陆云/极冠/陨石坑/大气）、
     朝向太阳的昼夜晨昏线、镜面高光、大气边缘光、土星多环带卡西尼缝
   - 行星可抓取：按住行星拖走，松手弹性甩回轨道（快速点按仍是加速）
   - 双击空白处：曲速爆发（大星尘 + 多层冲击波 + 现场生成流星）

   v4 及更早：太阳系 Orrery、星场/星座连线/流星、视差景深、滚动星风、
   光标斥力/引力线/轨迹星屑、点击星尘、主题切换涟漪（starburst 事件）
   ========================================================================== */

(function () {
  'use strict';

  var CONFIG = {
    density: 10000,
    maxStars: 170,
    minStars: 50,
    linkDist: 120,
    repelRadius: 140,
    tetherRadius: 200,
    parallax: 26,
    cometEvery: [6000, 14000],
    burstSparks: 30,
    maxSparks: 140
  };

  var canvas = document.getElementById('bg-canvas');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* 太阳系只在首页登场；内容页以文章为主角，背景更安静 */
  var IS_HOME = /(^|\/)(index\.html)?$/i.test(location.pathname);
  if (!IS_HOME) document.body.classList.add('content-page');

  var W = 0;
  var H = 0;
  var stars = [];
  var sparks = [];
  var rings = [];
  var comets = [];
  var nextCometAt = 0;
  var pointer = { x: -9999, y: -9999, on: false };
  var par = { x: 0, y: 0 };
  var parT = { x: 0, y: 0 };
  var wind = 0;
  var lastScrollY = window.scrollY || 0;
  var lastTrail = { x: -9999, y: -9999 };
  var raf = null;
  var running = false;
  var resizeTimer = null;

  function isDark() {
    return document.documentElement.dataset.theme === 'dark';
  }

  function themeColors() {
    if (isDark()) {
      return {
        star: ['255,255,255', '147,197,253', '103,232,249', '196,181,253'],
        starBoost: 1,
        starScale: 1,
        twinkleLow: 0.65,
        line: '125,211,252',
        lineA: 0.15,
        tether: '103,232,249',
        tetherA: 0.45,
        glow: 'rgba(103,232,249,0.10)',
        orb: '147,197,253',
        spark: ['165,243,252', '147,197,253', '196,181,253', '255,255,255'],
        ring: '103,232,249',
        comet: '165,243,252',
        additive: true,
        orbitA: 0.10,
        label: '165,243,252'
      };
    }
    return {
      star: ['37,99,235', '79,70,229', '8,145,219', '124,58,237'],
      starBoost: 1.15,
      starScale: 1.2,
      twinkleLow: 0.7,
      line: '79,70,229',
      lineA: 0.16,
      tether: '8,145,219',
      tetherA: 0.5,
      glow: 'rgba(37,99,235,0.10)',
      orb: '79,70,229',
      spark: ['79,70,229', '6,182,212', '124,58,237', '37,99,235'],
      ring: '79,70,229',
      comet: '79,70,229',
      additive: false,
      orbitA: 0.14,
      label: '67,56,202'
    };
  }

  /* ======================================================================
     太阳系（Orrery）—— 程序化真实质感
     ====================================================================== */

  var FLATTEN = 0.38;
  var DEPTH_SCALE = 0.35;

  var PLANETS = [
    { name: '水星',   en: 'MERCURY', tex: 'rocky', r: 3.2, dist: 46,  speed: 2.4,  phase: 1.2 },
    { name: '金星',   en: 'VENUS',   tex: 'venus', r: 4.6, dist: 64,  speed: 1.75, phase: 3.9 },
    { name: '地球',   en: 'EARTH',   tex: 'earth', r: 5.0, dist: 86,  speed: 1.4,  phase: 0.4, moon: true, atmo: '120,180,255' },
    { name: '火星',   en: 'MARS',    tex: 'mars',  r: 3.8, dist: 110, speed: 1.1,  phase: 5.2, atmo: '255,150,110' },
    { name: '木星',   en: 'JUPITER', tex: 'jup',   r: 13,  dist: 152, speed: 0.6,  phase: 2.1 },
    { name: '土星',   en: 'SATURN',  tex: 'sat',   r: 11,  dist: 195, speed: 0.48, phase: 4.4, ring: true, atmo: '240,220,160' },
    { name: '天王星', en: 'URANUS',  tex: 'ura',   r: 7,   dist: 232, speed: 0.4,  phase: 0.9, atmo: '160,230,240' },
    { name: '海王星', en: 'NEPTUNE', tex: 'nep',   r: 6.8, dist: 262, speed: 0.33, phase: 2.8, atmo: '120,150,255' }
  ];

  for (var pi = 0; pi < PLANETS.length; pi++) {
    var P0 = PLANETS[pi];
    P0.angle = P0.phase;
    P0.kick = 0;
    P0.sx = 0;
    P0.sy = 0;
    P0.sr = 0;
    P0.offX = 0;
    P0.offY = 0;
    P0.ovX = 0;
    P0.ovY = 0;
  }

  var moonAngle = 0;
  var sunPulse = 0;
  var solarHover = null;
  var grab = null;   // { idx, lx, ly, vx, vy, moved, t0 }
  var solarBaseOmega = 0.0022;

  /* ---------- 确定性随机（保证纹理每次加载长得一样） ---------- */

  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 行星纹理工厂（离屏画布，缓存复用） ---------- */

  var TEX_SIZE = 128;
  var TEX_R = 60;

  function makeTexture(p, seed) {
    var c = document.createElement('canvas');
    c.width = TEX_SIZE;
    c.height = TEX_SIZE;
    var g = c.getContext('2d');
    var rnd = mulberry32(seed * 7919 + 17);
    var cx = TEX_SIZE / 2;

    g.save();
    g.beginPath();
    g.arc(cx, cx, TEX_R, 0, 6.2832);
    g.clip();

    var painters = {
      rocky: paintRocky,
      venus: paintVenus,
      earth: paintEarth,
      mars: paintMars,
      jup: paintBands,
      sat: paintBands,
      ura: paintIce,
      nep: paintIce
    };
    (painters[p.tex] || paintRocky)(g, p, rnd);

    g.restore();
    return c;
  }

  function sphereBase(g, c1, c2, c3) {
    var grad = g.createRadialGradient(48, 46, 6, 64, 64, TEX_R + 4);
    grad.addColorStop(0, c1);
    grad.addColorStop(0.55, c2);
    grad.addColorStop(1, c3);
    g.fillStyle = grad;
    g.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
  }

  /* 岩石天体（水星 / 月球风格）：灰色基底 + 陨石坑 */
  function paintRocky(g, p, rnd) {
    sphereBase(g, '#b5ada2', '#948c82', '#5f584f');
    for (var i = 0; i < 10; i++) {
      var x = 10 + rnd() * 108;
      var y = 10 + rnd() * 108;
      var r = 2.5 + rnd() * 6.5;
      g.fillStyle = 'rgba(40,36,30,0.25)';
      g.beginPath();
      g.arc(x, y, r, 0, 6.2832);
      g.fill();
      g.strokeStyle = 'rgba(230,222,210,0.22)';
      g.lineWidth = 1;
      g.beginPath();
      g.arc(x, y, r, -2.4, 0.4);
      g.stroke();
    }
    /* 一片较大的暗色盆地 */
    g.fillStyle = 'rgba(60,54,46,0.20)';
    g.beginPath();
    g.ellipse(84, 78, 20, 14, 0.5, 0, 6.2832);
    g.fill();
  }

  /* 金星：浓密云层涡旋 */
  function paintVenus(g, p, rnd) {
    sphereBase(g, '#f3d9a4', '#e0b56e', '#a97e42');
    for (var i = 0; i < 7; i++) {
      var y = 12 + i * 16 + rnd() * 6;
      g.fillStyle = i % 2 ? 'rgba(250,232,190,0.30)' : 'rgba(160,120,64,0.18)';
      g.beginPath();
      g.ellipse(64, y, 62, 6 + rnd() * 4, (rnd() - 0.5) * 0.2, 0, 6.2832);
      g.fill();
    }
    /* 大 V 型云涡 */
    g.strokeStyle = 'rgba(255,244,214,0.35)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(24, 100);
    g.quadraticCurveTo(64, 44, 104, 92);
    g.stroke();
  }

  /* 地球：海洋 + 大陆 + 冰盖 + 云 */
  function paintEarth(g, p, rnd) {
    sphereBase(g, '#4f9be8', '#2c6fc4', '#153e86');
    var landColors = ['#42925c', '#57a468', '#7cb56e', '#3a7f52'];
    var blobs = [
      [40, 52, 1], [58, 44, 2], [50, 68, 3], [86, 62, 2],
      [92, 84, 1], [76, 94, 3], [34, 86, 2], [64, 100, 1], [100, 44, 2]
    ];
    for (var b = 0; b < blobs.length; b++) {
      var bx = blobs[b][0], by = blobs[b][1], k = blobs[b][2];
      g.fillStyle = landColors[k % landColors.length];
      for (var j = 0; j < 5; j++) {
        g.beginPath();
        g.ellipse(
          bx + (rnd() - 0.5) * 18, by + (rnd() - 0.5) * 14,
          6 + rnd() * 9, 4 + rnd() * 6, rnd() * 3, 0, 6.2832
        );
        g.fill();
      }
    }
    /* 极地冰盖 */
    g.fillStyle = 'rgba(240,248,255,0.92)';
    g.beginPath();
    g.ellipse(64, 2, 46, 14, 0, 0, 6.2832);
    g.fill();
    g.beginPath();
    g.ellipse(64, 126, 42, 12, 0, 0, 6.2832);
    g.fill();
    /* 云带 */
    g.fillStyle = 'rgba(255,255,255,0.26)';
    for (var c = 0; c < 6; c++) {
      g.beginPath();
      g.ellipse(20 + rnd() * 88, 16 + rnd() * 96, 16 + rnd() * 14, 4 + rnd() * 3, (rnd() - 0.5) * 0.6, 0, 6.2832);
      g.fill();
    }
  }

  /* 火星：铁锈红 + 暗斑 + 极冠 */
  function paintMars(g, p, rnd) {
    sphereBase(g, '#e88a5a', '#c1552f', '#7e3018');
    for (var i = 0; i < 6; i++) {
      g.fillStyle = 'rgba(110,48,26,0.30)';
      g.beginPath();
      g.ellipse(20 + rnd() * 88, 24 + rnd() * 80, 10 + rnd() * 14, 6 + rnd() * 8, rnd() * 3, 0, 6.2832);
      g.fill();
    }
    /* 水手谷般的暗痕 */
    g.strokeStyle = 'rgba(90,36,18,0.4)';
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(30, 70);
    g.quadraticCurveTo(60, 62, 86, 76);
    g.stroke();
    g.fillStyle = 'rgba(250,240,230,0.9)';
    g.beginPath();
    g.ellipse(64, 4, 30, 10, 0, 0, 6.2832);
    g.fill();
  }

  /* 气态巨行星：条带（木星带大红斑，土星更柔） */
  function paintBands(g, p, rnd) {
    var jup = p.tex === 'jup';
    var bands = jup
      ? ['#e8c39a', '#c9925c', '#efd3ad', '#b57a4a', '#e3ac72', '#c4855a', '#dca96f', '#b26f45', '#e8c39a']
      : ['#efd9a7', '#dfc184', '#f4e3b6', '#d3b26a', '#e8cf95', '#d9ba76', '#efd9a7'];
    var n = bands.length;
    var y = 0;
    for (var i = 0; i < n; i++) {
      var h = TEX_SIZE / n + (rnd() - 0.5) * 5;
      g.fillStyle = bands[i % bands.length];
      g.fillRect(0, y - 1, TEX_SIZE, h + 2);
      /* 带缘的湍流细线 */
      g.fillStyle = jup ? 'rgba(120,72,40,0.22)' : 'rgba(150,120,70,0.16)';
      g.fillRect(0, y + h - 2, TEX_SIZE, 2.5);
      y += h;
    }
    if (jup) {
      /* 大红斑 */
      g.fillStyle = 'rgba(190,80,55,0.9)';
      g.beginPath();
      g.ellipse(80, 84, 13, 8, 0.15, 0, 6.2832);
      g.fill();
      g.strokeStyle = 'rgba(235,170,130,0.8)';
      g.lineWidth = 2;
      g.beginPath();
      g.ellipse(80, 84, 13, 8, 0.15, 0, 6.2832);
      g.stroke();
      g.fillStyle = 'rgba(225,130,95,0.55)';
      g.beginPath();
      g.ellipse(80, 84, 7, 4, 0.15, 0, 6.2832);
      g.fill();
    }
  }

  /* 冰巨行星：平滑 + 微条带 */
  function paintIce(g, p, rnd) {
    var nep = p.tex === 'nep';
    sphereBase(
      g,
      nep ? '#7d9af8' : '#b8ecf2',
      nep ? '#4a63d8' : '#79c9d8',
      nep ? '#24338f' : '#3d8fa0'
    );
    for (var i = 0; i < 5; i++) {
      g.fillStyle = 'rgba(255,255,255,0.10)';
      g.fillRect(0, 16 + i * 22 + rnd() * 4, TEX_SIZE, 5);
    }
    if (nep) {
      /* 大暗斑 */
      g.fillStyle = 'rgba(20,30,100,0.5)';
      g.beginPath();
      g.ellipse(46, 56, 12, 7, 0.2, 0, 6.2832);
      g.fill();
    }
  }

  var planetTex = {};
  for (var ti = 0; ti < PLANETS.length; ti++) {
    planetTex[PLANETS[ti].name] = makeTexture(PLANETS[ti], ti + 1);
  }

  function solarLayout() {
    var mobile = W < 640;
    var maxR = mobile ? Math.min(W * 0.42, H * 0.3) : Math.min(W * 0.46, H * 0.62);
    return {
      scale: maxR / 262,
      cx: W * 0.5,
      cy: mobile ? H * 0.3 : H * 0.44,
      alpha: mobile ? 0.75 : 1,
      sunR: mobile ? 12 : 18
    };
  }

  function drawSolar(t, C) {
    var L = solarLayout();
    var cx = L.cx + par.x * 1.6;
    var cy = L.cy + par.y * 1.6;

    ctx.save();
    ctx.globalAlpha = L.alpha;

    /* 轨道线 */
    ctx.lineWidth = 1;
    for (var oi = 0; oi < PLANETS.length; oi++) {
      var od = PLANETS[oi].dist * L.scale;
      ctx.strokeStyle = 'rgba(' + C.line + ',' + C.orbitA.toFixed(3) + ')';
      ctx.beginPath();
      ctx.ellipse(cx, cy, od, od * FLATTEN, 0, 0, 6.2832);
      ctx.stroke();
    }

    /* 行星位置（含抓取 / 弹回） */
    var order = [];
    for (var i = 0; i < PLANETS.length; i++) {
      var p = PLANETS[i];
      p.kick *= 0.97;
      if (!REDUCED) p.angle += solarBaseOmega * p.speed * (1 + p.kick * 2.2);
      var x3 = Math.cos(p.angle) * p.dist * L.scale;
      var z3 = Math.sin(p.angle) * p.dist * L.scale;
      var depthN = z3 / (262 * L.scale);
      var bx = cx + x3;
      var by = cy + z3 * FLATTEN;

      if (grab && grab.idx === i) {
        /* 抓取中：跟随指针 */
        p.offX += (pointer.x - bx - p.offX) * 0.35;
        p.offY += (pointer.y - by - p.offY) * 0.35;
        p.ovX *= 0.6;
        p.ovY *= 0.6;
      } else {
        /* 弹簧回轨（带甩动的弹性） */
        p.ovX += -p.offX * 0.055;
        p.ovY += -p.offY * 0.055;
        p.ovX *= 0.88;
        p.ovY *= 0.88;
        p.offX += p.ovX;
        p.offY += p.ovY;
      }

      p.sx = bx + p.offX;
      p.sy = by + p.offY;
      p.sr = p.r * L.scale * 1.35 * (1 + depthN * DEPTH_SCALE);
      p.depth = depthN;
      order.push(p);
    }
    order.sort(function (a, b) { return a.depth - b.depth; });

    var far = [];
    var near = [];
    for (var k = 0; k < order.length; k++) {
      (order[k].depth < 0 ? far : near).push(order[k]);
    }

    for (var f = 0; f < far.length; f++) drawPlanet(far[f], cx, cy, C);
    drawSun(t, cx, cy, L, C);
    for (var n = 0; n < near.length; n++) drawPlanet(near[n], cx, cy, C);

    /* 悬停检测 */
    solarHover = null;
    if (pointer.on && !grab) {
      var sunHitR = L.sunR + 14;
      if (dist2(pointer.x, pointer.y, cx, cy) < sunHitR * sunHitR) {
        solarHover = { type: 'sun' };
      } else {
        for (var h = 0; h < PLANETS.length; h++) {
          var q = PLANETS[h];
          var hitR = Math.max(q.sr + 12, 16);
          if (dist2(pointer.x, pointer.y, q.sx, q.sy) < hitR * hitR) {
            solarHover = { type: 'planet', idx: h };
            break;
          }
        }
      }
    }

    /* 悬停高亮 + 标签 */
    if (solarHover || grab) {
      var hx, hy, hr, label;
      if (grab) {
        var gp = PLANETS[grab.idx];
        hx = gp.sx; hy = gp.sy; hr = gp.sr; label = gp.name + ' · ' + gp.en;
      } else if (solarHover.type === 'sun') {
        hx = cx; hy = cy; hr = L.sunR; label = '太阳 · SOL';
      } else {
        var hp = PLANETS[solarHover.idx];
        hx = hp.sx; hy = hp.sy; hr = hp.sr; label = hp.name + ' · ' + hp.en;
      }
      ctx.strokeStyle = 'rgba(' + C.label + ',0.7)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(hx, hy, hr + 6, 0, 6.2832);
      ctx.stroke();

      if (pointer.on) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(' + C.tether + ',0.5)';
        ctx.beginPath();
        ctx.moveTo(pointer.x, pointer.y);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      }

      ctx.strokeStyle = 'rgba(' + C.label + ',0.45)';
      ctx.beginPath();
      ctx.moveTo(hx, hy - hr - 5);
      ctx.lineTo(hx, hy - hr - 16);
      ctx.stroke();

      ctx.font = '600 12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(' + C.label + ',0.95)';
      ctx.fillText(label, hx, hy - hr - 22);
    }

    ctx.restore();
  }

  function drawPlanet(p, cx, cy, C) {
    /* 柔和光晕 */
    if (C.additive) ctx.globalCompositeOperation = 'lighter';
    var gg = ctx.createRadialGradient(p.sx, p.sy, 0, p.sx, p.sy, p.sr * 2.8);
    gg.addColorStop(0, p.atmo ? 'rgba(' + p.atmo + ',0.22)' : hexA('#8fb7ff', 0.12));
    gg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = gg;
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, p.sr * 2.8, 0, 6.2832);
    ctx.fill();
    if (C.additive) ctx.globalCompositeOperation = 'source-over';

    var lx = cx - p.sx;
    var ly = cy - p.sy;
    var ll = Math.sqrt(lx * lx + ly * ly) || 1;
    lx /= ll;
    ly /= ll;

    /* 土星环（后半，先画） */
    if (p.ring) drawRing(p, true);

    /* 球体贴图 */
    ctx.drawImage(planetTex[p.name], p.sx - p.sr, p.sy - p.sr, p.sr * 2, p.sr * 2);

    /* 昼夜晨昏线：背阳面渐暗 */
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.sx, p.sy, p.sr, 0, 6.2832);
    ctx.clip();
    var sg = ctx.createRadialGradient(
      p.sx + lx * p.sr * 0.7, p.sy + ly * p.sr * 0.7, p.sr * 0.1,
      p.sx + lx * p.sr * 0.35, p.sy + ly * p.sr * 0.35, p.sr * 1.9
    );
    sg.addColorStop(0, 'rgba(0,0,0,0)');
    sg.addColorStop(0.52, 'rgba(3,6,16,0.05)');
    sg.addColorStop(0.75, 'rgba(3,6,16,0.5)');
    sg.addColorStop(1, 'rgba(3,6,16,0.9)');
    ctx.fillStyle = sg;
    ctx.fillRect(p.sx - p.sr, p.sy - p.sr, p.sr * 2, p.sr * 2);

    /* 朝阳面镜面高光 */
    var hg = ctx.createRadialGradient(
      p.sx + lx * p.sr * 0.55, p.sy + ly * p.sr * 0.55, 0,
      p.sx + lx * p.sr * 0.55, p.sy + ly * p.sr * 0.55, p.sr * 0.5
    );
    hg.addColorStop(0, 'rgba(255,255,255,0.30)');
    hg.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hg;
    ctx.fillRect(p.sx - p.sr, p.sy - p.sr, p.sr * 2, p.sr * 2);
    ctx.restore();

    /* 大气边缘光 */
    if (p.atmo) {
      ctx.strokeStyle = 'rgba(' + p.atmo + ',0.5)';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(p.sx, p.sy, p.sr, 0, 6.2832);
      ctx.stroke();
    }

    /* 土星环（前半，后画） */
    if (p.ring) drawRing(p, false);

    /* 地球的月亮 */
    if (p.moon) {
      moonAngle += 0.05;
      var mx = p.sx + Math.cos(moonAngle) * p.sr * 2.8;
      var my = p.sy + Math.sin(moonAngle) * p.sr * 2.8 * FLATTEN;
      ctx.fillStyle = isDark() ? 'rgba(214,220,228,0.95)' : 'rgba(110,116,130,0.9)';
      ctx.beginPath();
      ctx.arc(mx, my, 1.7, 0, 6.2832);
      ctx.fill();
    }
  }

  /* 土星环：三条环带 + 卡西尼缝，分前后两半绘制 */
  function drawRing(p, back) {
    var a0 = back ? Math.PI : 0;
    var a1 = back ? 6.2832 : Math.PI;
    var bands = [
      { k: 1.45, w: 1.4, a: 0.30 },
      { k: 1.72, w: 3.0, a: 0.55 },
      { k: 2.05, w: 1.8, a: 0.35 }
    ];
    for (var i = 0; i < bands.length; i++) {
      var b = bands[i];
      ctx.strokeStyle = 'rgba(226,203,150,' + b.a + ')';
      ctx.lineWidth = b.w;
      ctx.beginPath();
      ctx.ellipse(p.sx, p.sy, p.sr * b.k, p.sr * b.k * 0.42, -0.32, a0, a1);
      ctx.stroke();
    }
  }

  function drawSun(t, cx, cy, L, C) {
    sunPulse *= 0.96;
    var r = L.sunR * (1 + 0.05 * Math.sin(t * 2.2) + sunPulse * 0.5);

    /* 日冕光晕（两层） */
    if (C.additive) ctx.globalCompositeOperation = 'lighter';
    var cg1 = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 6);
    cg1.addColorStop(0, 'rgba(255,214,140,0.42)');
    cg1.addColorStop(0.3, 'rgba(255,170,80,0.18)');
    cg1.addColorStop(1, 'rgba(255,140,50,0)');
    ctx.fillStyle = cg1;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 6, 0, 6.2832);
    ctx.fill();

    /* 缓慢旋转的日冕射线 */
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.02);
    ctx.strokeStyle = 'rgba(255,196,120,0.10)';
    ctx.lineWidth = 1.4;
    for (var i = 0; i < 12; i++) {
      var ang = (Math.PI * 2 * i) / 12;
      var len = r * (2.4 + Math.sin(t * 0.8 + i * 1.7) * 0.7);
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * r * 1.15, Math.sin(ang) * r * 1.15);
      ctx.lineTo(Math.cos(ang) * len, Math.sin(ang) * len);
      ctx.stroke();
    }
    ctx.restore();
    if (C.additive) ctx.globalCompositeOperation = 'source-over';

    /* 球体：白热核心 → 光球 → 色球边缘 */
    var sg = ctx.createRadialGradient(cx - r * 0.15, cy - r * 0.15, r * 0.05, cx, cy, r);
    sg.addColorStop(0, '#fffdf2');
    sg.addColorStop(0.35, '#ffe9a8');
    sg.addColorStop(0.72, '#ffb84d');
    sg.addColorStop(1, '#ff8a3d');
    ctx.fillStyle = sg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 6.2832);
    ctx.fill();

    /* 临边昏暗 + 微小黑子 */
    var lg = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r);
    lg.addColorStop(0, 'rgba(200,90,30,0)');
    lg.addColorStop(1, 'rgba(200,90,30,0.35)');
    ctx.fillStyle = lg;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = 'rgba(150,60,20,0.35)';
    ctx.beginPath();
    ctx.arc(cx + r * 0.3, cy - r * 0.2, r * 0.09, 0, 6.2832);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx - r * 0.25, cy + r * 0.3, r * 0.06, 0, 6.2832);
    ctx.fill();
  }

  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function dist2(x1, y1, x2, y2) {
    var dx = x1 - x2, dy = y1 - y2;
    return dx * dx + dy * dy;
  }

  /* ======================================================================
     星场 / 星尘 / 交互
     ====================================================================== */

  function makeStar() {
    return {
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      r: 0.6 + Math.random() * 1.4,
      base: 0.35 + Math.random() * 0.5,
      ph: Math.random() * Math.PI * 2,
      sp: 0.4 + Math.random() * 1.4,
      ci: (Math.random() * 4) | 0,
      z: 0.3 + Math.random() * 0.7,
      ox: 0,
      oy: 0,
      rx: 0,
      ry: 0
    };
  }

  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    var target = Math.round(
      Math.min(CONFIG.maxStars, Math.max(CONFIG.minStars, (W * H) / CONFIG.density))
    );
    stars = [];
    for (var i = 0; i < target; i++) stars.push(makeStar());
  }

  function spawnComet(now, atX, atY) {
    if (atX !== undefined) {
      comets.push({
        x: atX, y: atY,
        vx: (Math.random() < 0.5 ? -1 : 1) * (6 + Math.random() * 4),
        vy: -(2 + Math.random() * 2.5),
        life: 1
      });
      return;
    }
    var fromLeft = Math.random() < 0.5;
    comets.push({
      x: fromLeft ? -80 : W * 0.3 + Math.random() * W * 0.7,
      y: Math.random() * H * 0.35,
      vx: (fromLeft ? 1 : -1) * (7 + Math.random() * 5),
      vy: 2.5 + Math.random() * 2,
      life: 1
    });
    if (now !== undefined) {
      nextCometAt = now + CONFIG.cometEvery[0] +
        Math.random() * (CONFIG.cometEvery[1] - CONFIG.cometEvery[0]);
    }
  }

  function burst(x, y, scale) {
    if (REDUCED) return;
    scale = scale || 1;
    var C = themeColors();

    var n = Math.round(CONFIG.burstSparks * scale);
    for (var i = 0; i < n; i++) {
      var ang = (Math.PI * 2 * i) / n + Math.random() * 0.5;
      var sp = (1.8 + Math.random() * 4.5) * scale;
      sparks.push({
        x: x,
        y: y,
        vx: Math.cos(ang) * sp,
        vy: Math.sin(ang) * sp - 0.4,
        life: 1,
        decay: 0.012 + Math.random() * 0.02,
        r: 0.9 + Math.random() * 1.7,
        ci: (Math.random() * C.spark.length) | 0
      });
    }
    if (sparks.length > CONFIG.maxSparks) {
      sparks.splice(0, sparks.length - CONFIG.maxSparks);
    }

    rings.push({ x: x, y: y, r: 4, vr: 5.5 * scale, life: 1, decay: 0.022, delay: 0 });
    rings.push({ x: x, y: y, r: 2, vr: 3.4 * scale, life: 1, decay: 0.015, delay: 5 });

    for (var k = 0; k < stars.length; k++) {
      var st = stars[k];
      var dx = st.x - x;
      var dy = st.y - y;
      var d2v = dx * dx + dy * dy;
      if (d2v > 0.01 && d2v < 170 * 170) {
        var d = Math.sqrt(d2v);
        var f = (1 - d / 170) * 7 * scale;
        st.ox += (dx / d) * f;
        st.oy += (dy / d) * f;
      }
    }
  }

  /* 点击目标是否落在前景内容上（卡片 / 链接 / 页头等） */
  function onContent(t) {
    return !!(t && t.closest && t.closest(
      'a, button, .post-item, .archive-list li, .page-header, .post-header,' +
      '.about-panel, .site-header, pre, code, table, .tag-index'
    ));
  }

  /* 3D 太阳系（solar3d.js）激活时：本层只画悬停标签与连线，天体由 WebGL 渲染；
     未激活（three.min.js 加载失败等）自动退回下面的 2D 备用方案 */
  function drawSolarBridge(C) {
    var hv = window.Solar3D ? window.Solar3D.hovered : null;
    if (!hv) return;
    ctx.strokeStyle = 'rgba(' + C.label + ',0.7)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.arc(hv.x, hv.y, hv.r + 6, 0, 6.2832);
    ctx.stroke();

    if (pointer.on) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(' + C.tether + ',0.5)';
      ctx.beginPath();
      ctx.moveTo(pointer.x, pointer.y);
      ctx.lineTo(hv.x, hv.y);
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(' + C.label + ',0.45)';
    ctx.beginPath();
    ctx.moveTo(hv.x, hv.y - hv.r - 5);
    ctx.lineTo(hv.x, hv.y - hv.r - 16);
    ctx.stroke();

    ctx.font = '600 12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(' + C.label + ',0.95)';
    ctx.fillText(hv.label, hv.x, hv.y - hv.r - 22);
    if (hv.hint) {
      ctx.font = '400 10.5px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillStyle = 'rgba(' + C.label + ',0.65)';
      ctx.fillText(hv.hint, hv.x, hv.y - hv.r - 37);
    }
  }

  function solar3dActive() {
    return !!(window.Solar3D && window.Solar3D.active);
  }

  var lastColors = themeColors();

  function frame(now) {
    lastColors = themeColors();
    var C = lastColors;
    var t = now / 1000;
    /* 内容页背景更安静：星点与连线整体调暗 */
    var focusDim = IS_HOME ? 1 : 0.55;
    ctx.clearRect(0, 0, W, H);

    if (pointer.on) {
      parT.x = ((pointer.x / W) - 0.5) * 2 * CONFIG.parallax;
      parT.y = ((pointer.y / H) - 0.5) * 2 * CONFIG.parallax;
    } else {
      parT.x = 0;
      parT.y = 0;
    }
    par.x += (parT.x - par.x) * 0.045;
    par.y += (parT.y - par.y) * 0.045;

    var sy = window.scrollY || 0;
    var sDelta = sy - lastScrollY;
    lastScrollY = sy;
    wind += Math.max(-5, Math.min(5, sDelta * 0.05));
    wind *= 0.92;
    if (Math.abs(wind) < 0.01) wind = 0;

    /* 光标脉冲光环 */
    if (pointer.on) {
      var og = ctx.createRadialGradient(pointer.x, pointer.y, 0, pointer.x, pointer.y, 80);
      og.addColorStop(0, C.glow);
      og.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = og;
      ctx.fillRect(pointer.x - 80, pointer.y - 80, 160, 160);

      var pr = 14 + Math.sin(t * 3) * 3;
      ctx.strokeStyle = 'rgba(' + C.orb + ',' +
        (0.35 + 0.15 * Math.sin(t * 3)).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, pr, 0, 6.2832);
      ctx.stroke();
      ctx.fillStyle = 'rgba(' + C.orb + ',0.9)';
      ctx.beginPath();
      ctx.arc(pointer.x, pointer.y, 2, 0, 6.2832);
      ctx.fill();
    }

    /* 星点更新 */
    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.x += s.vx;
      s.y += s.vy + wind * s.z;
      if (s.x < -20) s.x = W + 20; else if (s.x > W + 20) s.x = -20;
      if (s.y < -20) s.y = H + 20; else if (s.y > H + 20) s.y = -20;

      s.rx = s.x + s.ox + par.x * s.z;
      s.ry = s.y + s.oy + par.y * s.z;

      if (pointer.on) {
        var dx = s.rx - pointer.x;
        var dy = s.ry - pointer.y;
        var d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < CONFIG.repelRadius * CONFIG.repelRadius) {
          var d = Math.sqrt(d2);
          var f = (1 - d / CONFIG.repelRadius) * 2.2;
          s.ox += (dx / d) * f;
          s.oy += (dy / d) * f;
        }
      }
      s.ox *= 0.9;
      s.oy *= 0.9;
    }

    /* 流星 + 星尘 + 冲击波 */
    ctx.globalCompositeOperation = C.additive ? 'lighter' : 'source-over';

    if (now > nextCometAt) spawnComet(now);
    for (var ci = comets.length - 1; ci >= 0; ci--) {
      var c = comets[ci];
      c.x += c.vx;
      c.y += c.vy;
      c.life -= 0.008;
      if (c.life <= 0 || c.x < -140 || c.x > W + 140 || c.y > H + 140 || c.y < -140) {
        comets.splice(ci, 1);
        continue;
      }
      var tailX = c.x - c.vx * 10;
      var tailY = c.y - c.vy * 10;
      var cg = ctx.createLinearGradient(c.x, c.y, tailX, tailY);
      cg.addColorStop(0, 'rgba(' + C.comet + ',' + (0.85 * c.life).toFixed(3) + ')');
      cg.addColorStop(1, 'rgba(' + C.comet + ',0)');
      ctx.strokeStyle = cg;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
      ctx.fillStyle = 'rgba(' + C.comet + ',' + (0.9 * c.life).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(c.x, c.y, 1.8, 0, 6.2832);
      ctx.fill();
    }

    for (var si = sparks.length - 1; si >= 0; si--) {
      var spk = sparks[si];
      spk.x += spk.vx;
      spk.y += spk.vy;
      spk.vx *= 0.96;
      spk.vy *= 0.96;
      spk.life -= spk.decay;
      if (spk.life <= 0) {
        sparks.splice(si, 1);
        continue;
      }
      var la = spk.life * (C.additive ? 0.9 : 1);
      ctx.strokeStyle = 'rgba(' + C.spark[spk.ci] + ',' + (la * 0.6).toFixed(3) + ')';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(spk.x, spk.y);
      ctx.lineTo(spk.x - spk.vx * 2.5, spk.y - spk.vy * 2.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(' + C.spark[spk.ci] + ',' + la.toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(spk.x, spk.y, Math.max(spk.r * spk.life, 0.2), 0, 6.2832);
      ctx.fill();
    }

    for (var ri = rings.length - 1; ri >= 0; ri--) {
      var rg = rings[ri];
      if (rg.delay > 0) {
        rg.delay--;
        continue;
      }
      rg.r += rg.vr;
      rg.vr *= 0.97;
      rg.life -= rg.decay;
      if (rg.life <= 0) {
        rings.splice(ri, 1);
        continue;
      }
      ctx.strokeStyle = 'rgba(' + C.ring + ',' + (rg.life * 0.55).toFixed(3) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(rg.x, rg.y, rg.r, 0, 6.2832);
      ctx.stroke();
    }

    ctx.globalCompositeOperation = 'source-over';

    /* 星座连线 */
    ctx.lineWidth = 1;
    for (var a = 0; a < stars.length - 1; a++) {
      var p1 = stars[a];
      for (var b = a + 1; b < stars.length; b++) {
        var p2 = stars[b];
        var ddx = p1.rx - p2.rx;
        var ddy = p1.ry - p2.ry;
        var dd = ddx * ddx + ddy * ddy;
        if (dd < CONFIG.linkDist * CONFIG.linkDist) {
          var al = (1 - Math.sqrt(dd) / CONFIG.linkDist) * C.lineA * focusDim;
          ctx.strokeStyle = 'rgba(' + C.line + ',' + al.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(p1.rx, p1.ry);
          ctx.lineTo(p2.rx, p2.ry);
          ctx.stroke();
        }
      }
    }

    /* 星点 */
    for (var k2 = 0; k2 < stars.length; k2++) {
      var st2 = stars[k2];
      var tw = C.twinkleLow + (1 - C.twinkleLow) *
        (0.5 + 0.5 * Math.sin(t * st2.sp + st2.ph));
      ctx.fillStyle = 'rgba(' + C.star[st2.ci] + ',' +
        (st2.base * tw * C.starBoost * focusDim).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(st2.rx, st2.ry, st2.r * C.starScale, 0, 6.2832);
      ctx.fill();
    }

    /* 光标引力连线 */
    if (pointer.on) {
      ctx.lineWidth = 1;
      for (var m = 0; m < stars.length; m++) {
        var q = stars[m];
        var qx = q.rx - pointer.x;
        var qy = q.ry - pointer.y;
        var qd2 = qx * qx + qy * qy;
        if (qd2 < CONFIG.tetherRadius * CONFIG.tetherRadius) {
          var qd = Math.sqrt(qd2);
          var ta = (1 - qd / CONFIG.tetherRadius) * C.tetherA * focusDim;
          ctx.strokeStyle = 'rgba(' + C.tether + ',' + ta.toFixed(3) + ')';
          ctx.beginPath();
          ctx.moveTo(pointer.x, pointer.y);
          ctx.lineTo(q.rx, q.ry);
          ctx.stroke();
        }
      }
    }

    if (solar3dActive()) {
      drawSolarBridge(C);
    }
    /* 2D 备用太阳系已移除：曾导致页面加载时「粗糙模型」闪现。
       3D 引擎自身已有程序化贴图兜底（solar3d.js）。 */
  }

  var bgLastRender = 0;

  function tick(now) {
    /* 星场同样限 45fps（22ms），与 3D 引擎对齐 */
    if (now - bgLastRender < 22) {
      raf = requestAnimationFrame(tick);
      return;
    }
    bgLastRender = now;
    /* 单帧出错时记录并保活循环，避免整个背景死掉 */
    try {
      frame(now);
    } catch (err) {
      window.__bgLastError = String((err && err.stack) || err);
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running || REDUCED) return;
    running = true;
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  /* 看门狗：可见但循环停摆时自愈 */
  setInterval(function () {
    if (REDUCED || document.hidden) return;
    if (!running) start();
  }, 1500);

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  window.addEventListener('pointermove', function (e) {
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.on = true;

    if (grab) {
      grab.vx = e.clientX - grab.lx;
      grab.vy = e.clientY - grab.ly;
      grab.moved += Math.abs(e.clientX - grab.lx) + Math.abs(e.clientY - grab.ly);
      grab.lx = e.clientX;
      grab.ly = e.clientY;
    }

    if (!REDUCED) {
      var dx = e.clientX - lastTrail.x;
      var dy = e.clientY - lastTrail.y;
      if (dx * dx + dy * dy > 26 * 26) {
        lastTrail.x = e.clientX;
        lastTrail.y = e.clientY;
        var C = themeColors();
        sparks.push({
          x: e.clientX + (Math.random() - 0.5) * 8,
          y: e.clientY + (Math.random() - 0.5) * 8,
          vx: (Math.random() - 0.5) * 0.8,
          vy: 0.2 + Math.random() * 0.5,
          life: 0.8,
          decay: 0.025 + Math.random() * 0.02,
          r: 0.6 + Math.random() * 1.1,
          ci: (Math.random() * C.spark.length) | 0
        });
      }
    }
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    if (e.target && e.target.closest && e.target.closest('#theme-toggle')) return;

    /* 飞行模式下指针专用于飞船转向，背景交互全部让位 */
    if (document.body.classList.contains('flight-mode')) return;

    /* 3D 太阳系在线时，行星抓取交给 solar3d.js；
       只有链接/按钮等可点元素优先，卡片正文区域允许隔卡拖行星 */
    if (solar3dActive()) {
      var onLink = e.target && e.target.closest &&
        e.target.closest('a, button, pre, code, table');
      if (!onLink && window.Solar3D.onPointerDown(e.clientX, e.clientY)) {
        return;
      }
      burst(e.clientX, e.clientY, onContent(e.target) ? 0.7 : 1);
      return;
    }

    if (onContent(e.target)) {
      burst(e.clientX, e.clientY, 0.7);
      return;
    }

    var L = solarLayout();
    var cx = L.cx + par.x * 1.6;
    var cy = L.cy + par.y * 1.6;

    if (!REDUCED && IS_HOME) {
      /* 行星：进入抓取（点按/拖拽在 pointerup 时区分）；仅首页有太阳系 */
      for (var i = 0; i < PLANETS.length; i++) {
        var p = PLANETS[i];
        var hitR = Math.max(p.sr + 14, 20);
        if (dist2(e.clientX, e.clientY, p.sx, p.sy) < hitR * hitR) {
          grab = { idx: i, lx: e.clientX, ly: e.clientY, vx: 0, vy: 0, moved: 0 };
          document.body.style.cursor = 'grabbing';
          return;
        }
      }
      var sunHit = L.sunR + 16;
      if (dist2(e.clientX, e.clientY, cx, cy) < sunHit * sunHit) {
        sunPulse = 1;
        burst(e.clientX, e.clientY, 1.8);
        return;
      }
    }

    burst(e.clientX, e.clientY, 1);
  }, { passive: true });

  window.addEventListener('pointerup', function (e) {
    if (grab) {      var p = PLANETS[grab.idx];
      if (grab.moved < 8) {
        /* 原地点按：加速公转 + 小星尘 */
        p.kick = Math.min(p.kick + 1.5, 4);
        burst(p.sx, p.sy, 0.7);
      } else {
        /* 甩出：以指针速度弹回轨道 */
        p.ovX = Math.max(-14, Math.min(14, grab.vx * 1.1));
        p.ovY = Math.max(-14, Math.min(14, grab.vy * 1.1));
      }
      grab = null;
      document.body.style.cursor = '';
    }
  }, { passive: true });

  /* 双击空白：曲速爆发 */
  window.addEventListener('dblclick', function (e) {
    if (REDUCED || onContent(e.target)) return;
    burst(e.clientX, e.clientY, 1.6);
    rings.push({ x: e.clientX, y: e.clientY, r: 10, vr: 9, life: 1, decay: 0.014, delay: 2 });
    rings.push({ x: e.clientX, y: e.clientY, r: 6, vr: 6.5, life: 1, decay: 0.012, delay: 8 });
    spawnComet(undefined, e.clientX, e.clientY);
  }, { passive: true });

  window.addEventListener('starburst', function (e) {
    var d = (e && e.detail) || {};
    burst(d.x || W / 2, d.y || H / 2, d.scale || 1);
  });

  /* 还原按钮：仅首页（2D 备用方案）有效 */
  window.addEventListener('solar-reset', function () {
    if (!IS_HOME || solar3dActive()) return;
    for (var i = 0; i < PLANETS.length; i++) {
      PLANETS[i].kick = 0;
      PLANETS[i].offX = 0;
      PLANETS[i].offY = 0;
      PLANETS[i].ovX = 0;
      PLANETS[i].ovY = 0;
      PLANETS[i].angle = PLANETS[i].phase;
    }
    grab = null;
    burst(W / 2, H / 2, 1.2);
  });

  document.addEventListener('pointerleave', function () {
    pointer.on = false;
    pointer.x = -9999;
    pointer.y = -9999;
  });

  window.addEventListener('blur', function () {
    pointer.on = false;
  });

  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resize, 200);
  });

  resize();
  if (REDUCED) {
    frame(0);
  } else {
    nextCometAt = performance.now() + 4000;
    start();
  }

  /* 供调试 / 验收使用 */
  window.BlogBackground = {
    starCount: function () { return stars.length; },
    sparkCount: function () { return sparks.length; },
    pointer: pointer,
    reduced: REDUCED,
    burst: burst,
    /* 星场调节接口（供首页「调节台」面板调用） */
    tune: {
      setDensity: function (v) {
        CONFIG.density = v;
        resize();
      },
      setLinkDist: function (v) { CONFIG.linkDist = v; },
      setCometEvery: function (v) {
        CONFIG.cometEvery = [v * 1000, (v + 8) * 1000];
      },
      setBurstSparks: function (v) { CONFIG.burstSparks = Math.round(v); }
    },
    planets: function () {
      return PLANETS.map(function (p) {
        return { name: p.name, x: Math.round(p.sx), y: Math.round(p.sy), r: Math.round(p.sr) };
      });
    },
    sun: function () {
      var L = solarLayout();
      return { x: Math.round(L.cx + par.x * 1.6), y: Math.round(L.cy + par.y * 1.6), r: L.sunR };
    },
    grabState: function () {
      return grab ? { idx: grab.idx, moved: Math.round(grab.moved) } : null;
    }
  };
})();
