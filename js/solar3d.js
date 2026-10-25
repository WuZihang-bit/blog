/* ==========================================================================
   吴子航的博客 · 3D 太阳系引擎（Three.js）
   --------------------------------------------------------------------------
   - 真 3D 球体渲染：程序化等距圆柱贴图（条纹/海陆/陨石坑），自转，
     太阳点光源照出真实晨昏线，视角随鼠标轻微偏移
   - 质量引力系统：行星质量各异；拖拽小质量行星甩出后进入惯性运动，
     在「太阳 + 全体行星」的引力场里运行（GM 与质量成正比）
   - 大质量行星（木星 / 土星 / 天王星 / 海王星）拽不动，只能拉出一点形变
   - 碰撞破碎：撞太阳 / 撞行星的天体碎成数块，碎块继续受引力场支配；
     碎块再撞上天体会被吞并；飞出边界的会消失
   - 顶部导航「还原」按钮（solar-reset 事件）把一切恢复初始轨道
   - 加载失败时自动退回 background.js 里的 2D 备用方案
   ========================================================================== */

(function () {
  'use strict';

  if (!window.THREE) {
    var rb = document.getElementById('solar-reset');
    if (rb) rb.style.display = 'none';
    return;
  }

  var canvas = document.getElementById('bg-canvas-3d');
  if (!canvas) return;

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- 天体数据（与 2D 备用方案同一张表，多了质量） ----------
     mass 为相对质量：地球 = 1。可拖拽上限 PARAMS.dragMass = 2，
     于是水金地火拽得动，木土天海拽不动 */

  /* ---------- 可调参数（顶部「调节台」面板实时读写） ---------- */
  var PARAMS = {
    timeScale: 1,         // 时间流速：公转与自转的倍率
    sunGravity: 7000,     // 太阳引力参数（决定轨道速度量级）
    planetGravity: 0.05,  // 行星引力系数（相对太阳，×行星质量）
    releaseSpeed: 26,     // 甩出限速
    dragMass: 2,          // 可拖拽的质量上限（调到 12 就能拽木星）
    sunSize: 17,          // 太阳半径
    planetScale: 1,       // 行星视觉大小倍率
    renderMode: 'solid',  // 渲染模式：solid | wire | points（科学模式）
    mouseMode: 'select',  // 鼠标模式：select 选中拖拽 | free 自由视角（拖拽旋转/滚轮缩放）
    orbitOpacity: 0.12,   // 轨道线不透明度（暗色主题基准）
    parallax: 1           // 相机视差强度
  };
  var DESPAWN_R = 1200;       // 飞出这个距离视为丢失

  /* ---------- 移动端自动降载：手机 GPU/内存有限，全套 8K 必挂 ----------
     贴图换 2K、dpr 1.25、帧率 30、卫星与碎石减半、太阳系布局下移 */
  var IS_MOBILE = (function () {
    return window.innerWidth < 768 ||
      (window.matchMedia && window.matchMedia('(pointer: coarse)').matches &&
       Math.min(window.innerWidth, window.innerHeight) < 900);
  })();
  var MOB = {
    tex: IS_MOBILE,           /* 贴图 8k→2k 映射 */
    dpr: IS_MOBILE ? 1.25 : 2,
    frameMs: IS_MOBILE ? 33 : 22,   /* 30fps / 45fps */
    satN: IS_MOBILE ? 28 : 60,
    beltN: IS_MOBILE ? 72 : 160,
    dome2k: IS_MOBILE          /* 天幕手机上必用 2K（134MB→34MB） */
  };
  var MAX_FRAGS = 90;

  var PLANETS = [
    { name: '水星',   en: 'MERCURY', tex: 'rocky', file: '8k_mercury.jpg',        tilt: 0.03, r: 3.2, dist: 46,  speed: 2.4,  phase: 1.2, mass: 0.4 },
    { name: '金星',   en: 'VENUS',   tex: 'venus', file: '2k_venus_atmosphere.jpg', tilt: 177.4, texFlow: 0.006, r: 4.6, dist: 64,  speed: 1.75, phase: 3.9, mass: 0.8 },
    { name: '地球',   en: 'EARTH',   tex: 'earth', file: '8k_earth_daymap.jpg',   tilt: 23.4, r: 5.0, dist: 86,  speed: 1.4,  phase: 0.4, mass: 1.0, moon: true },
    { name: '火星',   en: 'MARS',    tex: 'mars',  file: '8k_mars.jpg',           tilt: 25.2, r: 3.8, dist: 110, speed: 1.1,  phase: 5.2, mass: 0.6 },
    { name: '木星',   en: 'JUPITER', tex: 'jup',   file: '8k_jupiter.jpg',        tilt: 3.1,  texFlow: 0.0015,  r: 13,  dist: 152, speed: 0.6,  phase: 2.1, mass: 12 },
    { name: '土星',   en: 'SATURN',  tex: 'sat',   file: '8k_saturn.jpg',         tilt: 26.7, r: 11,  dist: 195, speed: 0.48, phase: 4.4, mass: 7, ring: true },
    { name: '天王星', en: 'URANUS',  tex: 'ura',   file: null,               /* 增强程序化（真实贴图太平） */         tilt: 97.8, r: 7,   dist: 232, speed: 0.4,  phase: 0.9, mass: 3 },
    { name: '海王星', en: 'NEPTUNE', tex: 'nep',   file: null,               /* 增强程序化（真实贴图太平） */        tilt: 28.3, texFlow: 0.002, r: 6.8, dist: 262, speed: 0.33, phase: 2.8, mass: 2.8 }
  ];

  /* ---------- 确定性随机 ---------- */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------- 等距圆柱贴图（2:1，映射到 3D 球面） ---------- */

  function makeMap(w, paint, seed) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = w / 2;
    var g = c.getContext('2d');
    paint(g, c.width, c.height, mulberry32(seed * 7919 + 3));
    var tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    return tex;
  }

  function paintBandsJup(g, w, h, rnd) {
    var cols = ['#e8c39a', '#c9925c', '#efd3ad', '#b57a4a', '#e3ac72', '#c4855a', '#dca96f', '#b26f45', '#e8c39a'];
    var y = 0;
    for (var i = 0; i < cols.length; i++) {
      var bh = h / cols.length + (rnd() - 0.5) * h * 0.02;
      g.fillStyle = cols[i];
      g.fillRect(0, y - 1, w, bh + 2);
      g.fillStyle = 'rgba(120,72,40,0.25)';
      g.fillRect(0, y + bh - 2, w, 3);
      y += bh;
    }
    /* 大红斑 */
    g.fillStyle = 'rgba(190,80,55,0.92)';
    g.beginPath();
    g.ellipse(w * 0.72, h * 0.66, w * 0.055, h * 0.07, 0.1, 0, 6.2832);
    g.fill();
    g.strokeStyle = 'rgba(235,170,130,0.85)';
    g.lineWidth = 3;
    g.beginPath();
    g.ellipse(w * 0.72, h * 0.66, w * 0.055, h * 0.07, 0.1, 0, 6.2832);
    g.stroke();
    g.fillStyle = 'rgba(225,130,95,0.6)';
    g.beginPath();
    g.ellipse(w * 0.72, h * 0.66, w * 0.028, h * 0.038, 0.1, 0, 6.2832);
    g.fill();
  }

  function paintBandsSat(g, w, h, rnd) {
    var cols = ['#efd9a7', '#dfc184', '#f4e3b6', '#d3b26a', '#e8cf95', '#d9ba76', '#efd9a7'];
    var y = 0;
    for (var i = 0; i < cols.length; i++) {
      var bh = h / cols.length + (rnd() - 0.5) * h * 0.02;
      g.fillStyle = cols[i];
      g.fillRect(0, y - 1, w, bh + 2);
      g.fillStyle = 'rgba(150,120,70,0.18)';
      g.fillRect(0, y + bh - 2, w, 2.5);
      y += bh;
    }
  }

  function paintEarth(g, w, h, rnd) {
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#2f7ddb');
    grad.addColorStop(0.5, '#2262b4');
    grad.addColorStop(1, '#2f7ddb');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    var land = ['#42925c', '#57a468', '#7cb56e', '#3a7f52'];
    /* 大陆：跨经度随意分布的斑块簇 */
    var seeds = [
      [0.12, 0.32], [0.2, 0.38], [0.32, 0.28], [0.52, 0.62], [0.6, 0.4],
      [0.68, 0.3], [0.78, 0.55], [0.88, 0.35], [0.45, 0.3], [0.05, 0.6], [0.95, 0.65]
    ];
    for (var s = 0; s < seeds.length; s++) {
      var cx = seeds[s][0] * w;
      var cy = seeds[s][1] * h;
      g.fillStyle = land[s % land.length];
      for (var j = 0; j < 7; j++) {
        g.beginPath();
        g.ellipse(
          cx + (rnd() - 0.5) * w * 0.14, cy + (rnd() - 0.5) * h * 0.16,
          w * (0.02 + rnd() * 0.045), h * (0.03 + rnd() * 0.06), rnd() * 3, 0, 6.2832
        );
        g.fill();
      }
    }
    /* 极冠（贴到球顶/底就是白色极区） */
    g.fillStyle = 'rgba(240,248,255,0.95)';
    g.fillRect(0, 0, w, h * 0.07);
    g.fillRect(0, h * 0.93, w, h * 0.07);
    /* 云带 */
    g.fillStyle = 'rgba(255,255,255,0.28)';
    for (var c = 0; c < 9; c++) {
      g.beginPath();
      g.ellipse(rnd() * w, h * 0.15 + rnd() * h * 0.7, w * (0.05 + rnd() * 0.07), h * (0.015 + rnd() * 0.02), (rnd() - 0.5) * 0.5, 0, 6.2832);
      g.fill();
    }
  }

  function paintMars(g, w, h, rnd) {
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#c1552f');
    grad.addColorStop(0.5, '#d56a3d');
    grad.addColorStop(1, '#b34a28');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (var i = 0; i < 10; i++) {
      g.fillStyle = 'rgba(110,48,26,0.32)';
      g.beginPath();
      g.ellipse(rnd() * w, h * 0.2 + rnd() * h * 0.6, w * (0.03 + rnd() * 0.06), h * (0.03 + rnd() * 0.05), rnd() * 3, 0, 6.2832);
      g.fill();
    }
    g.fillStyle = 'rgba(250,240,230,0.92)';
    g.fillRect(0, 0, w, h * 0.05);
    g.fillRect(0, h * 0.95, w, h * 0.05);
  }

  function paintRocky(g, w, h, rnd) {
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#a89f93');
    grad.addColorStop(0.5, '#948c82');
    grad.addColorStop(1, '#7d756b');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (var i = 0; i < 26; i++) {
      var x = rnd() * w, y = h * 0.1 + rnd() * h * 0.8, r = h * (0.015 + rnd() * 0.045);
      g.fillStyle = 'rgba(40,36,30,0.28)';
      g.beginPath();
      g.arc(x, y, r, 0, 6.2832);
      g.fill();
      g.strokeStyle = 'rgba(230,222,210,0.25)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(x, y, r, -2.4, 0.4);
      g.stroke();
    }
  }

  function paintVenus(g, w, h, rnd) {
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#d9b26e');
    grad.addColorStop(0.5, '#e8c07a');
    grad.addColorStop(1, '#d9b26e');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    for (var i = 0; i < 12; i++) {
      var y = h * 0.08 + i * h * 0.08 + rnd() * h * 0.04;
      g.fillStyle = i % 2 ? 'rgba(250,232,190,0.34)' : 'rgba(160,120,64,0.2)';
      g.beginPath();
      g.ellipse(w * 0.5, y, w * 0.5, h * (0.02 + rnd() * 0.025), 0, 0, 6.2832);
      g.fill();
    }
    g.strokeStyle = 'rgba(255,244,214,0.4)';
    g.lineWidth = h * 0.04;
    g.beginPath();
    g.moveTo(0, h * 0.75);
    g.quadraticCurveTo(w * 0.5, h * 0.3, w, h * 0.68);
    g.stroke();
  }

  function paintIce(g, w, h, rnd, nep) {
    /* 冰巨星增强绘制：真实冰巨星表面特征极淡，这里艺术化增强——
       微渐变条纹、行星尺度涡旋、极冠与高纬亮化（天王星），
       大暗斑与伴行卷云（海王星） */
    var base = g.createLinearGradient(0, 0, 0, h);
    if (nep) {
      base.addColorStop(0, '#2b48b8');
      base.addColorStop(0.28, '#3d5ed6');
      base.addColorStop(0.5, '#4a6ce0');
      base.addColorStop(0.72, '#3d5ed6');
      base.addColorStop(1, '#2b48b8');
    } else {
      base.addColorStop(0, '#4fa8bc');
      base.addColorStop(0.3, '#74cad9');
      base.addColorStop(0.5, '#8ad9e5');
      base.addColorStop(0.7, '#74cad9');
      base.addColorStop(1, '#4fa8bc');
    }
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);

    /* 横向云带：宽窄交替、亮度微差、边缘柔化 */
    var bands = 9;
    for (var i = 0; i < bands; i++) {
      var y0 = h * (0.08 + 0.84 * i / bands);
      var bh = h * (0.03 + rnd() * 0.05);
      var lum = 0.05 + rnd() * 0.09;
      var band = g.createLinearGradient(0, y0, 0, y0 + bh);
      band.addColorStop(0, 'rgba(255,255,255,0)');
      band.addColorStop(0.5, 'rgba(235,246,255,' + lum.toFixed(3) + ')');
      band.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = band;
      g.fillRect(0, y0, w, bh);
      /* 暗带间隔 */
      if (i % 2 === 0) {
        var dark = g.createLinearGradient(0, y0 + bh, 0, y0 + bh + h * 0.02);
        dark.addColorStop(0, 'rgba(10,20,80,0.10)');
        dark.addColorStop(1, 'rgba(10,20,80,0)');
        g.fillStyle = dark;
        g.fillRect(0, y0 + bh, w, h * 0.02);
      }
    }

    if (nep) {
      /* 大暗斑（大西洋大小的反气旋） */
      var dsx = w * 0.34, dsy = h * 0.42;
      var ds = g.createRadialGradient(dsx, dsy, 0, dsx, dsy, w * 0.075);
      ds.addColorStop(0, 'rgba(12,22,86,0.55)');
      ds.addColorStop(0.7, 'rgba(12,22,86,0.28)');
      ds.addColorStop(1, 'rgba(12,22,86,0)');
      g.fillStyle = ds;
      g.beginPath();
      g.ellipse(dsx, dsy, w * 0.075, h * 0.052, 0.12, 0, 6.2832);
      g.fill();
      /* 第二暗斑 */
      var ds2 = g.createRadialGradient(w * 0.72, h * 0.6, 0, w * 0.72, h * 0.6, w * 0.045);
      ds2.addColorStop(0, 'rgba(12,22,86,0.38)');
      ds2.addColorStop(1, 'rgba(12,22,86,0)');
      g.fillStyle = ds2;
      g.beginPath();
      g.ellipse(w * 0.72, h * 0.6, w * 0.045, h * 0.032, -0.1, 0, 6.2832);
      g.fill();
      /* 伴行白色卷云（Scooter） */
      var sc = g.createRadialGradient(w * 0.4, h * 0.52, 0, w * 0.4, h * 0.52, w * 0.1);
      sc.addColorStop(0, 'rgba(240,248,255,0.4)');
      sc.addColorStop(1, 'rgba(240,248,255,0)');
      g.fillStyle = sc;
      g.beginPath();
      g.ellipse(w * 0.4, h * 0.52, w * 0.1, h * 0.018, 0.05, 0, 6.2832);
      g.fill();
    } else {
      /* 天王星：高纬极冠亮化（旅行者2号观测到的极冠） */
      var cap = g.createLinearGradient(0, 0, 0, h * 0.3);
      cap.addColorStop(0, 'rgba(214,242,248,0.5)');
      cap.addColorStop(1, 'rgba(214,242,248,0)');
      g.fillStyle = cap;
      g.fillRect(0, 0, w, h * 0.3);
      var cap2 = g.createLinearGradient(0, h, 0, h * 0.7);
      cap2.addColorStop(0, 'rgba(214,242,248,0.4)');
      cap2.addColorStop(1, 'rgba(214,242,248,0)');
      g.fillStyle = cap2;
      g.fillRect(0, h * 0.7, w, h * 0.3);
    }

    /* 细噪云丝：拉长的横向薄雾 */
    for (var f = 0; f < 22; f++) {
      var fy = h * (0.1 + rnd() * 0.8);
      var fx = rnd() * w;
      var fw = w * (0.05 + rnd() * 0.14);
      g.strokeStyle = 'rgba(255,255,255,' + (0.03 + rnd() * 0.05).toFixed(3) + ')';
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(fx, fy);
      g.quadraticCurveTo(fx + fw / 2, fy - 3, fx + fw, fy);
      g.stroke();
    }
  }

  /* 地球云层：透明底 + 柔边白色云团（作为 alpha 贴图） */
  function paintClouds(g, w, h, rnd) {
    for (var i = 0; i < 16; i++) {
      var cx = rnd() * w;
      var cy = h * 0.12 + rnd() * h * 0.76;
      var rw = w * (0.04 + rnd() * 0.09);
      var rh = h * (0.02 + rnd() * 0.045);
      for (var j = 0; j < 5; j++) {
        var bx = cx + (rnd() - 0.5) * rw * 1.6;
        var by = cy + (rnd() - 0.5) * rh * 1.8;
        var br = Math.min(rw, rh) * (0.5 + rnd());
        var grad = g.createRadialGradient(bx, by, 0, bx, by, br);
        grad.addColorStop(0, 'rgba(255,255,255,0.85)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(bx, by, br * 1.6, br, 0, 0, 6.2832);
        g.fill();
      }
    }
  }

  function paintSun(g, w, h, rnd) {
    g.fillStyle = '#ffcf6e';
    g.fillRect(0, 0, w, h);
    for (var i = 0; i < 40; i++) {
      var x = rnd() * w, y = rnd() * h, r = h * (0.03 + rnd() * 0.09);
      g.fillStyle = rnd() < 0.5 ? 'rgba(255,240,190,0.25)' : 'rgba(255,150,60,0.22)';
      g.beginPath();
      g.ellipse(x, y, r * 1.6, r, 0, 0, 6.2832);
      g.fill();
    }
  }

  /* ---------- 场景 ---------- */

  var renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, alpha: true, antialias: true });
  } catch (e) {
    var rb2 = document.getElementById('solar-reset');
    if (rb2) rb2.style.display = 'none';
    return;
  }
  renderer.setClearColor(0x000000, 0);
  document.body.classList.add('solar3d-on');

  var scene = new THREE.Scene();
  var camera = new THREE.PerspectiveCamera(42, 1, 0.5, 5000);
  camera.position.set(0, 155, 405);
  camera.lookAt(0, 0, 0);

  var sunLight = new THREE.PointLight(0xfff3dd, 1.9, 0, 0);
  scene.add(sunLight);
  scene.add(new THREE.AmbientLight(0x90a0c8, 0.38));

  /* ---------- 太阳 ---------- */

  var sphereGeo = new THREE.SphereGeometry(1, 48, 32);
  var fragGeo = new THREE.SphereGeometry(1, 20, 14);

  /* ---------- 真实贴图（NASA 数据基准，Solar System Scope 2K，CC-BY-4.0） ----------
     优先加载本地 textures/，失败则保留程序化贴图。路径按脚本自身位置推算，
     保证首页与 posts/ 子页面都能命中。 */
  var TEX_BASE = (function () {
    var s = document.querySelector('script[src*="solar3d"]');
    if (!s) return "";
    var u = s.getAttribute("src");
    var i = u.indexOf("js/solar3d");
    return i > 0 ? u.slice(0, i) : "";
  })();

  var texLoader = new THREE.TextureLoader();
  texLoader.setCrossOrigin("anonymous");

  /* 贴图错峰加载队列：大 JPEG 同时解码会造成内存/GPU 峰值（低端机卡死根因），
     一次最多解码 2 张，间隔 120ms——总时长几乎不变，峰值减半 */
  var texQueue = [];
  var texActive = 0;

  function pumpTexQueue() {
    while (texActive < 2 && texQueue.length) {
      var job = texQueue.shift();
      texActive++;
      job(function () {
        texActive--;
        setTimeout(pumpTexQueue, 120);
      });
    }
  }

  function tryRealTex(file, material, obj) {
    if (!file) return;
    var revealed = false;
    /* 真图加载完成前不露脸，避免先闪一帧程序化贴图；
       加载失败或超时则回退显示程序化贴图 */
    if (obj && !REDUCED) obj.visible = false;
    var show = function () {
      if (revealed) return;
      revealed = true;
      if (obj) obj.visible = true;
    };
    /* 移动端自动映射 8k→2k（文件同名前缀替换） */
    var texFile = MOB.tex ? file.replace(/^8k_/, '2k_') : file;
    texQueue.push(function (done) {
      texLoader.load(
        TEX_BASE + "textures/" + texFile,
        function (t) {
          t.anisotropy = 2;
          material.map = t;
          material.needsUpdate = true;
          show();
          done();
        },
        undefined,
        function () { show(); done(); } /* 失败：显示程序化贴图 */
      );
    });
    pumpTexQueue();
    setTimeout(show, 2500);
  }

  var sun = new THREE.Mesh(
    sphereGeo,
    new THREE.MeshBasicMaterial({ map: makeMap(512, paintSun, 9) })
  );
  tryRealTex("8k_sun.jpg", sun.material, sun);
  sun.scale.setScalar(PARAMS.sunSize);
  scene.add(sun);

  function glowSprite(size, inner, outer) {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var g = c.getContext('2d');
    var grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, inner);
    grad.addColorStop(1, outer);
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    var sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: new THREE.CanvasTexture(c),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true
    }));
    sp.scale.setScalar(size);
    return sp;
  }

  var corona1 = glowSprite(PARAMS.sunSize * 9, 'rgba(255,200,110,0.55)', 'rgba(255,140,50,0)');
  var corona2 = glowSprite(PARAMS.sunSize * 3.4, 'rgba(255,244,214,0.85)', 'rgba(255,190,90,0)');
  scene.add(corona1);
  scene.add(corona2);
  var sunFlare = 0;

  /* ---------- 轨道线 ---------- */

  var orbitMat = new THREE.LineBasicMaterial({
    color: 0x7dd3fc, transparent: true, opacity: 0.12
  });
  var orbitLines = [];
  for (var oi = 0; oi < PLANETS.length; oi++) {
    var pts = [];
    for (var a = 0; a <= 128; a++) {
      var ang = (Math.PI * 2 * a) / 128;
      pts.push(new THREE.Vector3(Math.cos(ang) * PLANETS[oi].dist, 0, Math.sin(ang) * PLANETS[oi].dist));
    }
    var line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), orbitMat);
    orbitLines.push(line);
    scene.add(line);
  }

  /* ======================================================================
     小行星带（火星 110 — 木星 152 之间）：InstancedMesh 岩石群
     ====================================================================== */

  var BELT_INNER = 127, BELT_OUTER = 137;   // 收窄并避开火星(110)/木星(152)轨道
  var beltGroup = new THREE.Group();
  scene.add(beltGroup);

  var beltRocks = [];   // { instIdx, mesh, a, r, w, tilt, ph, selfRot, scl }
  function buildBelt() {
    var COUNT = MOB.beltN;   /* 精简：稀疏离散的碎石环（手机再减半） */
    var inst = new THREE.InstancedMesh(
      rockGeos[1],
      new THREE.MeshPhongMaterial({ map: fragTex, shininess: 2, flatShading: true }),
      COUNT
    );
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    beltGroup.add(inst);
    var M = new THREE.Matrix4();
    var Q = new THREE.Quaternion();
    var S = new THREE.Vector3();
    var E = new THREE.Euler();
    var P = new THREE.Vector3();
    var rnd2 = mulberry32(4242);
    for (var i = 0; i < COUNT; i++) {
      /* 主带分布：内密外疏 + 微椭率 + 少量离带漂离者 */
      var rr = BELT_INNER + Math.pow(rnd2(), 0.8) * (BELT_OUTER - BELT_INNER);
      var a = rnd2() * Math.PI * 2;
      var rock = {
        instIdx: i,
        a: a,
        r: rr,
        w: 0.10 + 0.10 * (BELT_OUTER / rr),   // 内快外慢的开普勒感
        tilt: (rnd2() - 0.5) * 0.16,
        ecc: 0.02 + rnd2() * 0.05,
        ph: rnd2() * Math.PI * 2,
        selfRot: (rnd2() - 0.5) * 1.2,
        rx: 0.22 + rnd2() * 0.5,
        ry: 0.18 + rnd2() * 0.4,
        rz: 0.22 + rnd2() * 0.5
      };
      beltRocks.push(rock);
      /* 初始摆放 */
      P.set(
        Math.cos(a) * rr,
        Math.sin(a * 2 + rock.ph) * 1.6,
        Math.sin(a) * rr
      );
      E.set(rnd2() * 3, rnd2() * 3, rnd2() * 3);
      Q.setFromEuler(E);
      S.set(rock.rx, rock.ry, rock.rz);
      M.compose(P, Q, S);
      inst.setMatrixAt(i, M);
    }
    inst.instanceMatrix.needsUpdate = true;
    beltGroup.userData.inst = inst;
  }

  var BELT_M = new THREE.Matrix4();
  var BELT_Q = new THREE.Quaternion();
  var BELT_S = new THREE.Vector3();
  var BELT_E = new THREE.Euler();
  var BELT_P = new THREE.Vector3();

  function stepBelt(dt) {
    if (!beltGroup.visible || REDUCED) return;
    var inst = beltGroup.userData.inst;
    if (!inst) return;
    for (var i = 0; i < beltRocks.length; i++) {
      var k = beltRocks[i];
      k.a += k.w * PARAMS.timeScale * dt;
      var wob = Math.sin(k.a * 2 + k.ph) * k.ecc * k.r;
      BELT_P.set(
        Math.cos(k.a) * (k.r + wob),
        Math.sin(k.a * 2 + k.ph) * 1.6,
        Math.sin(k.a) * (k.r - wob)
      );
      BELT_E.set(k.a * k.selfRot, k.a * k.selfRot * 0.7, 0);
      BELT_Q.setFromEuler(BELT_E);
      BELT_S.set(k.rx, k.ry, k.rz);
      BELT_M.compose(BELT_P, BELT_Q, BELT_S);
      inst.setMatrixAt(k.instIdx, BELT_M);
    }
    inst.instanceMatrix.needsUpdate = true;
  }

  /* ======================================================================
     引力场可视化：轨道面网格按引力势挠曲（时空弯曲观感）
     ====================================================================== */

  var GRAV_GRID = 64;                 // 64×64 网格
  var GRAV_SPAN = 560;                // 覆盖半径 280
  var gravGrid = null;                // 主层（受势能挠曲）
  var gravGrid2 = null;               // 浮层（抬高+更淡，制造立体视差）
  var gravRings = [];                 // 各行星井口的等势线圈
  var gravOn = false;

  function buildGravGrid() {
    function makeLayer(lift, opacity) {
      var geo = new THREE.PlaneGeometry(GRAV_SPAN, GRAV_SPAN, GRAV_GRID, GRAV_GRID);
      geo.rotateX(-Math.PI / 2);
      var colors = new Float32Array(geo.attributes.position.count * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      var mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        wireframe: true,
        transparent: true,
        opacity: opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      var m = new THREE.Mesh(geo, mat);
      m.userData.lift = lift;
      m.visible = false;
      scene.add(m);
      return m;
    }
    gravGrid = makeLayer(0, 0.55);
    gravGrid2 = makeLayer(26, 0.16);
  }
  buildGravGrid();

  /* 等势线圈：每个行星井口 3 圈下沉同心线（相对论图的等高线感） */
  function buildGravRings() {
    gravRings.forEach(function (r) { scene.remove(r.line); });
    gravRings = [];
    if (!gravOn) return;
    for (var j = 0; j < PLANETS.length; j++) {
      var pl = PLANETS[j];
      if (pl.mode === 'gone') continue;
      var well = Math.sqrt(PARAMS.sunGravity * PARAMS.planetGravity * pl.mass) * 0.16;
      for (var k = 0; k < 3; k++) {
        var rr = pl.r * 1.35 * (1.9 + k * 1.15);
        var seg = 64;
        var pts = [];
        for (var s = 0; s <= seg; s++) {
          var a = (Math.PI * 2 * s) / seg;
          var px = pl.group.position.x + Math.cos(a) * rr;
          var pz = pl.group.position.z + Math.sin(a) * rr;
          var dy = -well / (1 + k * 0.7);
          pts.push(new THREE.Vector3(px, dy - 2, pz));
        }
        var geo = new THREE.BufferGeometry().setFromPoints(pts);
        var mat = new THREE.LineBasicMaterial({
          color: 0x9d7bff, transparent: true,
          opacity: 0.5 - k * 0.13,
          blending: THREE.AdditiveBlending, depthWrite: false
        });
        var line = new THREE.Line(geo, mat);
        line.visible = gravOn;
        scene.add(line);
        gravRings.push({ line: line, planet: pl, idx: k, rr: rr, well: well });
      }
    }
  }

  var GRAV_TMP = new THREE.Vector3();

  function stepGravGrid(dt) {
    if (!gravOn || !gravGrid || REDUCED) return;

    /* 网格重建成本高，等势圈按需刷新（行星在动，每帧重建太贵——每 0.25s 重建一次） */
    gravRingTimer += dt;
    if (gravRingTimer > 0.25 || gravRingTimer < 0) {
      gravRingTimer = 0;
      buildGravRings();
    }

    var layers = [gravGrid, gravGrid2];
    for (var L = 0; L < layers.length; L++) {
      var mesh = layers[L];
      var lift = mesh.userData.lift;
      var pos = mesh.geometry.attributes.position;
      var col = mesh.geometry.attributes.color;
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i);
        var z = pos.getZ(i);
        var d0 = Math.sqrt(x * x + z * z);
        /* 史瓦西式势（1/r）→ 挠曲；太阳井 */
        var pot = PARAMS.sunGravity / Math.max(d0, 8);
        var holeDip = 0;
        for (var j = 0; j < PLANETS.length; j++) {
          var pl = PLANETS[j];
          if (pl.mode === 'gone' || pl.mode === 'drag') continue;
          var dx = x - pl.group.position.x;
          var dz = z - pl.group.position.z;
          var dp = Math.sqrt(dx * dx + dz * dz);
          var pr = pl.r * 1.35 * PARAMS.planetScale;
          var well = PARAMS.sunGravity * PARAMS.planetGravity * pl.mass;
          if (dp > pr) {
            pot += well / Math.max(dp, 6);
            /* 井内下压：天体半径内的网格沉到球底以下（行星坐在井口，线不穿球） */
            if (dp < pr * 1.35) {
              var sink = 1 - dp / (pr * 1.35);
              holeDip = Math.max(holeDip, sink * (pr * 2.6));
            }
          } else {
            holeDip = pr * 2.6;   /* 球正下方：直接沉底 */
          }
        }
        /* 太阳井同样避让 */
        var sunPr = PARAMS.sunSize * 1.15;
        if (d0 < sunPr) holeDip = Math.max(holeDip, (1 - d0 / sunPr) * PARAMS.sunSize * 2.2);

        var dip = -Math.sqrt(pot) * 0.62 - holeDip;
        pos.setY(i, Math.max(dip, -80) + lift);
        /* 颜色：浅势青蓝 → 深势亮紫白 */
        var t2 = Math.min(Math.sqrt(pot) / 26, 1);
        col.setXYZ(i, 0.18 + t2 * 0.8, 0.55 + t2 * 0.2, 0.95 - t2 * 0.12);
      }
      pos.needsUpdate = true;
      col.needsUpdate = true;
    }
  }
  var gravRingTimer = 0;

  function toggleGravField(force) {
    gravOn = (force !== undefined) ? !!force : !gravOn;
    if (gravGrid) gravGrid.visible = gravOn;
    if (gravGrid2) gravGrid2.visible = gravOn;
    if (gravOn) {
      buildGravRings();
    } else {
      gravRings.forEach(function (r) { scene.remove(r.line); });
      gravRings = [];
    }
    return gravOn;
  }

  /* ======================================================================
     银河天幕与深空星系：太阳系位于银河系内，背景是银河全景；
     远方再散布几座程序化螺旋星系（可观测的河外天体）
     ====================================================================== */

  var galaxyDome = new THREE.Mesh(
    new THREE.SphereGeometry(2600, 48, 32),
    new THREE.MeshBasicMaterial({
      side: THREE.BackSide,
      color: 0xffffff,
      opacity: 0,
      transparent: true,
      depthWrite: false
    })
  );
  scene.add(galaxyDome);
  texLoader.load(
    TEX_BASE + 'textures/' + (MOB.dome2k ? '2k_stars_milky_way.jpg' : '8k_stars_milky_way.jpg'),
    function (t) {
      galaxyDome.material.map = t;
      galaxyDome.material.opacity = 0.85;
      galaxyDome.material.needsUpdate = true;
    },
    undefined,
    function () { galaxyDome.material.opacity = 1; }
  );

  /* 程序化螺旋星系贴图（俯视旋臂） */
  function paintGalaxy(g, w, h, rnd, hueShift) {
    var cx = w / 2, cy = h / 2;
    var arms = 2 + ((rnd() * 2) | 0);
    /* 核心光晕 */
    var core = g.createRadialGradient(cx, cy, 0, cx, cy, w * 0.12);
    core.addColorStop(0, 'rgba(255,244,214,0.95)');
    core.addColorStop(0.5, 'rgba(255,220,170,0.5)');
    core.addColorStop(1, 'rgba(255,210,150,0)');
    g.fillStyle = core;
    g.fillRect(0, 0, w, h);
    /* 旋臂：沿对数螺线撒亮点 */
    for (var a = 0; a < arms; a++) {
      var base = (Math.PI * 2 * a) / arms;
      for (var k = 0; k < 260; k++) {
        var t2 = k / 260;
        var ang = base + t2 * 4.4;
        var rr = w * (0.04 + t2 * 0.42) * (0.92 + rnd() * 0.16);
        var x = cx + Math.cos(ang) * rr + (rnd() - 0.5) * w * 0.03;
        var y = cy + Math.sin(ang) * rr * 0.86 + (rnd() - 0.5) * w * 0.03;
        var s = 0.6 + rnd() * 1.8;
        var hue = 200 + hueShift + rnd() * 40;
        var al = 0.25 + rnd() * 0.5 * (1 - t2 * 0.5);
        g.fillStyle = 'hsla(' + hue + ',70%,' + (70 + rnd() * 25) + '%,' + al + ')';
        g.beginPath();
        g.arc(x, y, s, 0, 6.2832);
        g.fill();
      }
    }
    /* 零散尘埃 */
    for (var d = 0; d < 90; d++) {
      g.fillStyle = 'rgba(255,255,255,' + (0.04 + rnd() * 0.1) + ')';
      g.beginPath();
      g.arc(rnd() * w, rnd() * h, rnd() * 1.2, 0, 6.2832);
      g.fill();
    }
  }

  /* 远方星系：天幕内侧缓慢自转的精灵，距离远、小而精致 */
  var farGalaxies = [];
  (function buildFarGalaxies() {
    var rndG = mulberry32(777);
    var NGAL = 7;
    for (var i = 0; i < NGAL; i++) {
      var c = document.createElement('canvas');
      c.width = c.height = 256;
      var gctx = c.getContext('2d');
      paintGalaxy(gctx, 256, 256, function () { return rndG(); }, (rndG() - 0.5) * 80);
      var sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: new THREE.CanvasTexture(c),
        transparent: true,
        opacity: 0.55 + rndG() * 0.3,
        depthWrite: false
      }));
      var R = 1500 + rndG() * 700;
      var th = rndG() * Math.PI * 2;
      var ph2 = (rndG() - 0.5) * 1.7;
      sp.position.set(
        R * Math.cos(ph2) * Math.cos(th),
        R * Math.sin(ph2),
        R * Math.cos(ph2) * Math.sin(th)
      );
      var size = 90 + rndG() * 160;
      sp.scale.set(size, size, 1);
      sp.material.rotation = rndG() * Math.PI;
      scene.add(sp);
      farGalaxies.push(sp);
    }
  })();

  function toggleGravField(force) {
    gravOn = (force !== undefined) ? !!force : !gravOn;
    if (gravGrid) gravGrid.visible = gravOn;
    return gravOn;
  }

  /* ======================================================================
     太阳动态细节：日珥弧（磁力线）+ 点击喷流
     ====================================================================== */

  var prominences = [];   // 边缘磁力线弧，各自呼吸
  (function buildProminences() {
    var NPRO = 7;
    for (var i = 0; i < NPRO; i++) {
      var ang = (Math.PI * 2 * i) / NPRO + 0.4;
      var h = PARAMS.sunSize * (0.5 + Math.random() * 0.9);
      var w = PARAMS.sunSize * (0.5 + Math.random() * 0.5);
      /* 从表面 A 点拱起到 B 点的贝塞尔弧 */
      var ax = Math.cos(ang) * PARAMS.sunSize;
      var az = Math.sin(ang) * PARAMS.sunSize;
      var bx = Math.cos(ang + w / PARAMS.sunSize * 0.5) * PARAMS.sunSize;
      var bz = Math.sin(ang + w / PARAMS.sunSize * 0.5) * PARAMS.sunSize;
      var mx = (ax + bx) / 2, mz = (az + bz) / 2;
      var ml = Math.sqrt(mx * mx + mz * mz) || 1;
      var apexX = mx / ml * (PARAMS.sunSize + h);
      var apexZ = mz / ml * (PARAMS.sunSize + h);
      var curve = new THREE.QuadraticBezierCurve3(
        new THREE.Vector3(ax, 0, az),
        new THREE.Vector3(apexX, 0, apexZ),
        new THREE.Vector3(bx, 0, bz)
      );
      var pts = curve.getPoints(28);
      var geo = new THREE.BufferGeometry().setFromPoints(pts);
      var mat = new THREE.LineBasicMaterial({
        color: 0xffa04d, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false
      });
      var line = new THREE.Line(geo, mat);
      scene.add(line);
      prominences.push({
        line: line,
        ph: Math.random() * Math.PI * 2,
        sp: 0.3 + Math.random() * 0.5
      });
    }
  })();

  function stepProminences(dt, now) {
    for (var i = 0; i < prominences.length; i++) {
      var pr = prominences[i];
      var breath = Math.max(0, Math.sin(now * 0.001 * pr.sp + pr.ph));
      pr.line.material.opacity = breath * 0.55 * (0.5 + sunFlare);
    }
  }

  /* 点击喷流：从点击方向喷出的热粒子束 */
  var SUN_JET_N = 160;
  var sunJets = null;      // { points, pos[], vel[], life[] }
  (function buildSunJets() {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(
      new Float32Array(SUN_JET_N * 3), 3
    ));
    geo.setAttribute('size', new THREE.BufferAttribute(
      new Float32Array(SUN_JET_N), 1
    ));
    var mat = new THREE.PointsMaterial({
      color: 0xffc98a, size: 1.6, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    var pts = new THREE.Points(geo, mat);
    pts.visible = false;
    scene.add(pts);
    sunJets = {
      points: pts,
      pos: new Float32Array(SUN_JET_N * 3),
      vel: new Float32Array(SUN_JET_N * 3),
      life: new Float32Array(SUN_JET_N)
    };
  })();

  var JET_DIR = new THREE.Vector3();

  function fireSunJet(screenX, screenY) {
    /* 点击方向（屏幕 → 世界方向）作为喷流主轴 */
    updateNDC(screenX, screenY);
    raycaster.setFromCamera(pointerNDC, camera);
    /* 喷流方向：太阳表面随机（像自发耀斑，不跟随点击位置） */
    var jetAng = Math.random() * Math.PI * 2;
    JET_DIR.set(Math.cos(jetAng), 0, Math.sin(jetAng));
    var R = PARAMS.sunSize;
    for (var i = 0; i < SUN_JET_N; i++) {
      var spread = (Math.random() - 0.5) * 0.5;
      var dir = JET_DIR.clone().normalize();
      dir.x += spread * (Math.random() - 0.5);
      dir.y += (Math.random() - 0.3) * 0.35;
      dir.z += spread * (Math.random() - 0.5);
      dir.normalize();
      var sp = 26 + Math.random() * 42;
      var sx = dir.x * R * 1.02;
      var sy = dir.y * R * 1.02;
      var sz = dir.z * R * 1.02;
      sunJets.pos[i * 3] = sx;
      sunJets.pos[i * 3 + 1] = sy;
      sunJets.pos[i * 3 + 2] = sz;
      sunJets.vel[i * 3] = dir.x * sp;
      sunJets.vel[i * 3 + 1] = dir.y * sp;
      sunJets.vel[i * 3 + 2] = dir.z * sp;
      sunJets.life[i] = 0.9 + Math.random() * 0.7;
    }
    sunJets.points.visible = true;
  }

  function stepSunJets(dt) {
    if (!sunJets.points.visible) return;
    var any = false;
    for (var i = 0; i < SUN_JET_N; i++) {
      if (sunJets.life[i] <= 0) continue;
      any = true;
      sunJets.life[i] -= dt * 0.9;
      sunJets.vel[i * 3 + 1] -= 14 * dt;      /* 轻微回落（重力） */
      sunJets.pos[i * 3] += sunJets.vel[i * 3] * dt;
      sunJets.pos[i * 3 + 1] += sunJets.vel[i * 3 + 1] * dt;
      sunJets.pos[i * 3 + 2] += sunJets.vel[i * 3 + 2] * dt;
    }
    sunJets.points.geometry.attributes.position.array.set(sunJets.pos);
    sunJets.points.geometry.attributes.position.needsUpdate = true;
    var fade = 0;
    for (var j = 0; j < SUN_JET_N; j++) fade = Math.max(fade, sunJets.life[j]);
    sunJets.points.material.opacity = Math.min(0.95, fade);
    if (!any) sunJets.points.visible = false;
  }

  /* ---------- 行星 ---------- */

  var planetMeshes = [];   // 用于射线拾取的球体
  var i;
  for (i = 0; i < PLANETS.length; i++) {
    (function (p, idx) {
      var painters = {
        rocky: paintRocky,
        venus: paintVenus,
        earth: paintEarth,
        mars: paintMars,
        jup: paintBandsJup,
        sat: paintBandsSat,
        ura: function (g, w, h, r) { paintIce(g, w, h, r, false); },
        nep: function (g, w, h, r) { paintIce(g, w, h, r, true); }
      };

      /* 结构：group 负责位置与真实自转轴倾角；球体在 group 内单独缩放；
         环和月亮用绝对尺寸，不再继承球体缩放（否则会大十几倍） */
      var group = new THREE.Group();
      /* 真实轴倾角：天王星 97.8° 躺着转，金星 177.4° 逆行 */
      group.rotation.z = THREE.MathUtils.degToRad(p.tilt || 0);

      var body = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshPhongMaterial({
          map: makeMap(p.r >= 6 ? 1024 : 512, painters[p.tex], idx + 11),
          shininess: 6,
          specular: 0x333333
        })
      );
      body.scale.setScalar(p.r * 1.35);
      group.add(body);
      tryRealTex(p.file, body.material, group);

      /* 隐形拾取球（放大命中范围，visible 不影响射线检测） */
      var hit = new THREE.Mesh(
        sphereGeo,
        new THREE.MeshBasicMaterial({ visible: false })
      );
      hit.scale.setScalar(p.r * 1.35 * 2.1);
      hit.userData.planetIdx = idx;
      group.add(hit);
      planetMeshes.push(hit);

      if (p.ring) {
        /* 真实土星环：单环带径向条纹纹理（含卡西尼缝/恩克缝），UV 重映射为径向 */
        var ringTex = (function () {
          var c = document.createElement('canvas');
          c.width = 512; c.height = 8;
          var g = c.getContext('2d');
          /* 径向剖面：C 环暗 - B 环亮 - 卡西尼缝 - A 环 - 恩克缝 - F 环细线 */
          var stops = [
            [0.00, 'rgba(160,140,110,0.0)'],
            [0.05, 'rgba(186,166,132,0.42)'],
            [0.16, 'rgba(225,206,168,0.78)'],
            [0.38, 'rgba(245,228,188,0.96)'],
            [0.52, 'rgba(252,240,204,1.0)'],
            [0.60, 'rgba(70,64,56,0.14)'],   /* 卡西尼缝 */
            [0.63, 'rgba(70,64,56,0.12)'],
            [0.70, 'rgba(235,216,176,0.92)'], /* A 环 */
            [0.78, 'rgba(96,86,70,0.16)'],    /* 恩克缝 */
            [0.81, 'rgba(230,212,172,0.85)'],
            [0.93, 'rgba(198,180,144,0.45)'],
            [0.96, 'rgba(222,204,166,0.7)'],  /* F 环 */
            [1.00, 'rgba(200,182,148,0.0)']
          ];
          var grad = g.createLinearGradient(0, 0, 512, 0);
          for (var s2 = 0; s2 < stops.length; s2++) {
            grad.addColorStop(stops[s2][0], stops[s2][1]);
          }
          g.fillStyle = grad;
          g.fillRect(0, 0, 512, 8);
          /* 微细纹理：随机细线增加颗粒感 */
          for (var ln = 0; ln < 130; ln++) {
            var x = Math.random() * 512;
            g.fillStyle = 'rgba(255,244,220,' + (Math.random() * 0.08) + ')';
            g.fillRect(x, 0, 1, 8);
          }
          var t = new THREE.CanvasTexture(c);
          t.wrapS = THREE.ClampToEdgeWrapping;
          return t;
        })();

        var ringGeo = new THREE.RingGeometry(
          p.r * 1.35 * 1.4, p.r * 1.35 * 2.7, 96, 1
        );
        /* UV 重映射：x = 径向位置（贴 1D 纹理），y 恒 0.5 */
        (function remapRingUV(geo, inner, outer) {
          var pos = geo.attributes.position;
          var uv = geo.attributes.uv;
          for (var ri = 0; ri < pos.count; ri++) {
            var px = pos.getX(ri), pz = pos.getZ(ri);
            var rr = Math.sqrt(px * px + pz * pz);
            uv.setXY(ri, (rr - inner) / (outer - inner), 0.5);
          }
          uv.needsUpdate = true;
        })(ringGeo, p.r * 1.35 * 1.4, p.r * 1.35 * 2.7);

        var ringMesh = new THREE.Mesh(
          ringGeo,
          new THREE.MeshBasicMaterial({
            map: ringTex, transparent: true, side: THREE.DoubleSide,
            depthWrite: false, opacity: 0.96,
            blending: THREE.AdditiveBlending
          })
        );
        ringTex.wrapS = THREE.RepeatWrapping;
        ringMesh.rotation.x = -Math.PI / 2 + 0.42;
        group.add(ringMesh);
        p.ringMesh = ringMesh;
      }

      /* 天王星：细环系统（真实存在，垂直于 97.8° 轴） */
      if (p.en === 'URANUS') {
        var uRing = new THREE.Mesh(
          new THREE.RingGeometry(p.r * 1.35 * 1.65, p.r * 1.35 * 2.0, 64),
          new THREE.MeshBasicMaterial({
            color: 0xbfeaf2, transparent: true, opacity: 0.4,
            side: THREE.DoubleSide, depthWrite: false
          })
        );
        uRing.rotation.x = -Math.PI / 2;
        group.add(uRing);
        p.uraRing = uRing;
      }

      if (p.moon) {
        var moon = new THREE.Mesh(
          fragGeo,
          new THREE.MeshPhongMaterial({ map: makeMap(128, paintRocky, 77), shininess: 2 })
        );
        tryRealTex("8k_moon.jpg", moon.material, moon);
        moon.scale.setScalar(1.6);
        moon.userData.isMoon = true;
        group.add(moon);
        p.moonMesh = moon;

        /* ---- 地球卫星系统（挂在地球 group 内，位置每帧更新） ---- */

        var satMat = new THREE.MeshBasicMaterial({ color: 0xcfe6ff });
        var panelMat = new THREE.MeshBasicMaterial({ color: 0x3a5f9e });
        var BOX_GEO = new THREE.BoxGeometry(1, 1, 1);

        /* 卫星小模型：核心舱 + 双侧太阳能板，合并为一个几何（一次 draw call 造价） */
        var SAT_GEO = (function mergeSat() {
          function part(w, h, d, x, y, z) {
            var g = BOX_GEO.clone();
            g.scale(w, h, d);
            g.translate(x, y, z);
            return g.toNonIndexed();
          }
          var parts = [
            part(0.55, 0.28, 0.28, 0, 0, 0),      /* 核心舱 */
            part(0.08, 0.05, 0.9, 0, 0, 0),       /* 横梁 */
            part(0.03, 0.2, 0.4, 0, 0.13, -0.55), /* 左板 */
            part(0.03, 0.2, 0.4, 0, 0.13, 0.55)   /* 右板 */
          ];
          var total = parts.reduce(function (n, g) { return n + g.attributes.position.count; }, 0);
          var pos = new Float32Array(total * 3);
          var nor = new Float32Array(total * 3);
          var off = 0;
          parts.forEach(function (g) {
            pos.set(g.attributes.position.array, off * 3);
            nor.set(g.attributes.normal.array, off * 3);
            off += g.attributes.position.count;
          });
          var merged = new THREE.BufferGeometry();
          merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
          merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
          return merged;
        })();
        /* 两种材质按组拆分：核心壳体亮色、板深色 */
        SAT_GEO.clearGroups();
        SAT_GEO.addGroup(0, 72, 0);        /* 核心+横梁 36 顶点×2 面×… non-indexed 每 box 36 顶点 */
        SAT_GEO.addGroup(72, 144, 1);

        /* LEO 卫星群：60 颗，多倾角 */
        p.sats = [];
        var rndS = mulberry32(2026);
        for (var si = 0; si < MOB.satN; si++) {
          var sm = new THREE.Mesh(SAT_GEO, [satMat, panelMat]);
          sm.scale.setScalar(0.30 + rndS() * 0.14);
          group.add(sm);
          p.sats.push({
            mesh: sm,
            r: 7.5 + rndS() * 4,
            incl: (rndS() - 0.5) * 2.6,       // 各类倾角
            node: rndS() * Math.PI * 2,        // 升交点
            ph: rndS() * Math.PI * 2,
            w: 1.6 + rndS() * 1.4              // 角速度（视觉夸张）
          });
        }

        /* ISS：核心舱 + 双侧太阳能板，真实 51.6° 倾角 */
        var iss = new THREE.Group();
        var core = new THREE.Mesh(BOX_GEO, new THREE.MeshBasicMaterial({ color: 0xe8eef7 }));
        core.scale.set(1.5, 0.42, 0.42);
        iss.add(core);
        var beam = new THREE.Mesh(BOX_GEO, new THREE.MeshBasicMaterial({ color: 0x9fb4d0 }));
        beam.scale.set(0.12, 0.1, 2.6);
        iss.add(beam);
        var wingL = new THREE.Mesh(BOX_GEO, panelMat);
        wingL.scale.set(0.06, 0.55, 1.05);
        wingL.position.set(0, 0, -1.7);
        iss.add(wingL);
        var wingR = wingL.clone();
        wingR.position.z = 1.7;
        iss.add(wingR);
        group.add(iss);
        p.iss = { mesh: iss, r: 10.5, incl: 0.9, node: 1.2, ph: 0, w: 1.25 };

        /* 地球静止轨道环（细环）+ 3 颗静止卫星（跟随地球公转，相对地面静止） */
        var geoRing = new THREE.Mesh(
          new THREE.RingGeometry(17.6, 17.75, 96),
          new THREE.MeshBasicMaterial({
            color: 0x7dd3fc, transparent: true, opacity: 0.18,
            side: THREE.DoubleSide, depthWrite: false
          })
        );
        geoRing.rotation.x = -Math.PI / 2;
        group.add(geoRing);
        p.geoRing = geoRing;
        p.geoSats = [];
        for (var gs = 0; gs < 3; gs++) {
          var gsm = new THREE.Mesh(BOX_GEO, panelMat);
          gsm.scale.setScalar(0.3);
          group.add(gsm);
          p.geoSats.push({ mesh: gsm, ph: gs * 2.094 });
        }
      }

      /* 科学模式点云：与球体同几何的点精灵（渲染模式 points 时显示） */
      var points = new THREE.Points(
        sphereGeo,
        new THREE.PointsMaterial({
          color: 0x7dd3fc, size: 1.5, sizeAttenuation: true,
          transparent: true, opacity: 0.9, depthWrite: false
        })
      );
      points.scale.copy(body.scale);
      points.visible = false;
      group.add(points);
      p.points = points;

      /* 大气辉光壳：BackSide 加色球壳，只在实体模式显示 */
      if (p.atmo) {
        var shell = new THREE.Mesh(
          sphereGeo,
          new THREE.MeshBasicMaterial({
            color: 'rgb(' + p.atmo + ')', transparent: true, opacity: 0.15,
            side: THREE.BackSide, blending: THREE.AdditiveBlending, depthWrite: false
          })
        );
        shell.scale.copy(body.scale).multiplyScalar(1.14);
        group.add(shell);
        p.atmoShell = shell;
      }

      /* 地球专享：夜面城市灯光 + 真实 8K 云图 */
      if (p.tex === 'earth') {
        /* 城市灯光：emissiveMap 在背光面透出暖黄灯光 */
        body.material.emissive = new THREE.Color(0xffc98a);
        body.material.emissiveIntensity = 0.0;
        texLoader.load(
          TEX_BASE + 'textures/' + (MOB.dome2k ? '2k_earth_nightmap.jpg' : '8k_earth_nightmap.jpg'),
          function (t) {
            body.material.emissiveMap = t;
            body.material.emissiveIntensity = 1.15;
            body.material.needsUpdate = true;
          }
        );
        /* 真实云层（8k_earth_clouds 为白色云图，作 map + blending） */
        var clouds = new THREE.Mesh(
          sphereGeo,
          new THREE.MeshLambertMaterial({
            color: 0xffffff, transparent: true, opacity: 0.0,
            depthWrite: false
          })
        );
        clouds.scale.copy(body.scale).multiplyScalar(1.035);
        texLoader.load(
          TEX_BASE + 'textures/' + (MOB.dome2k ? '2k_earth_clouds.jpg' : '8k_earth_clouds.jpg'),
          function (t) {
            clouds.material.map = t;
            clouds.material.opacity = 0.92;
            clouds.material.needsUpdate = true;
          },
          undefined,
          function () {
            /* 云图下载失败：退回程序化云 */
            clouds.material.map = makeMap(512, paintClouds, 31);
            clouds.material.opacity = 0.85;
            clouds.material.needsUpdate = true;
          }
        );
        group.add(clouds);
        p.clouds = clouds;
      }

      scene.add(group);

      p.mode = 'orbit';        // orbit | drag | strain | physical | gone
      p.angle = p.phase;
      p.kick = 0;
      p.group = group;
      p.body = body;
      p.offX = 0;
      p.offZ = 0;
      p.ovX = 0;
      p.ovZ = 0;
      p.vel = new THREE.Vector3();
      p.spin = 0.35 + rnd01(idx + 50) * 0.5;
    })(PLANETS[i], i);
  }

  function rnd01(seed) {
    return mulberry32(seed * 131 + 7)();
  }

  /* ---------- 碎块 ---------- */

  /* ---------- 碎块：不规则岩块几何（顶点按位置哈希位移，共享顶点不开裂） ---------- */

  function vhash(x, y, z, k) {
    var s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7 + k * 53.7) * 43758.5453;
    return s - Math.floor(s);
  }

  var rockGeos = [];
  (function makeRocks() {
    for (var v = 0; v < 5; v++) {
      var g = new THREE.IcosahedronGeometry(1, 0);
      var pos = g.attributes.position;
      var wob = 0.5 + v * 0.08;
      for (var i = 0; i < pos.count; i++) {
        var x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        pos.setXYZ(
          i,
          x * (1 - wob / 2 + vhash(x, y, z, 1.3) * wob),
          y * (1 - wob / 2 + vhash(x, y, z, 7.7) * wob),
          z * (1 - wob / 2 + vhash(x, y, z, 13.1) * wob)
        );
      }
      g.computeVertexNormals();
      rockGeos.push(g);
    }
  })();

  var fragTex = makeMap(256, paintRocky, 5);
  var fragMat = new THREE.MeshPhongMaterial({
    map: fragTex, shininess: 3, flatShading: true
  });
  var fragHitMat = new THREE.MeshBasicMaterial({ visible: false });
  var fragments = [];   // { mesh, r, mass, pos, vel, grabbed, tgt, gv }

  /* 岩石几何与材质就绪后再铺设小行星带 */
  buildBelt();

  function addFragment(pos, vel, r, mass) {
    if (fragments.length >= MAX_FRAGS) {
      var old = fragments.shift();
      if (grab && grab.kind === 'frag' && grab.frag === old) grab = null;
      scene.remove(old.mesh);
    }
    var m = new THREE.Mesh(rockGeos[(Math.random() * rockGeos.length) | 0], fragMat);
    /* 非均匀缩放：每块岩块形状都不同 */
    m.scale.set(
      r * (0.8 + Math.random() * 0.4),
      r * (0.8 + Math.random() * 0.4),
      r * (0.8 + Math.random() * 0.4)
    );
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    scene.add(m);
    var fr = {
      mesh: m, r: r, mass: mass,
      pos: pos.clone(), vel: vel.clone(),
      grabbed: false,
      tgt: pos.clone(),
      gv: new THREE.Vector3()
    };
    /* 隐形拾取球：碎块太小，放大命中范围才好抓 */
    var hitS = new THREE.Mesh(sphereGeo, fragHitMat);
    hitS.scale.setScalar(3);
    hitS.userData.fragRef = fr;
    m.add(hitS);
    fr.hitMesh = hitS;
    fragments.push(fr);
    return fr;
  }

  /* ---------- 物理 ---------- */

  function gravityAt(pos, out, skip) {
    out.set(0, 0, 0);
    var d = new THREE.Vector3();
    /* 太阳 */
    d.copy(pos).multiplyScalar(-1);
    var r2 = d.lengthSq();
    if (r2 > 1) {
      out.addScaledVector(d.normalize(), PARAMS.sunGravity / r2);
    }
    /* 行星（质量各自不同） */
    for (var i = 0; i < PLANETS.length; i++) {
      var p = PLANETS[i];
      if (p === skip || p.mode === 'gone' || p.mode === 'drag') continue;
      var pp = planetWorldPos(p, TMP_A);
      d.copy(pos).sub(pp);
      var r2p = d.lengthSq();
      var rp = p.r * 1.35 + 2;
      if (r2p > rp * rp) {
        /* 行星引力与其质量成正比：木星这类大质量天体能明显捕获碎块与脱轨行星 */
        var gm = PARAMS.sunGravity * PARAMS.planetGravity * p.mass;
        out.addScaledVector(d.normalize(), -gm / r2p);
      }
    }
    return out;
  }

  var TMP_A = new THREE.Vector3();
  var TMP_B = new THREE.Vector3();
  var TMP_C = new THREE.Vector3();

  function planetWorldPos(p, out) {
    out.copy(p.group.position);
    return out;
  }

  function screenPosOf(worldVec) {
    var v = TMP_C.copy(worldVec).project(camera);
    return {
      x: Math.round((v.x + 1) / 2 * window.innerWidth),
      y: Math.round((-v.y + 1) / 2 * window.innerHeight),
      behind: v.z > 1
    };
  }

  function shatter(p, baseVel, obstaclePos, obstacleR) {
    var pos = planetWorldPos(p, new THREE.Vector3());
    /* 碎块必须出生在障碍物表面之外，否则下一帧就被吞掉 */
    var outDir = new THREE.Vector3();
    if (obstaclePos) outDir.copy(pos).sub(obstaclePos);
    if (outDir.lengthSq() < 0.01) outDir.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    outDir.normalize();

    /* 分级破碎：1-2 个大块 + 2-3 个中块 + 4-6 个渣渣（渣渣飞得更快） */
    var tiers = [
      { n: 1 + Math.floor(Math.random() * 2), s: [0.52, 0.68], v: [4, 8] },
      { n: 2 + Math.floor(Math.random() * 2), s: [0.3, 0.44], v: [7, 11] },
      { n: 4 + Math.floor(Math.random() * 3), s: [0.12, 0.22], v: [10, 17] }
    ];
    var spawned = 0;
    var spawnedList = [];
    /* 去掉母体速度中「朝向障碍物」的分量：否则坠日碎块刚弹出就被吸回吞掉，
       只保留切向速度（还能形成漂亮的溅射弧线） */
    var vin = baseVel.dot(outDir);
    var vAdj = baseVel.clone();
    if (vin < 0) vAdj.addScaledVector(outDir, -vin);
    for (var t = 0; t < tiers.length; t++) {
      for (var k = 0; k < tiers[t].n; k++) {
        var frac = tiers[t].s[0] + Math.random() * (tiers[t].s[1] - tiers[t].s[0]);
        var spd = tiers[t].v[0] + Math.random() * (tiers[t].v[1] - tiers[t].v[0]);
        var scatter = new THREE.Vector3(
          Math.random() - 0.5, (Math.random() - 0.5) * 0.5, Math.random() - 0.5
        ).normalize().multiplyScalar(0.7);
        var dir = outDir.clone().add(scatter).normalize();
        var v = vAdj.clone().multiplyScalar(0.35).addScaledVector(dir, spd);
        var spawn = pos.clone().addScaledVector(
          outDir, (obstacleR || 0) + p.r * 1.35 + 3 + Math.random() * 6
        );
        spawnedList.push([spawn, v, p.r * 1.35 * frac]);
        spawned++;
      }
    }
    for (var s2 = 0; s2 < spawnedList.length; s2++) {
      addFragment(spawnedList[s2][0], spawnedList[s2][1], spawnedList[s2][2], p.mass / spawned);
    }

    p.mode = 'gone';
    p.group.visible = false;

    var sp = screenPosOf(pos);
    window.dispatchEvent(new CustomEvent('starburst', {
      detail: { x: sp.x, y: sp.y, scale: 1.4 }
    }));
  }

  function absorbAt(pos, scale) {
    var sp = screenPosOf(pos);
    window.dispatchEvent(new CustomEvent('starburst', {
      detail: { x: sp.x, y: sp.y, scale: scale || 0.7 }
    }));
  }

  /* ---------- 指针 / 拖拽 ---------- */

  var pointerNDC = new THREE.Vector2(-10, -10);
  var pointerOn = false;
  var raycaster = new THREE.Raycaster();
  var dragPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var grab = null;      // { idx, kind: 'drag' | 'strain', moved, lastWorld, vel }
  var hovered = null;

  function updateNDC(x, y) {
    pointerNDC.x = (x / window.innerWidth) * 2 - 1;
    pointerNDC.y = -(y / window.innerHeight) * 2 + 1;
  }

  function pickFromNDC() {
    raycaster.setFromCamera(pointerNDC, camera);
    var objs = planetMeshes.slice();
    for (var f = 0; f < fragments.length; f++) objs.push(fragments[f].hitMesh);
    var hits = raycaster.intersectObjects(objs, false);
    for (var h = 0; h < hits.length; h++) {
      var u = hits[h].object.userData;
      if (u.planetIdx !== undefined && PLANETS[u.planetIdx].mode !== 'gone') {
        return { type: 'planet', planet: PLANETS[u.planetIdx] };
      }
      if (u.fragRef) return { type: 'frag', frag: u.fragRef };
    }
    return null;
  }

  function pickPlanet(x, y) {
    updateNDC(x, y);
    return pickFromNDC();
  }

  function pickSun(x, y) {
    updateNDC(x, y);
    raycaster.setFromCamera(pointerNDC, camera);
    var hits = raycaster.intersectObject(sun, false);
    return hits.length > 0;
  }

  function planePoint(x, y, out) {
    updateNDC(x, y);
    raycaster.setFromCamera(pointerNDC, camera);
    return raycaster.ray.intersectPlane(dragPlane, out);
  }

  function onPointerDown(x, y, target) {
    /* 自由模式：不选中任何星体，拖拽留给视角旋转 */
    if (PARAMS.mouseMode === 'free') return false;
    if (REDUCED) {
      if (pickSun(x, y)) { sunFlare = 1; return true; }
      return false;
    }
    var hit = pickPlanet(x, y);

    /* 碎块：直接可以抓走 */
    if (hit && hit.type === 'frag') {
      var fr = hit.frag;
      fr.grabbed = true;
      fr.tgt.copy(fr.pos);
      grab = { kind: 'frag', frag: fr, moved: 0, lx: x, ly: y, vx: 0, vy: 0 };
      document.body.style.cursor = 'grabbing';
      document.body.classList.add('no-select');
      return true;
    }

    if (hit && hit.type === 'planet') {
      var p = hit.planet;
      if (p.mass <= PARAMS.dragMass) {
        p.mode = 'drag';
        grab = { idx: PLANETS.indexOf(p), kind: 'drag', moved: 0, lastWorld: planetWorldPos(p, new THREE.Vector3()), vel: new THREE.Vector3() };
      } else {
        /* 大质量：拉不动，只能拉出一点形变 */
        p.mode = 'strain';
        grab = { idx: PLANETS.indexOf(p), kind: 'strain', moved: 0, lastWorld: null, vel: null };
      }
      document.body.style.cursor = grab.kind === 'drag' ? 'grabbing' : 'not-allowed';
      document.body.classList.add('no-select');
      return true;
    }

    if (pickSun(x, y)) {
      sunFlare = 1;
      fireSunJet(x, y);
      var sp = screenPosOf(sun.position);
      window.dispatchEvent(new CustomEvent('starburst', {
        detail: { x: sp.x, y: sp.y, scale: 1.8 }
      }));
      return true;
    }
    return false;
  }

  /* ---------- 还原 ---------- */

  function reset() {
    for (var i = 0; i < PLANETS.length; i++) {
      var p = PLANETS[i];
      p.mode = 'orbit';
      p.angle = p.phase;
      p.kick = 0;
      p.offX = 0;
      p.offZ = 0;
      p.ovX = 0;
      p.ovZ = 0;
      p.vel.set(0, 0, 0);
      p.group.visible = true;
    }
    for (var f = fragments.length - 1; f >= 0; f--) {
      fragments[f].grabbed = false;
      scene.remove(fragments[f].mesh);
    }
    fragments = [];
    grab = null;
    document.body.style.cursor = '';
    document.body.classList.remove('no-select');
    var sp = screenPosOf(sun.position);
    window.dispatchEvent(new CustomEvent('starburst', {
      detail: { x: sp.x, y: sp.y, scale: 1.2 }
    }));
  }

  window.addEventListener('solar-reset', reset);

  /* 导航栏「还原」按钮 */
  var resetBtn = document.getElementById('solar-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      window.dispatchEvent(new CustomEvent('solar-reset'));
    });
  }

  /* ---------- 主题 ---------- */

  var lastTheme = null;
  function applyTheme() {
    var dark = document.documentElement.dataset.theme !== 'dark' ? false : true;
    var op = dark ? PARAMS.orbitOpacity : PARAMS.orbitOpacity + 0.04;
    if (dark === lastTheme && Math.abs(orbitMat.opacity - op) < 0.001) return;
    lastTheme = dark;
    orbitMat.color.setHex(dark ? 0x7dd3fc : 0x4338ca);
    orbitMat.opacity = op;
  }

  /* ---------- 尺寸 ---------- */

  var camDist = 434;          // 相机到太阳的距离，随视口自适应
  var CAM_DIR = { x: 0, y: 0.357, z: 0.934 };  // ≈ (0,155,405) 归一化

  function computeCamDist() {
    /* 让海王星轨道（含余量）在横向和纵向都完整可见 */
    var R = 305;
    var halfTan = Math.tan((42 / 2) * Math.PI / 180);
    var dW = R / (halfTan * camera.aspect);
    var dH = (R * 0.42) / halfTan;
    camDist = Math.max(dW, dH, 340) * 1.02;
  }

  function resize() {
    var w = window.innerWidth;
    var h = window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, MOB.dpr));
    /* 必须更新 CSS 尺寸（默认参数）：否则在系统缩放 125%/150%（dpr≠1）下
       画布按属性尺寸铺开，整个太阳系会相对屏幕偏移，拾取与画面错位 */
    renderer.setSize(w, h);
    camera.aspect = w / h;
    computeCamDist();
    camera.updateProjectionMatrix();
  }

  window.addEventListener('resize', resize);
  resize();

  /* ---------- 主循环 ---------- */

  var lastT = 0;
  var raf = null;
  var running = false;
  var parX = 0, parY = 0, parTX = 0, parTY = 0;
  var panX = 0, panTarget = 0;

  /* 自由模式相机：方位角/仰角/距离/注视点（地图式导航），与轨道视角平滑混合 */
  var freeCam = {
    az: 0, el: 0.365, dist: 470,
    target: new THREE.Vector3(0, 0, 0)
  };
  var camBlend = 0;
  var fcDrag = null;
  var CAM_ORBIT_A = new THREE.Vector3();
  var CAM_FREE_A = new THREE.Vector3();
  var CAM_TMP = new THREE.Vector3();

  /* ---------- 飞行模式（第一人称飞船） ---------- */

  var flight = {
    on: false,
    pos: new THREE.Vector3(0, 70, 340),
    yaw: 0,
    pitch: -0.16,
    vel: new THREE.Vector3(),
    keys: {},
    steering: false,
    sx: 0,
    sy: 0,
    el: null,
    throttle: 0,
    hudTick: 0
  };

  camera.rotation.order = 'YXZ';
  var FLIGHT_ACC = 320;
  var FLIGHT_BOOST = 2.8;

  var FLIGHT_TMP = new THREE.Vector3();
  var FLIGHT_Q = new THREE.Quaternion();
  var FLIGHT_E = new THREE.Euler(0, 0, 0, 'YXZ');

  function stepFlight(dt) {
    var f = flight;

    /* 副驾驶接管时先算制导（覆盖键位与姿态） */
    if (pilot.on) pilotStep(dt);

    /* 加速度：W/S 前后，A/D 侧移，Shift 加速 */
    FLIGHT_TMP.set(
      (f.keys.d ? 1 : 0) - (f.keys.a ? 1 : 0),
      0,
      (f.keys.s ? 1 : 0) - (f.keys.w ? 1 : 0)
    );
    if (FLIGHT_TMP.lengthSq() > 0) {
      FLIGHT_E.set(f.pitch, f.yaw, 0);
      FLIGHT_Q.setFromEuler(FLIGHT_E);
      FLIGHT_TMP.normalize()
        .multiplyScalar(FLIGHT_ACC * (f.keys.shift ? FLIGHT_BOOST : 1))
        .applyQuaternion(FLIGHT_Q);
      f.vel.addScaledVector(FLIGHT_TMP, dt);
    }

    /* 阻尼 + 位移 */
    f.vel.multiplyScalar(Math.pow(0.22, dt));
    f.pos.addScaledVector(f.vel, dt);

    /* 不许钻进太阳，别飞丢 */
    var r = f.pos.length();
    if (r < PARAMS.sunSize + 12) {
      f.pos.multiplyScalar((PARAMS.sunSize + 12) / r);
      f.vel.multiplyScalar(-0.25);
    } else if (r > 2400) {
      f.pos.multiplyScalar(2400 / r);
    }

    camera.position.copy(f.pos);
    camera.rotation.set(f.pitch, f.yaw, 0);

    /* 驾驶舱仪表联动（速度 / 航向 / 姿态仪 / 推力条 / 玻璃高光） */
    if (f.el && (++f.hudTick % 3 === 0)) {
      var spd = Math.round(f.vel.length());
      f.el.speed.textContent = spd;
      var hdgDeg = ((-f.yaw * 57.2958) % 360 + 360) % 360;
      f.el.hdg.textContent = (hdgDeg < 100 ? '0' : '') + (hdgDeg < 10 ? '0' : '') + Math.round(hdgDeg);
      f.el.attitude.style.transform = 'translateY(' + (f.pitch * 42).toFixed(1) + 'px)';
      f.el.heading.style.transform = 'translateX(' + ((-hdgDeg * 1.6) % 96).toFixed(1) + 'px)';
      var thr = 0;
      if (f.keys.w) thr = f.keys.shift ? 1 : 0.62;
      else if (f.keys.s) thr = 0.25;
      f.throttle += (thr - f.throttle) * 0.25;
      f.el.bar.style.height = Math.max(4, Math.round(f.throttle * 100)) + '%';
      f.el.glass.style.transform = 'translateX(' + (f.yaw * 10).toFixed(1) + 'px)';
    }
  }

  function buildHud(on) {
    var hud = document.getElementById('flight-hud');
    if (on && !hud) {
      hud = document.createElement('div');
      hud.id = 'flight-hud';
      hud.innerHTML =
        '<div class="fh-glass"></div>' +
        '<div class="fh-strut tl"></div><div class="fh-strut tr"></div>' +
        '<div class="fh-strut bl"></div><div class="fh-strut br"></div>' +
        '<div class="fh-panel">' +
          '<div class="fh-attitude"><div class="fh-skyground"><div class="fh-sky"></div><div class="fh-ground"></div><div class="fh-horizonline"></div></div></div>' +
          '<div class="fh-gauges">' +
            '<div>SPD <b class="fh-speed">0</b></div>' +
            '<div>HDG <b class="fh-hdg">000</b></div>' +
            '<div class="fh-headingwrap"><div class="fh-heading"></div></div>' +
          '</div>' +
          '<div class="fh-throttle"><div class="fh-bar"></div></div>' +
        '</div>' +
        '<div class="fh-cross"></div>' +
        '<div class="fh-hint">W/S 前后 · A/D 侧移 · 按住拖拽转向 · SHIFT 加速 · ESC 退出</div>';
      document.body.appendChild(hud);
      flight.el = {
        hud: hud,
        glass: hud.querySelector('.fh-glass'),
        speed: hud.querySelector('.fh-speed'),
        hdg: hud.querySelector('.fh-hdg'),
        heading: hud.querySelector('.fh-heading'),
        attitude: hud.querySelector('.fh-skyground'),
        bar: hud.querySelector('.fh-bar')
      };
    } else if (!on && hud) {
      hud.remove();
      flight.el = null;
    }
  }

  function updateFlightBtn() {
    if (flightBtn) {
      flightBtn.setAttribute('aria-pressed', flight.on ? 'true' : 'false');
    }
  }

  function enterFlight() {
    flight.on = true;
    document.body.classList.add('flight-mode');
    flight.pos.set(0, 70, 340);
    flight.yaw = 0;
    flight.pitch = -0.16;
    flight.vel.set(0, 0, 0);
    flight.keys = {};
    buildHud(true);
    updateFlightBtn();
  }

  function exitFlight() {
    flight.on = false;
    document.body.classList.remove('flight-mode');
    buildHud(false);
    updateFlightBtn();
  }

  window.addEventListener('keydown', function (e) {
    if (!flight.on) return;
    var k = e.key.toLowerCase();
    if (k === 'escape') {
      exitFlight();
      return;
    }
    if (k === 'shift') flight.keys.shift = true;
    else if (k === 'w' || k === 'a' || k === 's' || k === 'd') {
      flight.keys[k] = true;
      pilotCancel();
    }
  });

  window.addEventListener('keyup', function (e) {
    var k = e.key.toLowerCase();
    if (k === 'shift') delete flight.keys.shift;
    else delete flight.keys[k];
  });

  /* 飞行中按住拖拽 = 转向（手动操作打断副驾驶） */
  window.addEventListener('pointerdown', function (e) {
    if (!flight.on) return;
    if (e.target && e.target.closest && e.target.closest('button, a')) return;
    pilotCancel();
    flight.steering = true;
    flight.sx = e.clientX;
    flight.sy = e.clientY;
  }, { passive: true });

  window.addEventListener('pointermove', function (e) {
    if (!flight.on || !flight.steering) return;
    flight.yaw -= (e.clientX - flight.sx) * 0.0032;
    flight.pitch -= (e.clientY - flight.sy) * 0.0032;
    if (flight.pitch > 1.35) flight.pitch = 1.35;
    if (flight.pitch < -1.35) flight.pitch = -1.35;
    flight.sx = e.clientX;
    flight.sy = e.clientY;
  }, { passive: true });

  function stopSteering() { flight.steering = false; }
  window.addEventListener('pointerup', stopSteering, { passive: true });
  window.addEventListener('pointercancel', stopSteering, { passive: true });

  /* 飞行模式入口按钮（由脚本注入，无需改 HTML） */
  var flightBtn = null;
  if (!REDUCED) {
    flightBtn = document.createElement('button');
    flightBtn.id = 'flight-toggle';
    flightBtn.type = 'button';
    flightBtn.className = 'flight-toggle';
    flightBtn.setAttribute('aria-pressed', 'false');
    flightBtn.title = '进入飞船，第一人称遨游太阳系';
    flightBtn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 15l-3-3c.5-1.3 1.4-3.6 3.2-5.4C15 3.8 19 2.5 21.5 2.5c0 2.5-1.3 6.5-4.1 9.3-1.8 1.8-4.1 2.7-5.4 3.2z"/>' +
      '<path d="M4.5 16.5c-1.5 1.5-2 5-2 5s3.5-.5 5-2c.8-.8.8-2.2 0-3-.8-.8-2.2-.8-3 0z"/>' +
      '</svg><span>飞行模式</span>';
    /* 有漂浮按钮的页面让出右下角第一排 */
    flightBtn.style.bottom = document.getElementById('float-toggle') ? '86px' : '22px';
    flightBtn.addEventListener('click', function () {
      if (flight.on) exitFlight();
      else enterFlight();
    });
    document.body.appendChild(flightBtn);
  }

  window.addEventListener('pointermove', function (e) {
    pointerOn = true;
    parTX = (e.clientX / window.innerWidth - 0.5) * 2;
    parTY = (e.clientY / window.innerHeight - 0.5) * 2;

    if (grab && grab.kind === 'drag') {
      var p = PLANETS[grab.idx];
      var target = new THREE.Vector3();
      if (planePoint(e.clientX, e.clientY, target)) {
        var rr = Math.max(28, Math.min(600, Math.sqrt(target.x * target.x + target.z * target.z)));
        var a = Math.atan2(target.z, target.x);
        var nx = Math.cos(a) * rr;
        var nz = Math.sin(a) * rr;
        grab.moved += Math.abs(nx - p.group.position.x) + Math.abs(nz - p.group.position.z);
        /* 指针速度（松手时的甩出初速） */
        grab.vel.lerp(TMP_B.set(nx - p.group.position.x, 0, nz - p.group.position.z).multiplyScalar(45), 0.35);
        /* 惯性跟随：不是瞬移，向目标点缓缓加速跟上 */
        p.group.position.x += (nx - p.group.position.x) * 0.14;
        p.group.position.z += (nz - p.group.position.z) * 0.14;
      }
    } else if (grab && grab.kind === 'frag') {
      var fr2 = grab.frag;
      var t3 = new THREE.Vector3();
      if (planePoint(e.clientX, e.clientY, t3)) {
        var rr3 = Math.max(22, Math.min(700, Math.sqrt(t3.x * t3.x + t3.z * t3.z)));
        var a3 = Math.atan2(t3.z, t3.x);
        var nx3 = Math.cos(a3) * rr3;
        var nz3 = Math.sin(a3) * rr3;
        grab.moved += Math.abs(nx3 - fr2.tgt.x) + Math.abs(nz3 - fr2.tgt.z);
        grab.vx = nx3 - fr2.tgt.x;
        grab.vy = nz3 - fr2.tgt.z;
        fr2.gv.lerp(new THREE.Vector3(nx3 - fr2.tgt.x, 0, nz3 - fr2.tgt.z).multiplyScalar(45), 0.35);
        fr2.tgt.set(nx3, 0, nz3);
      }
    } else if (grab && grab.kind === 'strain') {
      var q = PLANETS[grab.idx];
      var t2 = new THREE.Vector3();
      if (planePoint(e.clientX, e.clientY, t2)) {
        var dx = t2.x - q.group.position.x;
        var dz = t2.z - q.group.position.z;
        var dl = Math.sqrt(dx * dx + dz * dz) || 1;
        var pull = Math.min(9, dl * 0.12);
        q.offX = dx / dl * pull;
        q.offZ = dz / dl * pull;
        grab.moved += 1;
      }
    }
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    pointerOn = true;
  }, { passive: true });

  function releasePointer() {
    if (!grab) return;
    if (grab.kind === 'frag') {
      var fr = grab.frag;
      fr.grabbed = false;
      if (grab.moved < 3) {
        /* 原地轻点：给碎块一个小弹跳脉冲 */
        fr.vel.add(new THREE.Vector3(
          Math.random() - 0.5, (Math.random() - 0.5) * 0.4, Math.random() - 0.5
        ).normalize().multiplyScalar(6 + fr.r * 2));
      } else {
        fr.vel.copy(fr.gv).clampLength(0, 30);
      }
    } else {
      var p = PLANETS[grab.idx];
      if (grab.kind === 'drag') {
        if (grab.moved < 4) {
          /* 原地轻点：回到轨道并加速 */
          p.mode = 'orbit';
          p.kick = Math.min((p.kick || 0) + 1.5, 4);
        } else {
          /* 甩出：进入引力场，按当前速度惯性运动（限速让轨迹弯曲更明显） */
          p.mode = 'physical';
          p.vel.copy(grab.vel).clampLength(0, PARAMS.releaseSpeed);
        }
      } else {
        /* 大质量：松手弹回轨道 */
        p.mode = 'orbit';
      }
    }
    grab = null;
    document.body.style.cursor = '';
    document.body.classList.remove('no-select');
  }

  window.addEventListener('pointerup', releasePointer, { passive: true });
  window.addEventListener('pointercancel', releasePointer, { passive: true });
  window.addEventListener('mouseup', releasePointer, { passive: true });

  /* 触摸设备：抓着天体拖动时阻止页面滚动（passive:false 才能阻止） */
  document.addEventListener('touchmove', function (e) {
    if (grab) e.preventDefault();
  }, { passive: false });

  document.addEventListener('pointerleave', function () { pointerOn = false; });
  window.addEventListener('blur', function () { pointerOn = false; });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop();
    else start();
  });

  /* ---------- 自由模式视角控制（拖拽旋转 / 滚轮缩放） ---------- */

  function inPanel(t) {
    return !!(t && t.closest && t.closest(
      '#tune-panel, #copilot, .site-header, .site-footer, button, a, input'
    ));
  }

  window.addEventListener('pointerdown', function (e) {
    if (PARAMS.mouseMode !== 'free' || flight.on || REDUCED) return;
    if (inPanel(e.target)) return;
    fcDrag = { x: e.clientX, y: e.clientY, az: freeCam.az, el: freeCam.el };
  }, { passive: true });

  window.addEventListener('pointermove', function (e) {
    if (!fcDrag) return;
    /* 反向：抓住星空拖动（拖右 → 视角向左转），手感更像拖拽场景本身 */
    freeCam.az = fcDrag.az - (e.clientX - fcDrag.x) * 0.005;
    freeCam.el = Math.max(-1.2, Math.min(
      1.35, fcDrag.el - (e.clientY - fcDrag.y) * 0.004
    ));
  }, { passive: true });

  window.addEventListener('pointerup', function () { fcDrag = null; }, { passive: true });

  var wheelRay = new THREE.Raycaster();
  var wheelPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  var wheelHit = new THREE.Vector3();

  window.addEventListener('wheel', function (e) {
    if (PARAMS.mouseMode !== 'free' || flight.on || REDUCED) return;
    if (inPanel(e.target)) return;
    e.preventDefault();

    var oldDist = freeCam.dist;
    var newDist = Math.max(10, Math.min(1500,
      oldDist * (e.deltaY > 0 ? 1.1 : 0.9)
    ));
    freeCam.dist = newDist;

    /* 地图式缩放：把视线中心（target）朝光标指向的轨道面位置推移，
       越滚越凑近光标处，而不是永远围着太阳转 */
    updateNDC(e.clientX, e.clientY);
    wheelRay.setFromCamera(pointerNDC, camera);
    var k = 1 - newDist / oldDist;
    if (wheelRay.ray.intersectPlane(wheelPlane, wheelHit)) {
      freeCam.target.addScaledVector(
        wheelHit.clone().sub(freeCam.target), k
      );
    } else {
      /* 相机在轨道面下方仰视等情形：沿射线水平方向兜底推移 */
      var d3 = wheelRay.ray.direction;
      var dxz = Math.sqrt(d3.x * d3.x + d3.z * d3.z);
      if (dxz > 0.001) {
        freeCam.target.x += (d3.x / dxz) * oldDist * k;
        freeCam.target.z += (d3.z / dxz) * oldDist * k;
      }
    }
    if (freeCam.target.length() > 620) freeCam.target.setLength(620);
  }, { passive: false });

  var acc = new THREE.Vector3();

  function step(dt, now) {
    applyTheme();

    /* 小行星带 & 引力场网格 */
    stepBelt(dt);
    stepGravGrid(dt);

    /* ---------- 相机 ---------- */
    var visW = 2 * Math.tan((42 / 2) * Math.PI / 180) * camDist * camera.aspect;

    if (flight.on) {
      /* 飞行模式：第一人称飞船 */
      stepFlight(dt);
    } else {
      /* 轨道视角：默认宽屏太阳系在右侧（内容在左）；
         调节台打开 → 移到中左（右侧面板不遮模型）；
         漂浮/飞行 → 回正居中 */
      var wide = window.innerWidth > 980;
      var tuneOpen = document.body.classList.contains('tune-open');
      var centered = document.body.classList.contains('float-mode');
      if (tuneOpen) {
        var panelW = Math.min(330, window.innerWidth * 0.88);
        panTarget = (panelW / (2 * window.innerWidth)) * visW;
      } else if (centered || !wide) {
        panTarget = 0;
      } else {
        panTarget = -0.21 * visW;
      }
      panX += (panTarget - panX) * 0.06;

      if (!pointerOn) { parTX = 0; parTY = 0; }
      parX += (parTX - parX) * 0.04;
      parY += (parTY - parY) * 0.04;

      /* 自由模式（拖拽旋转/滚轮缩放）与轨道视角平滑混合 */
      var tb = PARAMS.mouseMode === 'free' ? 1 : 0;
      camBlend += (tb - camBlend) * 0.08;
      if (camBlend < 0.001) camBlend = 0;
      if (camBlend >= 0.999) camBlend = 1;

      CAM_ORBIT_A.set(
        parX * 24 * PARAMS.parallax,
        CAM_DIR.y * camDist - parY * 16 * PARAMS.parallax,
        CAM_DIR.z * camDist
      );
      var fr = freeCam.dist;
      var fce = Math.cos(freeCam.el);
      CAM_FREE_A.set(
        freeCam.target.x + Math.sin(freeCam.az) * fce * fr,
        freeCam.target.y + Math.sin(freeCam.el) * fr,
        freeCam.target.z + Math.cos(freeCam.az) * fce * fr
      );

      if (camBlend >= 1) {
        camera.position.copy(CAM_FREE_A);
        camera.lookAt(freeCam.target);
      } else {
        camera.position.lerpVectors(CAM_ORBIT_A, CAM_FREE_A, camBlend);
        CAM_TMP.set(
          freeCam.target.x * camBlend + panX * (1 - camBlend), 0, 0
        );
        camera.lookAt(CAM_TMP);
      }
    }

    sun.rotation.y += dt * 0.05;
    sunFlare *= 0.95;
    var coronaScale = 1 + 0.03 * Math.sin(now * 0.002) + sunFlare * 0.6;
    sun.scale.setScalar(PARAMS.sunSize);
    corona1.scale.setScalar(PARAMS.sunSize * 9 * coronaScale);
    corona2.scale.setScalar(PARAMS.sunSize * 3.4 * coronaScale);

    /* 太阳表面流动：贴图 UV 缓慢横移 + 呼吸（米粒组织涌动感） */
    if (sun.material.map) {
      sun.material.map.offset.x = (now * 0.000012) % 1;
      sun.material.map.offset.y = Math.sin(now * 0.0004) * 0.004;
    }

    /* 日珥：边缘的磁力线弧，周期性亮起与回落 */
    stepProminences(dt, now);

    /* 太阳喷流粒子（点击触发） */
    stepSunJets(dt);

    /* 行星 */
    for (var i = 0; i < PLANETS.length; i++) {
      var p = PLANETS[i];

      if (p.mode === 'orbit' || p.mode === 'strain') {
        p.kick *= 0.985;
        p.angle += 0.132 * p.speed * (1 + p.kick * 2.2) * PARAMS.timeScale * dt;
        /* 大质量形变的弹簧回正 */
        p.ovX += -p.offX * 6 * dt;
        p.ovZ += -p.offZ * 6 * dt;
        p.ovX *= 0.86;
        p.ovZ *= 0.86;
        p.offX += p.ovX;
        p.offZ += p.ovZ;
        p.group.position.set(
          Math.cos(p.angle) * p.dist + p.offX, 0,
          Math.sin(p.angle) * p.dist + p.offZ
        );
      } else if (p.mode === 'physical') {
        /* 物理演化同样受时间流速控制（timeScale=0 时万物静止） */
        var pdt = dt * PARAMS.timeScale;
        gravityAt(p.group.position, acc, p);
        p.vel.addScaledVector(acc, pdt);
        p.group.position.addScaledVector(p.vel, pdt);
        if (p.group.position.length() > DESPAWN_R) {
          p.mode = 'gone';
          p.group.visible = false;
        }
      }
      /* drag 模式位置由指针直接控制 */

      if (p.mode !== 'gone') {
        p.body.rotation.y += dt * p.spin * PARAMS.timeScale;
        p.body.scale.setScalar(p.r * 1.35 * PARAMS.planetScale);
        p.points.scale.copy(p.body.scale);

        /* 行星专属微动态：大气的流动（贴图 UV 缓慢漂移） */
        if (p.texFlow && p.body.material.map) {
          p.body.material.map.offset.x =
            (p.body.material.map.offset.x + p.texFlow * dt * PARAMS.timeScale) % 1;
        }
        /* 土星环：冰晶反光呼吸 + 环带径向流动（物质在环内迁徙的观感） */
        if (p.ringMesh) {
          p.ringMesh.material.opacity = 0.88 + Math.sin(now * 0.0009) * 0.08;
          if (p.ringMesh.material.map) {
            p.ringMesh.material.map.offset.x =
              Math.sin(now * 0.00025) * 0.035;
          }
        }

        if (p.atmoShell) {
          p.atmoShell.scale.copy(p.body.scale).multiplyScalar(1.14);
        }
        if (p.clouds) {
          p.clouds.scale.copy(p.body.scale).multiplyScalar(1.04);
          p.clouds.rotation.y += dt * p.spin * 0.55 * PARAMS.timeScale;
        }
        if (p.moonMesh) {
          p.moonMesh.position.set(Math.cos(now * 0.0012) * 11, 0, Math.sin(now * 0.0012) * 11);
        }
        /* 卫星群 / ISS / 静止卫星 */
        if (p.sats) {
          for (var sw = 0; sw < p.sats.length; sw++) {
            var s3 = p.sats[sw];
            s3.ph += s3.w * PARAMS.timeScale * dt;
            var cx = Math.cos(s3.ph) * s3.r;
            var cz = Math.sin(s3.ph) * s3.r;
            var ci = Math.cos(s3.incl), si2 = Math.sin(s3.incl);
            var cn = Math.cos(s3.node), sn = Math.sin(s3.node);
            s3.mesh.position.set(
              cx * cn - cz * si2 * sn,
              cz * ci,
              cx * sn + cz * si2 * cn
            );
            /* 卫星缓慢自转（太阳能板扫光的感觉） */
            s3.mesh.rotation.y += dt * 0.6 * PARAMS.timeScale;
          }
        }
        if (p.iss) {
          var io = p.iss;
          io.ph += io.w * PARAMS.timeScale * dt;
          var ix = Math.cos(io.ph) * io.r;
          var iz = Math.sin(io.ph) * io.r;
          var ici = Math.cos(io.incl), isi = Math.sin(io.incl);
          var icn = Math.cos(io.node), isn = Math.sin(io.node);
          io.mesh.position.set(
            ix * icn - iz * isi * isn,
            iz * ici,
            ix * isn + iz * isi * icn
          );
          io.mesh.rotation.y = -io.ph;
        }
        if (p.geoSats) {
          /* 静止卫星：与地球自转同步（相对地面不动） */
          for (var g2 = 0; g2 < p.geoSats.length; g2++) {
            var gsat = p.geoSats[g2];
            gsat.mesh.position.set(
              Math.cos(gsat.ph) * 17.7, 0.4, Math.sin(gsat.ph) * 17.7
            );
          }
        }
      }
    }

    /* 碎块 */
    for (var f = fragments.length - 1; f >= 0; f--) {
      var fr = fragments[f];

      if (fr.grabbed) {
        /* 被抓住：惯性缓动跟随指针目标点 */
        fr.pos.lerp(fr.tgt, 0.16);
        fr.mesh.position.copy(fr.pos);
        fr.mesh.rotation.y += dt * 0.4;
        continue;
      }

      gravityAt(fr.pos, acc, null);
      fr.vel.addScaledVector(acc, dt);
      fr.pos.addScaledVector(fr.vel, dt);
      fr.mesh.position.copy(fr.pos);
      fr.mesh.rotation.y += dt * 0.8;
      fr.mesh.rotation.x += dt * 0.3;

      /* 撞太阳：吞并 */
      if (fr.pos.length() < PARAMS.sunSize + fr.r) {
        sunFlare = Math.max(sunFlare, 0.4);
        absorbAt(fr.pos, 0.5);
        scene.remove(fr.mesh);
        fragments.splice(f, 1);
        continue;
      }
      /* 撞行星：吞并 */
      var hit = false;
      for (var k = 0; k < PLANETS.length; k++) {
        var hp = PLANETS[k];
        if (hp.mode === 'gone' || hp.mode === 'drag') continue;
        if (fr.pos.distanceTo(hp.group.position) < hp.r * 1.35 + fr.r) {
          absorbAt(fr.pos, 0.5);
          scene.remove(fr.mesh);
          fragments.splice(f, 1);
          hit = true;
          break;
        }
      }
      if (hit) continue;

      if (fr.pos.length() > DESPAWN_R) {
        scene.remove(fr.mesh);
        fragments.splice(f, 1);
      }
    }

    /* 物理行星碰撞：撞太阳破碎，撞其他行星小者破碎 */
    for (var c = 0; c < PLANETS.length; c++) {
      var bp = PLANETS[c];
      if (bp.mode !== 'physical') continue;
      if (bp.group.position.length() < PARAMS.sunSize + bp.r * 1.35) {
        sunFlare = 1;
        shatter(bp, bp.vel, new THREE.Vector3(0, 0, 0), PARAMS.sunSize);
        continue;
      }
      for (var d = 0; d < PLANETS.length; d++) {
        var op = PLANETS[d];
        if (op === bp || op.mode === 'gone' || op.mode === 'drag') continue;
        if (bp.group.position.distanceTo(op.group.position) < (bp.r + op.r) * 1.35) {
          /* 小的碎 */
          if (bp.mass <= op.mass) shatter(bp, bp.vel, op.group.position, op.r * 1.35);
          else shatter(op, bp.vel.clone().multiplyScalar(0.4), bp.group.position, bp.r * 1.35);
          break;
        }
      }
    }

    /* 悬停检测（供 2D 层画标签） */
    hovered = null;
    if (pointerOn && !grab) {
      var hp2 = pickFromNDC();
      if (hp2 && hp2.type === 'planet') {
        var pl = hp2.planet;
        var scr = screenPosOf(pl.group.position);
        hovered = {
          type: 'planet',
          label: pl.name + ' · ' + pl.en,
          hint: pl.mass > PARAMS.dragMass ? '质量过大 · 无法拖拽' : (pl.mode === 'physical' ? '引力场中 · 惯性运动' : '可拖拽甩出 · 轻点加速'),
          x: scr.x, y: scr.y, r: Math.round(pl.r * 2.4)
        };
      } else if (hp2 && hp2.type === 'frag') {
        var fscr = screenPosOf(hp2.frag.pos);
        hovered = {
          type: 'planet',
          label: '岩块 · DEBRIS',
          hint: '可抓取拖拽',
          x: fscr.x, y: fscr.y, r: Math.round(hp2.frag.r * 2.6)
        };
      } else if (pickSunFromNDC()) {
        var ss = screenPosOf(sun.position);
        hovered = { type: 'sun', label: '太阳 · SOL', hint: '', x: ss.x, y: ss.y, r: 40 };
      }
    } else if (grab) {
      var gp = PLANETS[grab.idx];
      if (gp && gp.mode !== 'gone') {
        var gs = screenPosOf(gp.group.position);
        hovered = {
          type: 'planet',
          label: gp.name + ' · ' + gp.en,
          hint: grab.kind === 'strain' ? '质量过大 · 拽不动' : '松手进入引力场',
          x: gs.x, y: gs.y, r: Math.round(gp.r * 2.4)
        };
      }
    }

    renderer.render(scene, camera);
  }

  /* 由 NDC 反算屏幕坐标用于悬停拾取 */
  function pointerNDCtoXY() {
    return {
      x: (pointerNDC.x + 1) / 2 * window.innerWidth,
      y: (-pointerNDC.y + 1) / 2 * window.innerHeight
    };
  }
  function pickSunFromNDC() {
    raycaster.setFromCamera(pointerNDC, camera);
    return raycaster.intersectObject(sun, false).length > 0;
  }

  var lastFrameAt = 0;

  /* 帧率上限 45fps（22ms）：GPU 减压，慢速运动的太阳系视觉无差 */
  var lastRenderAt = 0;

  function tick(now) {
    if (now - lastRenderAt < MOB.frameMs) {
      raf = requestAnimationFrame(tick);
      return;
    }
    lastRenderAt = now;
    var dt = Math.min((now - lastT) / 1000 || 0.022, 1 / 20);
    lastT = now;
    lastFrameAt = performance.now();
    try {
      step(dt, now);
    } catch (err) {
      window.__solarLastError = String((err && err.stack) || err);
    }
    raf = requestAnimationFrame(tick);
  }

  function start() {
    if (running || REDUCED) return;
    running = true;
    lastT = performance.now();
    lastFrameAt = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function stop() {
    running = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
  }

  /* 看门狗：标签页可见但渲染循环停摆时自动重启
     （有些环境下 visibilitychange 不可靠，rAF 链会静默死亡） */
  setInterval(function () {
    if (REDUCED || document.hidden) return;
    var stale = performance.now() - lastFrameAt > 2500;
    if ((!running && lastFrameAt > 0) || (running && stale)) {
      stop();
      start();
    }
  }, 1500);

  window.addEventListener('focus', function () {
    if (!running && !document.hidden) start();
  });

  if (REDUCED) {
    step(0, 0);
  } else {
    start();
  }

  /* ---------- AI 副驾驶：自动驾驶制导 ----------
     接收结构化指令（goto / orbit / chase / slingshot），
     在 stepFlight 中接管转向与油门：
     - 比例导引转向（限角速度）
     - 对准才加速，按「刹车距离 = v²/2a」提前减速
     - slingshot 先飞到借力天体旁（木星/土星择近），再转场目标 */

  var pilot = {
    on: false,
    kind: '',            // goto | orbit | chase | slingshot
    phase: '',
    targetName: '',
    planet: null,        // 目标行星
    assist: null,        // 借力行星
    revolutions: 1,
    revAngle: 0,
    text: '',
    orbitR: 0
  };

  var PL_BY_NAME = {};
  for (var pbn = 0; pbn < PLANETS.length; pbn++) {
    PL_BY_NAME[PLANETS[pbn].name] = PLANETS[pbn];
    PL_BY_NAME[PLANETS[pbn].en.toLowerCase()] = PLANETS[pbn];
  }

  function findPlanet(nm) {
    if (!nm) return null;
    nm = nm.toLowerCase();
    return PL_BY_NAME[nm] || null;
  }

  function alivePlanet(p) {
    return p && p.mode !== 'gone';
  }

  function shipForward(out) {
    /* 当前机头朝向（YXZ 欧拉 → 前向向量） */
    var cp = Math.cos(flight.pitch), sp = Math.sin(flight.pitch);
    var cy = Math.cos(flight.yaw), sy = Math.sin(flight.yaw);
    out.set(-sy * cp, sp, -cy * cp);
    return out;
  }

  function steerToward(dir, dt) {
    /* 把机头朝 dir 缓转（限角速度），返回对准程度 0..1 */
    var d = dir.clone().normalize();
    var wantYaw = Math.atan2(-d.x, -d.z);
    var wantPitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
    var dy = wantYaw - flight.yaw;
    while (dy > Math.PI) dy -= 6.2832;
    while (dy < -Math.PI) dy += 6.2832;
    var dp = wantPitch - flight.pitch;
    var maxTurn = 2.4 * dt;
    flight.yaw += Math.max(-maxTurn, Math.min(maxTurn, dy));
    flight.pitch += Math.max(-maxTurn, Math.min(maxTurn, dp));
    if (flight.pitch > 1.35) flight.pitch = 1.35;
    if (flight.pitch < -1.35) flight.pitch = -1.35;
    var err = Math.sqrt(dy * dy + dp * dp);
    return Math.max(0, 1 - err / 0.9);
  }

  function nearestFragment() {
    var best = null, bd = 1e9;
    for (var i = 0; i < fragments.length; i++) {
      if (fragments[i].grabbed) continue;
      var d = fragments[i].pos.distanceTo(flight.pos);
      if (d < bd) { bd = d; best = fragments[i]; }
    }
    return best;
  }

  function pilotTargetPos(out) {
    if (pilot.kind === 'chase') {
      if (!pilot.frag) { out.copy(flight.pos); return out; }
      /* 预判：碎块当前位置 + 速度 × 预估飞行时间 */
      var t = pilot.frag.pos.distanceTo(flight.pos) / 60;
      out.copy(pilot.frag.pos).addScaledVector(pilot.frag.vel, Math.min(t, 2));
      return out;
    }
    if (pilot.assist && pilot.phase === 'assist') {
      out.copy(pilot.assist.group.position);
      return out;
    }
    if (pilot.planet) out.copy(pilot.planet.group.position);
    else out.set(0, 0, 0);
    return out;
  }

  function pilotStep(dt) {
    if (!pilot.on) return;
    var keys = flight.keys;
    keys.w = keys.a = keys.s = keys.d = keys.shift = false;

    var tgt = pilotTargetPos(PILOT_A);
    var toT = PILOT_B.copy(tgt).sub(flight.pos);
    var dist = toT.length();
    var dir = toT.normalize();
    var speed = flight.vel.length();

    /* 手动打断已在 pointerdown/keydown 里处理 */

    if (pilot.phase === 'assist') {
      var ad = flight.pos.distanceTo(pilot.assist.group.position);
      pilot.text = '正在借力' + pilot.assist.name + ' · 距离 ' + Math.round(ad);
      if (ad < pilot.assist.r * 1.35 * 9 + 25) {
        pilot.phase = 'transfer';
        pilot.text = '借力成功 · 转场' + pilot.targetName;
      }
    }

    var arrive = pilot.kind === 'orbit'
      ? pilot.orbitR
      : (pilot.planet ? pilot.planet.r * 1.35 * 5 + 38 : 18);

    /* 对准度 → 油门；按刹车距离提前反推 */
    var align = steerToward(dir, dt);
    var brakeDist = (speed * speed) / (2 * 150) + 6;
    if (align > 0.72) {
      if (dist < brakeDist + arrive * 0.6) keys.s = true;
      else keys.w = dist > arrive * 0.5;
      if (pilot.kind === 'slingshot' && pilot.phase === 'assist' && dist < 160) {
        keys.shift = true; /* 弹弓段全速 */
      }
    }

    /* 相位推进 */
    if (pilot.kind === 'orbit') {
      if (dist < pilot.orbitR * 1.3) {
        pilot.phase = 'orbit';
        /* 环绕：瞄准轨道上前方的点，累计转角 */
        var ang = Math.atan2(
          flight.pos.z - tgt.z, flight.pos.x - tgt.x
        );
        var ahead = ang + 0.5;
        PILOT_A.set(
          tgt.x + Math.cos(ahead) * pilot.orbitR, 0,
          tgt.z + Math.sin(ahead) * pilot.orbitR
        );
        var toAhead = PILOT_B.copy(PILOT_A).sub(flight.pos).normalize();
        steerToward(toAhead, dt);
        keys.w = true;
        pilot.revAngle += 0.5 * dt * Math.max(speed / pilot.orbitR, 0.2);
        if (pilot.revAngle >= 6.2832 * pilot.revolutions) {
          pilot.on = false;
          pilot.text = '环绕完成 · 已悬停';
          return;
        }
        pilot.text = '环绕' + pilot.targetName + ' · 第 ' +
          (Math.min(Math.floor(pilot.revAngle / 6.2832) + 1, pilot.revolutions)) +
          '/' + pilot.revolutions + ' 圈';
        return;
      }
      pilot.text = '接近' + pilot.targetName + ' · 距离 ' + Math.round(dist);
      return;
    }

    if (pilot.kind === 'chase') {
      if (!pilot.frag) { pilot.on = false; pilot.text = '目标丢失'; return; }
      var cd = flight.pos.distanceTo(pilot.frag.pos);
      if (cd < 14) {
        /* 贴上后只做速度匹配，不再推进 */
        keys.w = false;
        pilot.text = '已捕获碎块 · 跟随中';
        return;
      }
      pilot.text = '追踪碎块 · 距离 ' + Math.round(cd);
      return;
    }

    /* goto / slingshot 的转场段 */
    if (dist < arrive) {
      var arrived = '已抵达' + (pilot.targetName || '');
      if (pilot.phase === 'assist') arrived = '已到借力点';
      pilot.on = false;
      pilot.text = arrived;
      return;
    }
    if (pilot.phase !== 'assist') {
      pilot.text = '飞往' + pilot.targetName + ' · 距离 ' + Math.round(dist);
    }
  }

  var PILOT_A = new THREE.Vector3();
  var PILOT_B = new THREE.Vector3();

  function pilotCommand(cmd) {
    cmd = cmd || {};
    if (cmd.type === 'cancel') {
      pilot.on = false;
      pilot.text = '已接管';
      return { ok: true, msg: '已取消自动驾驶' };
    }
    if (REDUCED) return { ok: false, msg: '当前系统已关闭动效' };

    if (cmd.type === 'chase') {
      var f = nearestFragment();
      if (!f) return { ok: false, msg: '视野内没有碎块，先去撞碎一颗行星吧' };
      if (!flight.on) enterFlight();
      pilot.on = true;
      pilot.kind = 'chase';
      pilot.phase = 'chase';
      pilot.frag = f;
      pilot.targetName = '碎块';
      pilot.text = '追踪碎块';
      return { ok: true, msg: '收到，追踪最近的碎块' };
    }

    var p = findPlanet(cmd.target);
    if (!p) return { ok: false, msg: '不认识「' + (cmd.target || '?') + '」' };
    if (!alivePlanet(p)) return { ok: false, msg: p.name + '已经解体了，先还原太阳系吧' };

    if (cmd.type === 'slingshot') {
      var assist = alivePlanet(PLANETS[4]) ? PLANETS[4] : PLANETS[5]; /* 优先木星 */
      if (!alivePlanet(assist)) assist = PLANETS[5];
      if (!alivePlanet(assist) || assist === p) {
        assist = null;
      }
      if (!assist) return { ok: false, msg: '没有可借力的大行星' };
      if (!flight.on) enterFlight();
      pilot.on = true;
      pilot.kind = 'slingshot';
      pilot.planet = p;
      pilot.assist = assist;
      pilot.phase = 'assist';
      pilot.targetName = p.name;
      pilot.text = '规划借力' + assist.name + '航线 · 目标' + p.name;
      return { ok: true, msg: '收到，经' + assist.name + '引力弹弓前往' + p.name };
    }

    if (!flight.on) enterFlight();
    pilot.on = true;
    pilot.kind = cmd.type;           /* goto | orbit */
    pilot.phase = 'transfer';
    pilot.planet = p;
    pilot.assist = null;
    pilot.targetName = p.name;
    pilot.revolutions = Math.max(1, Math.min(9, cmd.revolutions || 1));
    pilot.revAngle = 0;
    pilot.orbitR = p.r * 1.35 * 4 + 26;
    pilot.text = cmd.type === 'orbit' ? '前往' + p.name + '准备环绕' : '飞往' + p.name;
    return { ok: true, msg: cmd.type === 'orbit'
      ? '收到，环绕' + p.name + ' ' + pilot.revolutions + ' 圈'
      : '收到，飞往' + p.name };
  }

  function pilotCancel() {
    if (pilot.on) {
      pilot.on = false;
      pilot.text = '已切回手动';
    }
  }

  function pilotStatus() {
    var d = 0;
    if (pilot.on && pilot.planet && pilot.planet.group) {
      d = Math.round(flight.pos.distanceTo(pilot.planet.group.position));
    }
    return {
      on: pilot.on,
      flying: flight.on,
      text: pilot.text,
      kind: pilot.kind,
      targetName: pilot.targetName,
      dist: d,
      speed: Math.round(flight.vel.length())
    };
  }

  /* ---------- 暴露给 2D 层与验收 ---------- */

  /* 科学模式切换（solid 实体 / wire 线框 / points 点云） */
  function setRenderMode(m) {
    if (['solid', 'wire', 'points'].indexOf(m) < 0) return;
    PARAMS.renderMode = m;
    for (var i = 0; i < PLANETS.length; i++) {
      var p = PLANETS[i];
      p.body.material.wireframe = (m === 'wire');
      p.body.visible = (m !== 'points' && p.mode !== 'gone');
      p.points.visible = (m === 'points' && p.mode !== 'gone');
      if (p.moonMesh) p.moonMesh.visible = (m !== 'points' && p.mode !== 'gone');
      if (p.geoRing) p.geoRing.visible = (m !== 'points' && p.mode !== 'gone');
      if (p.geoSats) {
        for (var gv = 0; gv < p.geoSats.length; gv++) {
          p.geoSats[gv].mesh.visible = (m !== 'points' && p.mode !== 'gone');
        }
      }
      /* 大气壳与云层只在实体模式显示 */
      if (p.atmoShell) p.atmoShell.visible = (m === 'solid' && p.mode !== 'gone');
      if (p.clouds) p.clouds.visible = (m === 'solid' && p.mode !== 'gone');
    }
  }

  window.Solar3D = {
    PARAMS: PARAMS,
    setRenderMode: setRenderMode,
    toggleGravField: toggleGravField,
    stats2: function () {
      return {
        belt: beltRocks.length,
        sats: (PLANETS[2] && PLANETS[2].sats) ? PLANETS[2].sats.length : 0,
        gravOn: gravOn
      };
    },
    camInfo: function () {
      return {
        az: Math.round(freeCam.az * 100) / 100,
        el: Math.round(freeCam.el * 100) / 100,
        dist: Math.round(freeCam.dist),
        targetX: Math.round(freeCam.target.x),
        targetZ: Math.round(freeCam.target.z),
        blend: Math.round(camBlend * 100) / 100
      };
    },
    ship: function () {
      return {
        x: Math.round(flight.pos.x),
        y: Math.round(flight.pos.y),
        z: Math.round(flight.pos.z),
        speed: Math.round(flight.vel.length()),
        flying: flight.on
      };
    },
    planetWorld: function (name) {
      var p = findPlanet(name);
      if (!p || p.mode === 'gone') return null;
      return {
        x: Math.round(p.group.position.x),
        y: 0,
        z: Math.round(p.group.position.z)
      };
    },
    pilot: {
      command: pilotCommand,
      cancel: pilotCancel,
      status: pilotStatus
    },
    gestureZoom: function (factor) {
      /* 手势双手开合 → 自由模式缩放 */
      if (PARAMS.mouseMode !== 'free') return;
      freeCam.dist = Math.max(10, Math.min(1500, freeCam.dist / factor));
    },
    active: true,
    get hovered() { return hovered; },
    onPointerDown: onPointerDown,
    reset: reset,
    stats: function () {
      return {
        planets: PLANETS.map(function (p) {
          return {
            name: p.name, mode: p.mode, mass: p.mass,
            dist: Math.round(p.group.position.length())
          };
        }),
        fragments: fragments.length,
        fragSizes: fragments.map(function (fr) {
          return Math.round(fr.r * 10) / 10;
        }),
        fragScreens: fragments.slice(0, 12).map(function (fr) {
          var s = screenPosOf(fr.pos);
          return { x: s.x, y: s.y, behind: s.behind };
        }),
        grabbed: grab
          ? (grab.kind === 'frag'
              ? { name: '碎块', kind: 'frag' }
              : { name: PLANETS[grab.idx].name, kind: grab.kind })
          : null
      };
    },
    planetScreen: function (name) {
      for (var i = 0; i < PLANETS.length; i++) {
        if (PLANETS[i].name === name && PLANETS[i].mode !== 'gone') {
          var s = screenPosOf(PLANETS[i].group.position);
          return s;
        }
      }
      return null;
    }
  };
})();
