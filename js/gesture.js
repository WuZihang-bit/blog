/* ==========================================================================
   吴子航的博客 · 手势交互系统（MediaPipe Hands · 仅首页）
   --------------------------------------------------------------------------
   摄像头实时识别 21 个手部关键点，几何规则分类为手势，驱动全站交互。

   手势与功能映射：
   - ✊ 握拳           → 时间静止（再握手势恢复按 ✋）
   - ✋ 张开手掌       → 时间恢复 1×；手掌移动 = 视角跟随（视差）
   - 👍 点赞           → 时间快进 2.5×
   - 👎 倒赞           → 时间慢放 0.4×
   - 🤏 捏合（拇指食指）→ 抓取：捏住移动 = 拖拽行星 / 碎块 / 星空视角
   - ☝️ 食指           → 虚拟指针：指哪看哪（悬停天体显示名称）
   - ✌️ V 字           → 线框 / 实体渲染切换
   - 👌 OK             → 深浅主题切换
   - 双手捏合开合      → 自由模式缩放

   工程要点：
   - classifyHand() 是纯函数（可离线测试），不依赖摄像头
   - 手势状态机：连续 HOLD 帧同手势才确认，防抖；退出留_MARGIN
   - palmPos 用 EMA 平滑（抖动抑制）
   - 隐私：视频只在本地推理，不上传；HUD 可随时关闭摄像头
   ========================================================================== */

(function () {
  'use strict';

  if (!window.Solar3D) return;
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ======================================================
     一、手势分类核心（纯函数）
     landmarks: 21 个 {x,y,z}（归一化 0-1，x 镜像后处理）
     ====================================================== */

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y, dz = (a.z || 0) - (b.z || 0);
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /* 手掌基准长度：手腕(0) → 中指根(9)，用于距离归一化 */
  function palmSize(lm) {
    return Math.max(dist(lm[0], lm[9]), 0.02);
  }

  /* 各指伸直判断：绝对比例法——
     指尖到手腕 / 掌距：伸直≈1.7-1.9，折叠≈0.5-0.9，取 1.45 分界。
     比「tip vs pip 相对比较」稳健（折叠指尖偶尔比关节更远时不误判） */
  var FINGER_EXT = 1.45;

  function fingersUp(lm) {
    var up = [];
    var ref = palmSize(lm);
    var tips = [8, 12, 16, 20];
    for (var i = 0; i < 4; i++) {
      up.push(dist(lm[tips[i]], lm[0]) / ref > FINGER_EXT);
    }
    /* 拇指：拇指尖(4)到小指根(17)的张开跨度 */
    var thumbSpan = dist(lm[4], lm[17]) / ref;
    var thumbTip = dist(lm[4], lm[5]) / ref;
    up.unshift(thumbSpan > 1.05 && thumbTip > 0.35);
    return up; /* [拇指, 食指, 中指, 无名, 小指] */
  }

  function classifyHand(lm, mirrored) {
    if (!lm || lm.length < 21) return null;
    var m = mirrored ? -1 : 1;
    var up = fingersUp(lm);
    var count = up.filter(Boolean).length;
    var ref = palmSize(lm);

    var pinchDist = dist(lm[4], lm[8]) / ref;         /* 捏合度（越小越捏紧） */
    var palm = {
      x: (lm[0].x + lm[5].x + lm[17].x) / 3,
      y: (lm[0].y + lm[9].y) / 2
    };

    /* 手势判定（优先级从高到低） */
    var type = 'none';

    /* L 手势（拇指+食指伸直）：与捏合/赞区分度高，用于主题切换 */
    if (up[0] && up[1] && !up[2] && !up[3] && !up[4]) {
      type = 'L';
    }
    /* 点赞/倒赞：仅拇指伸直（比 fist 更具体，须先判） */
    else if (up[0] && !up[1] && !up[2] && !up[3] && !up[4]) {
      type = lm[4].y < lm[0].y - 0.04 ? 'thumbUp' : 'thumbDown';
    }
    /* 捏合：拇指食指尖靠近（其余手指状态不苛求） */
    else if (pinchDist < 0.35) {
      type = 'pinch';
    }
    /* 握拳：四指全收 */
    else if (!up[1] && !up[2] && !up[3] && !up[4]) {
      type = 'fist';
    }
    /* 张开手掌：四指全伸 */
    else if (up[1] && up[2] && up[3] && up[4]) {
      type = 'open';
    }
    /* 食指：仅食指 */
    else if (up[1] && !up[2] && !up[3] && !up[4]) {
      type = 'point';
    }
    /* V 字：食指+中指 */
    else if (up[1] && up[2] && !up[3] && !up[4]) {
      type = 'peace';
    }
    /* 计数兜底 */
    else if (count >= 3) {
      type = 'open';
    }

    return {
      type: type,
      pinch: pinchDist,
      palm: palm,
      fingers: up,
      handed: 0 /* 由上层填 */
    };
  }

  /* ======================================================
     二、手势状态机（防抖 + 事件）
     ====================================================== */

  var HOLD_FRAMES = 3;     /* 连续 3 帧同手势才确认 */
  var state = {
    cur: 'none',
    cand: 'none',
    candCount: 0,
    since: 0,
    palmSm: null,          /* EMA 平滑后的掌心 */
    lastFire: {},          /* 各手势上次触发时间（防重复） */
    pinchDown: false,      /* 捏合会话进行中 */
    pointActive: false
  };

  function fireEvent(name, detail) {
    window.dispatchEvent(new CustomEvent('gesture-' + name, { detail: detail || {} }));
  }

  function onClassified(g, mirrored) {
    if (!g) { updateHud(null); return; }
    var now = performance.now();

    /* 掌心 EMA 平滑 */
    if (!state.palmSm) state.palmSm = { x: g.palm.x, y: g.palm.y };
    else {
      state.palmSm.x += (g.palm.x - state.palmSm.x) * 0.25;
      state.palmSm.y += (g.palm.y - state.palmSm.y) * 0.25;
    }

    /* 候选 → 确认 */
    if (g.type === state.cand) {
      state.candCount++;
    } else {
      state.cand = g.type;
      state.candCount = 1;
    }
    var confirmed = null;
    if (state.candCount >= HOLD_FRAMES && state.cur !== state.cand) {
      state.cur = state.cand;
      state.since = now;
      confirmed = state.cur;
    }

    var sm = {
      x: mirrored ? 1 - state.palmSm.x : state.palmSm.x,
      y: state.palmSm.y
    };
    g.palmSm = sm;
    g.confirmed = confirmed;

    /* 持续类手势数据流（每帧） */
    if (state.cur === 'pinch') {
      fireEvent('pinchmove', {
        x: Math.round(sm.x * window.innerWidth),
        y: Math.round(sm.y * window.innerHeight),
        pinch: g.pinch
      });
    } else if (state.cur === 'point') {
      /* 虚拟指针用食指尖更精准 */
      var tip = lm8Cache;
      if (tip) {
        fireEvent('pointmove', {
          x: Math.round((mirrored ? 1 - tip.x : tip.x) * window.innerWidth),
          y: Math.round(tip.y * window.innerHeight)
        });
      }
    } else if (state.cur === 'open') {
      fireEvent('palmmove', { nx: sm.x, ny: sm.y });
    }

    /* 确认沿（一次性动作，带冷却） */
    if (confirmed) {
      var cool = COOLDOWN[confirmed] || 600;
      if (!state.lastFire[confirmed] || now - state.lastFire[confirmed] > cool) {
        state.lastFire[confirmed] = now;
        fireEvent('fire', { type: confirmed });
        showGestureToast(confirmed);
      }
      /* 进入/退出捏合会话 */
      if (confirmed === 'pinch') {
        state.pinchDown = true;
        fireEvent('pinchstart', {
          x: Math.round(sm.x * window.innerWidth),
          y: Math.round(sm.y * window.innerHeight)
        });
      }
    }

    /* 捏合结束检测：当前非 pinch 且之前是 */
    if (state.cur !== 'pinch' && state.pinchDown) {
      state.pinchDown = false;
      fireEvent('pinchend', {});
    }

    updateHud(g);
  }

  var COOLDOWN = {
    fist: 500, open: 500, thumbUp: 900, thumbDown: 900,
    peace: 1200, L: 1200, point: 400, pinch: 400
  };

  var lm8Cache = null;   /* 食指尖（point 用） */

  /* ======================================================
     三、动作映射（手势 → 各模块）
     ====================================================== */

  var TIME_PREV = 1;

  function applyAction(type) {
    var P = window.Solar3D.PARAMS;
    switch (type) {
      case 'fist':
        TIME_PREV = P.timeScale || 1;
        P.timeScale = 0;
        return '时间静止';
      case 'open':
        P.timeScale = 1;
        return '时间恢复 ×1';
      case 'thumbUp':
        P.timeScale = 2.5;
        return '时间快进 ×2.5';
      case 'thumbDown':
        P.timeScale = 0.4;
        return '时间慢放 ×0.4';
      case 'peace':
        var next = P.renderMode === 'wire' ? 'solid' : 'wire';
        window.Solar3D.setRenderMode(next);
        return next === 'wire' ? '线框模式' : '实体模式';
      case 'L':
        document.getElementById('theme-toggle').click();
        return '主题切换';
    }
    return null;
  }

  window.addEventListener('gesture-fire', function (e) {
    var msg = applyAction(e.detail.type);
    if (msg) hudSay(msg);
  });

  /* 捏合 → 拖拽（复用 Solar3D 的指针链） */
  window.addEventListener('gesture-pinchstart', function (e) {
    window.Solar3D.onPointerDown(e.detail.x, e.detail.y);
  });
  window.addEventListener('gesture-pinchmove', function (e) {
    /* 喂给 solar3d 的 pointermove（它监听 window pointermove） */
    window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: e.detail.x, clientY: e.detail.y
    }));
    /* 同步给 2D 层光标 */
    window.BlogBackground.pointer.x = e.detail.x;
    window.BlogBackground.pointer.y = e.detail.y;
    window.BlogBackground.pointer.on = true;
  });
  window.addEventListener('gesture-pinchend', function () {
    window.dispatchEvent(new PointerEvent('pointerup'));
  });

  /* 食指 → 虚拟指针悬停（驱动 solar3d 的 hover 检测） */
  window.addEventListener('gesture-pointmove', function (e) {
    window.BlogBackground.pointer.x = e.detail.x;
    window.BlogBackground.pointer.y = e.detail.y;
    window.BlogBackground.pointer.on = true;
  });

  /* 张开手掌 → 视角跟随（复用 solar3d 视差输入：parTX/parTY 由 pointermove 计算，
     这里直接映射为相对屏幕中心的偏移） */
  window.addEventListener('gesture-palmmove', function (e) {
    /* solar3d 视差来自真实 pointermove；手掌模式改用直接驱动：
       将 nx,ny(0-1) 映射为屏幕坐标，喂给 pointer，视差自然跟随 */
    window.BlogBackground.pointer.x = Math.round(e.detail.nx * window.innerWidth);
    window.BlogBackground.pointer.y = Math.round(e.detail.ny * window.innerHeight);
    window.BlogBackground.pointer.on = true;
    window.dispatchEvent(new PointerEvent('pointermove', {
      clientX: window.BlogBackground.pointer.x,
      clientY: window.BlogBackground.pointer.y
    }));
  });

  /* ======================================================
     四、摄像头 + MediaPipe
     ====================================================== */

  var camOn = false;
  var video = null;
  var stream = null;
  var hands = null;

  function locateFile(f) {
    return 'lib/mediapipe/' + f;
  }

  async function startCamera() {
    if (camOn) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }
      });
    } catch (err) {
      /* 失败也要让用户看见原因：临时弹出 HUD 显示错误 */
      hud.classList.add('show');
      hudSay('摄像头不可用：' + (err.name === 'NotAllowedError' ? '权限被拒绝' : err.name || '未知'), true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 3500);
      return;
    }
    video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();

    if (!window.Hands) {
      /* 加载本地 MediaPipe */
      await new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = 'lib/mediapipe/hands.js';
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      }).catch(function () { hudSay('手势引擎加载失败', true); return; });
    }

    hands = new window.Hands({ locateFile: locateFile });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.55
    });
    hands.onResults(onResults);

    camOn = true;
    btn.classList.add('on');
    hud.classList.add('show');
    hudSay('手势识别已开启 ✋');

    /* 采集循环（rAF 节流到 ~30fps） */
    var lastSend = 0;
    var loop = function () {
      if (!camOn) return;
      var t = performance.now();
      if (t - lastSend > 33 && video.readyState >= 2) {
        lastSend = t;
        hands.send({ image: video });
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  function stopCamera() {
    camOn = false;
    btn.classList.remove('on');
    hud.classList.remove('show');
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    updateHud(null);
    hudSay('手势识别已关闭');
  }

  function onResults(res) {
    var lms = res.multiHandLandmarks;
    drawHudCanvas(res);
    if (!lms || !lms.length) {
      /* 手离开画面：结束任何捏合会话 */
      if (state.pinchDown) {
        state.pinchDown = false;
        fireEvent('pinchend', {});
      }
      state.cur = 'none';
      state.cand = 'none';
      updateHud(null);
      return;
    }
    /* 主手 = 第一只；记录食指尖 */
    lm8Cache = lms[0][8];
    var g = classifyHand(lms[0], true);  /* 镜像：摄像头自拍视角 */
    onClassified(g, true);

    /* 双手捏合 → 缩放（自由模式） */
    if (lms.length > 1) {
      var g2 = classifyHand(lms[1], true);
      if (g && g.type === 'pinch' && g2 && g2.type === 'pinch') {
        var d = dist(
          { x: g.palmSm ? g.palmSm.x : g.palm.x, y: g.palm.y },
          { x: g2.palm.x, y: g2.palm.y }
        );
        if (twoHandRef == null) twoHandRef = d;
        else {
          var factor = d / twoHandRef;
          if (Math.abs(factor - 1) > 0.06) {
            fireEvent('twohand', { factor: factor });
            twoHandRef = d;
          }
        }
      } else {
        twoHandRef = null;
      }
    } else {
      twoHandRef = null;
    }
  }
  var twoHandRef = null;

  /* 双手开合 → 自由模式缩放 */
  window.addEventListener('gesture-twohand', function (e) {
    if (window.Solar3D.PARAMS.mouseMode !== 'free') return;
    window.Solar3D.gestureZoom(e.detail.factor);
  });

  /* ======================================================
     五、HUD（预览窗 + 骨架 + 手势提示）
     ====================================================== */

  var btn = document.createElement('button');
  btn.id = 'gesture-toggle';
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.title = '手势控制';
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', '手势控制');
  btn.setAttribute('data-tip', '手势控制 · 摄像头');
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/>' +
    '<path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2' +
    'c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/></svg>';
  var nav = document.querySelector('.site-nav');
  if (nav) nav.insertBefore(btn, document.getElementById('copilot-toggle'));

  var hud = document.createElement('div');
  hud.id = 'gesture-hud';
  hud.setAttribute('aria-hidden', 'true');
  hud.innerHTML =
    '<div class="gh-title"><span class="gh-dot"></span>手势识别' +
    '<button id="gh-close" type="button" aria-label="关闭手势识别">✕</button></div>' +
    '<div class="gh-view"><canvas id="gh-canvas" width="208" height="156"></canvas></div>' +
    '<div class="gh-status" id="gh-status">把手放到镜头前</div>' +
    '<div class="gh-legend">✊静止 · ✋恢复/视角 · 🤏抓取 · ☝️指针<br>👍快进 · 👎慢放 · ✌️线框 · L=主题</div>';
  document.body.appendChild(hud);

  var toast = document.createElement('div');
  toast.id = 'gesture-toast';
  document.body.appendChild(toast);

  var hudStatus = hud.querySelector('#gh-status');
  var ghCanvas = hud.querySelector('#gh-canvas');
  var ghCtx = ghCanvas.getContext('2d');

  var GESTURE_NAMES = {
    fist: '✊ 时间静止', open: '✋ 时间恢复', thumbUp: '👍 快进 ×2.5',
    thumbDown: '👎 慢放 ×0.4', pinch: '🤏 抓取', point: '☝️ 指针',
    peace: '✌️ 线框切换', L: '🫱 主题切换'
  };

  function hudSay(msg, bad) {
    if (hudStatus) {
      hudStatus.textContent = msg;
      hudStatus.classList.toggle('bad', !!bad);
    }
  }

  function showGestureToast(type) {
    if (!GESTURE_NAMES[type]) return;
    toast.textContent = GESTURE_NAMES[type];
    toast.classList.remove('pop');
    void toast.offsetWidth;   /* 重启动画 */
    toast.classList.add('pop');
  }

  /* 骨架绘制：渐变关键点 + 连线 + 捏合高亮 */
  var CONNECTIONS = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]
  ];

  function drawHudCanvas(res) {
    var w = ghCanvas.width, h = ghCanvas.height;
    ghCtx.clearRect(0, 0, w, h);
    /* 镜像视频 */
    if (video && video.readyState >= 2) {
      ghCtx.save();
      ghCtx.translate(w, 0);
      ghCtx.scale(-1, 1);
      ghCtx.globalAlpha = 0.9;
      ghCtx.drawImage(video, 0, 0, w, h);
      ghCtx.restore();
    }
    var lms = res.multiHandLandmarks;
    if (!lms) return;
    for (var hi = 0; hi < lms.length; hi++) {
      var lm = lms[hi];
      /* 连线 */
      ghCtx.strokeStyle = 'rgba(125, 211, 252, 0.75)';
      ghCtx.lineWidth = 1.6;
      for (var c = 0; c < CONNECTIONS.length; c++) {
        var a = lm[CONNECTIONS[c][0]], b = lm[CONNECTIONS[c][1]];
        ghCtx.beginPath();
        ghCtx.moveTo((1 - a.x) * w, a.y * h);
        ghCtx.lineTo((1 - b.x) * w, b.y * h);
        ghCtx.stroke();
      }
      /* 关键点：指尖亮 */
      for (var k = 0; k < 21; k++) {
        var isTip = (k === 4 || k === 8 || k === 12 || k === 16 || k === 20);
        ghCtx.fillStyle = isTip ? '#a5f3fc' : 'rgba(196,181,253,0.9)';
        ghCtx.beginPath();
        ghCtx.arc((1 - lm[k].x) * w, lm[k].y * h, isTip ? 3 : 2, 0, 6.2832);
        ghCtx.fill();
      }
      /* 捏合指示圈 */
      var pinD = dist(lm[4], lm[8]) / palmSize(lm);
      if (pinD < 0.5) {
        ghCtx.strokeStyle = pinD < 0.35 ? '#67e8f9' : 'rgba(103,232,249,0.4)';
        ghCtx.lineWidth = 2;
        ghCtx.beginPath();
        ghCtx.arc((1 - lm[4].x) * w, lm[4].y * h, 10, 0, 6.2832);
        ghCtx.stroke();
      }
    }
  }

  function updateHud(g) {
    if (!camOn) return;
    if (!g) {
      hudSay('把手放到镜头前');
      return;
    }
    var label = GESTURE_NAMES[state.cur] || state.cur;
    hudSay(label + (state.pinchDown ? ' · 拖拽中' : ''));
  }

  btn.addEventListener('click', function () {
    if (camOn) stopCamera();
    else startCamera();
  });
  hud.querySelector('#gh-close').addEventListener('click', stopCamera);

  /* ======================================================
     六、导出（自测 / 调试）
     ====================================================== */

  window.BlogGesture = {
    classify: classifyHand,
    fingersUp: fingersUp,
    state: state,
    isOn: function () { return camOn; }
  };
})();
