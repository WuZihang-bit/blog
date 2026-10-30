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
  var IS_LIKE_MOBILE = window.innerWidth < 768 ||
    (navigator.maxTouchPoints > 0 && Math.min(window.innerWidth, window.innerHeight) < 900);

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
     一点五、One Euro Filter（业界标准平滑：静止高精度 / 移动低延迟）
     ====================================================== */

  function OneEuro(minCutoff, beta) {
    this.minCutoff = minCutoff || 1.0;
    this.beta = beta || 0.007;
    this.dCutoff = 1.0;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = 0;
  }
  OneEuro.prototype.alpha = function (cutoff, dt) {
    var tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  OneEuro.prototype.filter = function (x, tSec) {
    if (this.xPrev === null) {
      this.xPrev = x;
      this.tPrev = tSec;
      return x;
    }
    var dt = Math.max(tSec - this.tPrev, 1e-4);
    this.tPrev = tSec;
    var dx = (x - this.xPrev) / dt;
    var edx = this.dxPrev + this.alpha(this.dCutoff, dt) * (dx - this.dxPrev);
    this.dxPrev = edx;
    var cutoff = this.minCutoff + this.beta * Math.abs(edx);
    var out = this.xPrev + this.alpha(cutoff, dt) * (x - this.xPrev);
    this.xPrev = out;
    return out;
  };

  /* ======================================================
     二、手势状态机（防抖 + 事件）
     ====================================================== */

  var HOLD_FRAMES = 3;     /* 连续 3 帧同手势才确认 */
  /* 滞回双阈值（Ultraleap 官方推荐做法）：
     进入捏合要紧（0.35），松开判定要宽（0.58）——
     抓取期间指尖微颤不会意外松手 */
  var PINCH_ENTER = 0.35;
  var PINCH_EXIT = 0.58;

  var pinchFx = new OneEuro(1.2, 0.02);   /* 捏合点 x/y 各自滤波 */
  var pinchFy = new OneEuro(1.2, 0.02);
  var state = {
    cur: 'none',
    cand: 'none',
    candCount: 0,
    since: 0,
    lastSeen: 0,           /* 最后检测到手的时间（无手超时用） */
    lastFire: {},
    pinchDown: false
  };

  function fireEvent(name, detail) {
    window.dispatchEvent(new CustomEvent('gesture-' + name, { detail: detail || {} }));
  }

  function onClassified(g, lm) {
    if (!g) { updateHud(null); return; }
    var now = performance.now();
    state.lastSeen = now;

    /* 手势确认（带 pinch 滞回）：已处于 pinch 会话时，宽阈值判定 */
    var effType = g.type;
    if (state.pinchDown) {
      if (g.pinch > PINCH_EXIT) effType = (effType === 'pinch') ? 'none' : effType;
      else effType = 'pinch';   /* 会话中：只要还捏着就保持 pinch */
    }

    if (effType === state.cand) state.candCount++;
    else { state.cand = effType; state.candCount = 1; }

    var confirmed = null;
    if (state.candCount >= HOLD_FRAMES && state.cur !== state.cand) {
      state.cur = state.cand;
      state.since = now;
      confirmed = state.cur;
    }

    /* 捏合点（拇指食指中点）经 OneEuro 平滑——比掌心更跟手更准 */
    var px = (lm[4].x + lm[8].x) / 2;
    var py = (lm[4].y + lm[8].y) / 2;
    var tSec = now / 1000;
    var sx = pinchFx.filter(px, tSec);
    var sy = pinchFy.filter(py, tSec);
    var pinchX = Math.round(sx * window.innerWidth);
    var pinchY = Math.round(sy * window.innerHeight);

    /* 食指尖（point 指针） */
    var tipX = lm[8].x;
    var tipY = lm[8].y;

    g.confirmed = confirmed;

    /* 持续类手势数据流（每帧） */
    if (state.cur === 'pinch') {
      fireEvent('pinchmove', { x: pinchX, y: pinchY, pinch: g.pinch });
    } else if (state.cur === 'point') {
      fireEvent('pointmove', {
        x: Math.round(tipX * window.innerWidth),
        y: Math.round(tipY * window.innerHeight)
      });
    } else if (state.cur === 'open') {
      fireEvent('palmmove', {
        nx: (lm[0].x + lm[5].x + lm[17].x) / 3,
        ny: (lm[0].y + lm[9].y) / 2
      });
    }

    /* 确认沿（一次性动作，带冷却） */
    if (confirmed) {
      var cool = COOLDOWN[confirmed] || 600;
      if (!state.lastFire[confirmed] || now - state.lastFire[confirmed] > cool) {
        state.lastFire[confirmed] = now;
        fireEvent('fire', { type: confirmed });
        showGestureToast(confirmed);
      }
      if (confirmed === 'pinch') {
        state.pinchDown = true;
        window.__gesturePinching = true;
        state.cand = 'pinch'; state.candCount = HOLD_FRAMES;
        fireEvent('pinchstart', { x: pinchX, y: pinchY });
      }
    }

    /* 捏合结束：滞回判定（已由 effType 处理） */
    if (state.cur !== 'pinch' && state.pinchDown) {
      state.pinchDown = false;
      window.__gesturePinching = false;
      fireEvent('pinchend', {});
    }

    updateHud(g);
  }

  var COOLDOWN = {
    fist: 500, open: 500, thumbUp: 900, thumbDown: 900,
    peace: 1200, L: 1200, point: 400, pinch: 400
  };

  var lm8Cache = null;   /* 食指尖（point 用） */
  var lastLms = null;    /* 主手骨架缓存（onResults 写 / 预览读） */

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
    if (msg) {
      hudSay(msg);
      /* 联动副驾驶：手势触发的系统动作也通知 Agent 状态区 */
      var cp = document.querySelector('#copilot .cp-status');
      if (cp && document.getElementById('copilot').classList.contains('open')) {
        cp.textContent = '手势 → ' + msg;
      }
    }
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
  /* 中间快照画布：不直接喂 video 元素（部分显卡驱动上 WASM 等视频纹理会卡死），
     改为把视频绘到 2D 画布后喂帧——业界通用兼容做法 */
  var snapCanvas = null;
  var snapCtx = null;
  var delegate = 'CPU';   // 'CPU' | 'GPU'（调节台可切换）

  function locateFile(f) {
    return 'lib/mediapipe/' + f;
  }

  /* 资产探活：MediaPipe 需要 8 个本地文件，任何 404 都会让管线永不就绪 */
  var MP_ASSETS = [
    'hands.binarypb',
    'hands_solution_packed_assets_loader.js',
    'hands_solution_packed_assets.data',
    'hands_solution_simd_wasm_bin.js',
    'hands_solution_simd_wasm_bin.wasm',
    'hands_solution_wasm_bin.js',
    'hands_solution_wasm_bin.wasm',
    'hand_landmark_full.tflite'
  ];

  function probeAssets() {
    return Promise.all(MP_ASSETS.map(function (f) {
      return fetch('lib/mediapipe/' + f, { method: 'HEAD' })
        .then(function (r) { return { f: f, ok: r.ok }; })
        .catch(function () { return { f: f, ok: false }; });
    })).then(function (rs) {
      return rs.filter(function (x) { return !x.ok; }).map(function (x) { return x.f; });
    });
  }

  var SIMD_OK = (function () {
    try {
      return WebAssembly.validate(new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0,
        10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
    } catch (e) { return false; }
  })();

  var rebuildCount = 0;

  async function startCamera() {
    if (camOn) return;

    /* 管线健康预检：资产完整性 + SIMD 支持。
       任何缺失都会导致「推理永不返回 → 看门狗无限重建」，必须前置拦截 */
    hud.classList.add('show');
    hudSay('检查手势引擎资源…');
    var missing = await probeAssets();
    if (missing.length) {
      hudSay('引擎文件缺失：' + missing.join(', '), true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 6000);
      return;
    }
    if (!SIMD_OK) {
      /* 非 SIMD 环境：hands.js 会自动改用非 SIMD wasm（已补齐文件） */
      hudSay('检测到无 SIMD 支持，已切换兼容模式');
    }

    /* 安全上下文检查：getUserMedia 只在 https/localhost 可用
       （手机上用 http://IP 访问会静默失败，必须提示） */
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hud.classList.add('show');
      hudSay(location.protocol === 'http:'
        ? '摄像头需要 HTTPS，请用线上地址访问'
        : '此浏览器不支持摄像头', true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 4000);
      return;
    }

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'user',                 /* 手机上前置摄像头 */
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 }   /* 明确 30fps 上限，省电 */
        },
        audio: false
      });
    } catch (err) {
      /* 失败也要让用户看见原因：临时弹出 HUD 显示错误 */
      hud.classList.add('show');
      var why = err.name === 'NotAllowedError' ? '权限被拒绝（请在浏览器设置中允许）'
        : err.name === 'NotFoundError' ? '未找到摄像头'
        : err.name === 'NotReadableError' ? '摄像头被其他应用占用'
        : err.name || '未知';
      hudSay('摄像头不可用：' + why, true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 4500);
      return;
    }
    /* 重建时复用同一个 video 元素（防 DOM 累积多个隐藏 video） */
    video = document.getElementById('gesture-video') ||
      (function () {
        var v = document.createElement('video');
        v.id = 'gesture-video';
        v.muted = true;
        v.playsInline = true;          /* iOS 必需：防全屏接管 */
        v.setAttribute('playsinline', '');   /* iOS 旧版属性 */
        v.setAttribute('webkit-playsinline', '');
        /* 挂入 DOM（隐藏）：游离 video 在部分平台解码不可靠（黑屏/停帧根因） */
        v.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;' +
          'opacity:0.01;pointer-events:none;z-index:-1;';
        document.body.appendChild(v);
        return v;
      })();
    video.srcObject = stream;
    try {
      await video.play();
    } catch (e) {
      /* iOS 偶发 play() 竞态：等一帧再试一次 */
      await new Promise(function (r) { setTimeout(r, 200); });
      try { await video.play(); } catch (e2) { /* 继续走，readyState 检查会兜底 */ }
    }

    if (!window.Hands) {
      /* 加载本地 MediaPipe（手机首次约 1-2s，加载中给反馈） */
      hud.classList.add('show');
      hudSay('手势引擎加载中…');
      try {
        await new Promise(function (res, rej) {
          var s = document.createElement('script');
          s.src = 'lib/mediapipe/hands.js';
          s.onload = res;
          s.onerror = rej;
          document.head.appendChild(s);
        });
      } catch (e) {
        hudSay('手势引擎加载失败（检查网络后重试）', true);
        setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 4000);
        return;
      }
    }

    if (!snapCanvas) {
      snapCanvas = document.createElement('canvas');
      snapCanvas.width = 320;
      snapCanvas.height = 240;
      snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });
    }

    hands = new window.Hands({ locateFile: locateFile });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: IS_LIKE_MOBILE ? 0 : 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.55,
      selfieMode: true,
      delegate: delegate              /* CPU(WebAssembly) 或 GPU(WebGL) */
    });

    camOn = true;
    btn.classList.add('on');
    hud.classList.add('show');
    hudSay('手势识别已开启 ✋ 抬手到镜头前');

    /* 诊断接口：面板/对话里可随时读取识别链路各环节状态 */
    window.BlogGesture.diag = function () {
      return {
        camOn: camOn,
        videoState: video.readyState,          /* 2=有画面 */
        videoW: video.videoWidth,              /* 0=还没出帧 */
        paused: video.paused,
        send: sendCount, result: resultCount, fail: failCount,
        inferring: inferring, stalls: stallCount,
        backend: delegate, build: window.__BUILD || '?'
      };
    };

    /* 推理循环 v2：背压式（深度 1）——上一帧 onResults 没回来就不发下一帧。
       原定时发送会让 WASM 推理在主线程排队堆积，
       把 3D 渲染和手势事件全部拖卡（本次卡顿的根因）。
       setTimeout 独立节流，不受渲染帧率影响。 */
    var SEND_GAP = 66;   /* 15fps 推理：手势识别足够，为主线程减压 */
    var lowPower = false;   /* 慢机器自适应：连续停滞后自动降到 2 秒一帧 */
    var inferring = false;
    var stallCount = 0;
    var stallRebuilt = false;
    var lastSend = 0;
    var sendCount = 0;
    var failCount = 0;
    var resultCount = 0;

    /* 预览循环：独立于推理——就算推理卡死，摄像头画面照常显示 */
    var previewLoop = function () {
      if (!camOn) return;
      drawHudCanvas(lastLms);
      requestAnimationFrame(previewLoop);
    };
    requestAnimationFrame(previewLoop);
    var firstResultAt = 0;
    var camStartedAt = performance.now();
    var retried = false;

    var origOnResults = onResults;
    onResults = function (res) {
      inferring = false;
      resultCount++;
      if (!firstResultAt) firstResultAt = performance.now();
      lastLms = (res && res.multiHandLandmarks && res.multiHandLandmarks.length)
        ? res.multiHandLandmarks[0] : null;
      origOnResults(res);
    };
    /* 关键：注册包装后的回调（旧版此步缺失导致时序错乱） */
    hands.onResults(onResults);

    var pump = function () {
      if (!camOn) return;
      var t = performance.now();
      /* 慢帧不干预：背压机制自动调节节奏（快机器快、慢机器慢），
         强行重建只会冷启动更慢陷入死循环（已踩坑）。
         真死管道由 15s 看门狗兜底 */
      var gap = lowPower ? 2000 : SEND_GAP;
      if (!inferring &&
          t - lastSend > gap &&
          video.readyState >= 2 && video.videoWidth > 0) {
        inferring = true;
        sendCount++;
        lastSend = t;
        try {
          /* 视频 → 快照画布 → 推理（绕开 video 纹理直传的驱动兼容问题） */
          snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
          hands.send({ image: snapCanvas });
        } catch (e) {
          inferring = false;
          failCount++;
          hudSay('推理异常：' + String(e && e.message || e).slice(0, 80), true);
        }
      }
      /* 推理停滞自恢复：4 秒无结果 → 解除卡死；二次停滞 → 重建引擎一次 */
      if (inferring && firstResultAt && t - lastSend > 6000) {
        inferring = false;
        stallCount++;
        hudSay('推理停滞 ' + stallCount + ' 次（send ' + sendCount +
          ' / result ' + resultCount + ' / fail ' + failCount + '）');
        if (stallCount >= 2 && !lowPower) {
          lowPower = true;
          hudSay('检测到高负载，已切换低功耗模式（2 秒一帧）');
        }
        if (stallCount >= 2 && !stallRebuilt) {
          stallRebuilt = true;
          try { hands.close(); } catch (e) {}
          hands = new window.Hands({ locateFile: locateFile });
          hands.setOptions({
            maxNumHands: 2,
            delegate: delegate,
            modelComplexity: 0,          /* 重建用轻量模型 */
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.55,
            selfieMode: true
          });
          hands.onResults(onResults);
        }
      }
      /* 看门狗：开启 8 秒仍无任何推理结果 → 重建引擎（最多 1 次），
         二次仍失败则明确告知兼容性问题，不再无限循环 */
      if (firstResultAt === 0 && performance.now() - camStartedAt > 15000 && !retried) {
        if (rebuildCount >= 1) {
          retried = true;
          hudSay('此浏览器的 WASM 环境不兼容，建议改用 Chrome 并更新显卡驱动', true);
          stopCamera();
          return;
        }
        rebuildCount++;
        retried = true;
        hudSay('引擎推理异常，自动重建…');
        try { hands.close(); } catch (e) {}
        hands = null;
        setTimeout(function () { if (camOn) { camOn = false; startCamera(); } }, 300);
        return;
      }
      setTimeout(pump, SEND_GAP);
    };
    setTimeout(pump, SEND_GAP);
  }

  function stopCamera() {
    camOn = false;
    window.__gesturePinching = false;
    btn.classList.remove('on');
    hud.classList.remove('show');
    /* 会话复位：下次开启是干净状态 */
    state.cur = 'none';
    state.cand = 'none';
    state.candCount = 0;
    state.pinchDown = false;
    state.palmSm = null;
    twoHandRef = null;
    lostFrames = 0;
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    updateHud(null);
    hudSay('手势识别已关闭');
  }

  /* 主手连续性：多手时选「离上一帧主手最近」的，防止双手交错时跳变 */
  var lastWrist = null;

  function pickMainHand(lms) {
    if (!lms || !lms.length) return null;
    if (lms.length === 1 || !lastWrist) {
      lastWrist = lms[0][0];
      return lms[0];
    }
    var best = null, bd = 1e9;
    for (var i = 0; i < lms.length; i++) {
      var d = dist(lms[i][0], lastWrist);
      if (d < bd) { bd = d; best = lms[i]; }
    }
    lastWrist = best[0];
    return best;
  }

  /* 检测质量监控：连续丢帧提示改善环境 */
  var lostFrames = 0;
  function onNoHand() {
    lostFrames++;
    window.__gesturePinching = false;
    if (state.pinchDown) {
      state.pinchDown = false;
      fireEvent('pinchend', {});
    }
    state.cur = 'none';
    state.cand = 'none';
    if (lostFrames === 45) {          /* ~1.5s 无手 */
      hudSay('未检测到手：调整距离（40-60cm）与光照', true);
    }
    updateHud(null);
  }

  /* 自适应性能：连续慢帧自动降模型精度 */
  var slowFrames = 0;
  function adaptPerf(dtMs) {
    if (dtMs > 55) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames >= 20 && hands && perfLevel > 0) {
      perfLevel = 0;
      hands.setOptions({ modelComplexity: 0 });
      hudSay('已切轻量模式（低配设备自适应）');
      slowFrames = 0;
    }
  }
  var perfLevel = 1;
  var lastFrameTs = 0;

  function onResults(res) {
    var now = performance.now();
    if (lastFrameTs) adaptPerf(now - lastFrameTs);
    lastFrameTs = now;

    var lms = res.multiHandLandmarks;
    drawHudCanvas(lastLms);   /* v34 改签名后此调用漏改——传 res 导致每次推理抛异常 */
    if (!lms || !lms.length) { onNoHand(); return; }
    if (lostFrames >= 45) hudSay('手势识别中 ✋');
    lostFrames = 0;

    var mainLm = pickMainHand(lms);
    lm8Cache = mainLm[8];
    var g = classifyHand(mainLm, false);
    onClassified(g, mainLm);

    /* 双手捏合 → 缩放（自由模式） */
    if (lms.length > 1) {
      var other = lms[0] === mainLm ? lms[1] : lms[0];
      var g2 = classifyHand(other, false);
      if (g && g.type === 'pinch' && g2 && g2.type === 'pinch') {
        var d = dist(mainLm[4], other[4]);
        if (twoHandRef == null) twoHandRef = d;
        else {
          var factor = d / twoHandRef;
          if (Math.abs(factor - 1) > 0.05) {
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
  /* HUD 状态文本对读屏可感知（aria-hidden 内的实时区） */
  var live = document.createElement('div');
  live.setAttribute('aria-live', 'polite');
  live.style.position = 'absolute';
  live.style.width = '1px';
  live.style.height = '1px';
  live.style.overflow = 'hidden';
  document.body.appendChild(live);
  var origHudSay = hudSay;
  hudSay = function (msg, bad) { origHudSay(msg, bad); live.textContent = msg; };
  hud.innerHTML =
    '<div class="gh-title"><span class="gh-dot"></span>手势识别' +
    '<button id="gh-close" type="button" aria-label="关闭手势识别">✕</button></div>' +
    '<div class="gh-view"><canvas id="gh-canvas" width="208" height="156"></canvas></div>' +
    '<div class="gh-status" id="gh-status">把手放到镜头前</div>' +
    '<div class="gh-legend">✊静止 · ✋恢复/视角 · 🤏抓取 · ☝️指针<br>👍快进 · 👎慢放 · ✌️线框 · L=主题</div>';
  document.body.appendChild(hud);

  var toast = document.createElement('div');
  toast.id = 'gesture-toast';
  toast.setAttribute('aria-live', 'polite');
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

  function drawHudCanvas(lm) {
    /* 参数：主手 21 关键点缓存或 null（预览循环独立于推理持续绘制） */
    var w = ghCanvas.width, h = ghCanvas.height;
    ghCtx.clearRect(0, 0, w, h);
    if (!video || video.readyState < 2 || !video.videoWidth) {
      ghCtx.fillStyle = 'rgba(0,0,0,0.55)';
      ghCtx.fillRect(0, 0, w, h);
      ghCtx.fillStyle = 'rgba(165, 200, 240, 0.9)';
      ghCtx.font = '11px ui-monospace, monospace';
      ghCtx.textAlign = 'center';
      ghCtx.fillText('等待摄像头画面… RS=' + (video ? video.readyState : '-'),
        w / 2, h / 2);
      return;
    }
    ghCtx.save();
    ghCtx.translate(w, 0);
    ghCtx.scale(-1, 1);
    /* 美颜三连：提亮白皙 → 磨皮平滑 → 柔光罩 */
    ghCtx.filter = 'brightness(1.13) contrast(0.93) saturate(0.85)';
    ghCtx.drawImage(video, 0, 0, w, h);
    ghCtx.filter = 'blur(2px)';
    ghCtx.globalAlpha = 0.30;               /* 模糊层叠刷 = 磨皮 */
    ghCtx.drawImage(video, 0, 0, w, h);
    ghCtx.filter = 'none';
    ghCtx.globalCompositeOperation = 'soft-light';
    ghCtx.globalAlpha = 0.20;
    ghCtx.fillStyle = '#fffdf6';            /* 白皙柔光罩 */
    ghCtx.fillRect(0, 0, w, h);
    ghCtx.globalCompositeOperation = 'source-over';
    ghCtx.globalAlpha = 1;
    ghCtx.restore();
    if (!lm) return;
    {
      /* 连线 */
      ghCtx.strokeStyle = 'rgba(125, 211, 252, 0.75)';
      ghCtx.lineWidth = 1.6;
      for (var c = 0; c < CONNECTIONS.length; c++) {
        var a = lm[CONNECTIONS[c][0]], b = lm[CONNECTIONS[c][1]];
        ghCtx.beginPath();
        ghCtx.moveTo(a.x * w, a.y * h);
        ghCtx.lineTo(b.x * w, b.y * h);
        ghCtx.stroke();
      }
      /* 关键点：指尖亮 */
      for (var k = 0; k < 21; k++) {
        var isTip = (k === 4 || k === 8 || k === 12 || k === 16 || k === 20);
        ghCtx.fillStyle = isTip ? '#a5f3fc' : 'rgba(196,181,253,0.9)';
        ghCtx.beginPath();
        ghCtx.arc(lm[k].x * w, lm[k].y * h, isTip ? 3 : 2, 0, 6.2832);
        ghCtx.fill();
      }
      /* 捏合指示圈 */
      var pinD = dist(lm[4], lm[8]) / palmSize(lm);
      if (pinD < 0.5) {
        ghCtx.strokeStyle = pinD < 0.35 ? '#67e8f9' : 'rgba(103,232,249,0.4)';
        ghCtx.lineWidth = 2;
        ghCtx.beginPath();
        ghCtx.arc(lm[4].x * w, lm[4].y * h, 10, 0, 6.2832);
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
    /* 无特定手势时的活性心跳：让用户确认识别在持续运行 */
    if (resultCount > 0 && state.cur === 'none') {
      hudSay('识别中 · 已处理 ' + resultCount + ' 帧');
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
    /* 推理后端热切换：CPU=WebAssembly / GPU=WebGL（调节台调用） */
    setBackend: function (d) {
      if (d !== 'CPU' && d !== 'GPU') return false;
      if (delegate === d) return true;
      delegate = d;
      if (camOn) {   /* 热切换：关流重开 */
        stopCamera();
        setTimeout(startCamera, 250);
      }
      return true;
    },
    backend: function () { return delegate; },
    /* 推理后端热切换：CPU=WebAssembly / GPU=WebGL（调节台调用） */
    setBackend: function (d) {
      if (d !== 'CPU' && d !== 'GPU') return false;
      if (delegate === d) return true;
      delegate = d;
      if (camOn) {   /* 热切换：关流重开 */
        stopCamera();
        setTimeout(startCamera, 250);
      }
      return true;
    },
    backend: function () { return delegate; },
    fingersUp: fingersUp,
    state: state,
    isOn: function () { return camOn; }
  };
})();
