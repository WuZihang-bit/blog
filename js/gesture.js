/* ==========================================================================
   吴子航的博客 · 手势交互系统（MediaPipe Tasks · HandLandmarker · 仅首页）
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
   - 双手捏合开合      → 自由模式缩放

   工程要点（v5.1 识别管线）：
   - 关键点级 One Euro 平滑（21 点 × x/y，MediaPipe 官方同款思路）→ 分类前先去抖
   - 手指伸直判定：PIP 关节角（旋转不变）+ 单指滞回双阈值（伸>160°/曲<130°）
   - 捏合输出连续力度 0-1（ForcePinch/visionOS 思路），驱动 UI 力度环与渐进交互
   - 时序稳定：滑动窗口多数投票（5 帧取 ≥3）+ 确认滞回（HOLD_FRAMES）
   - 运动锁：手快速移动时锁定手势切换（防拖拽/挥动中误触发）；
     捏合会话退出阈值随手速自适应放宽（运动模糊导致的距离膨胀不误松手）
   - 置信度门控：multiHandedness score 连续 3 帧 <0.35 才算丢手（防瞬时低分断抓）
   - UI：visionOS 式跟随光标（捏合力度环）+ 活动手势图例高亮 + 链路状态徽章
   - classifyHand() 是纯函数（可离线测试），不依赖摄像头
   - 隐私：视频只在本地推理，不上传；HUD 可随时关闭摄像头
   ========================================================================== */

(function () {
  'use strict';

  if (!window.Solar3D) return;
  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  /* 移动端判定：窄屏或「主输入是粗指针」（真手机/平板）。
     不能用 maxTouchPoints——触屏笔记本也有触摸点，会被误判成手机
     而跳过光标等桌面功能（R4 实测踩坑：1366×768 触屏本） */
  var IS_LIKE_MOBILE = window.innerWidth < 768 ||
    (window.matchMedia('(pointer: coarse)').matches &&
     !window.matchMedia('(pointer: fine)').matches);

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

  /* 关节角：b 为顶点，返回 ∠abc（度）。180=伸直，越小越弯曲。
     角度法对手掌旋转不变——距离比例法在手掌侧转/倒立时会误判（业界主流做法） */
  function jointAngle(a, b, c) {
    var v1x = a.x - b.x, v1y = a.y - b.y, v1z = (a.z || 0) - (b.z || 0);
    var v2x = c.x - b.x, v2y = c.y - b.y, v2z = (c.z || 0) - (b.z || 0);
    var l1 = Math.sqrt(v1x * v1x + v1y * v1y + v1z * v1z) || 1e-6;
    var l2 = Math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z) || 1e-6;
    var cos = (v1x * v2x + v1y * v2y + v1z * v2z) / (l1 * l2);
    return Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI;
  }

  /* 各指伸直判断：PIP 关节角 + 单指滞回（双阈值法，Unity XR Hands 同思路）。
     伸直 >160° / 弯曲 <130°，中间地带保持上一帧状态——
     关节角在阈值附近抖动时手指状态不翻转（根治 open/fist 边界抖动）。
     prev：上一帧 fingers 数组（调用方保存），纯函数不带内部状态 */
  var FINGER_STRAIGHT = 160;
  var FINGER_CURLED = 130;

  function fingersUp(lm, prev) {
    var up = [];
    var defs = [[5, 6, 8], [9, 10, 12], [13, 14, 16], [17, 18, 20]];
    for (var i = 0; i < 4; i++) {
      var ang = jointAngle(lm[defs[i][0]], lm[defs[i][1]], lm[defs[i][2]]);
      if (ang > FINGER_STRAIGHT) up.push(true);
      else if (ang < FINGER_CURLED) up.push(false);
      else up.push(prev ? prev[i + 1] : ang > 145);
    }
    /* 拇指：IP 关节角 + 张开跨度（纯角度对拇指内收/外展不敏感，需跨度辅助） */
    var ipAng = jointAngle(lm[2], lm[3], lm[4]);
    var span = dist(lm[4], lm[17]) / Math.max(dist(lm[0], lm[9]), 0.02);
    if (ipAng > 150 && span > 0.95) up.unshift(true);
    else if (ipAng < 135 || span < 0.8) up.unshift(false);
    else up.unshift(prev ? prev[0] : false);
    return up; /* [拇指, 食指, 中指, 无名, 小指] */
  }

  function classifyHand(lm, mirrored, prevFingers) {
    if (!lm || lm.length < 21) return null;
    var m = mirrored ? -1 : 1;
    var up = fingersUp(lm, prevFingers);
    var count = up.filter(Boolean).length;
    var ref = palmSize(lm);

    var pinchDist = dist(lm[4], lm[8]) / ref;         /* 捏合度（越小越捏紧） */
    /* 捏合力度 0-1 连续量：≤0.20 全捏=1，≥0.55 全开=0（ForcePinch/visionOS 思路） */
    var pinchStrength = Math.max(0, Math.min(1, (0.55 - pinchDist) / 0.35));
    var palm = {
      x: (lm[0].x + lm[5].x + lm[17].x) / 3,
      y: (lm[0].y + lm[9].y) / 2
    };

    /* 手势判定（优先级从高到低）。
       注意：不设「拇指+食指」类手势（如 L/OK）——捏合与松开的过渡
       必然经过该形状，映射任何动作都会高频误触发 */
    var type = 'none';

    /* 点赞/倒赞：仅拇指伸直（比 fist 更具体，须先判） */
    if (up[0] && !up[1] && !up[2] && !up[3] && !up[4]) {
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
      pinchStrength: pinchStrength,
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
     二、手势状态机（滑动窗口投票 + 运动锁 + 事件）
     ====================================================== */

  var HOLD_FRAMES = 3;     /* 候选手势达到 3 帧多数才确认 */
  /* 滑动窗口多数投票（arXiv 1901.10323 等实时手势识别标准做法）：
     单帧误分类被窗口内多数票吸收，比「连续 N 帧」更抗噪——
     连续计数法一帧噪声就清零重来，窗口法容忍窗口内 2 帧噪声 */
  var VOTE_WIN = 5;
  var VOTE_MIN = 3;
  var voteWin = [];

  /* 滞回双阈值（Ultraleap 官方推荐做法）：
     进入捏合要紧（0.35），松开判定要宽（0.58）——
     抓取期间指尖微颤不会意外松手 */
  var PINCH_ENTER = 0.35;
  var PINCH_EXIT = 0.58;

  /* 运动锁：手快速移动时 MediaPipe 关键点因运动模糊膨胀、分类抖动加剧，
     锁定手势切换可杜绝「拖拽中误触发时间快进」这类事故；
     捏合的「进入」不受锁（否则抓取无法在移动中发起），
     捏合的「退出」阈值随手速放宽（运动模糊让指间距虚增，不误松手） */
  var TRANS_LOCK_SPEED = 1500;   /* 屏幕像素/秒 */
  var pinchSpeed = 0;            /* 平滑后的捏合点速度 */
  var lastPinchScreen = null;

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

    /* 捏合点（拇指食指中点）经 OneEuro 平滑——比掌心更跟手更准 */
    var px = (lm[4].x + lm[8].x) / 2;
    var py = (lm[4].y + lm[8].y) / 2;
    var tSec = now / 1000;
    var sx = pinchFx.filter(px, tSec);
    var sy = pinchFy.filter(py, tSec);
    var pinchX = Math.round(sx * window.innerWidth);
    var pinchY = Math.round(sy * window.innerHeight);

    /* 捏合点速度（EMA 平滑）：运动锁与拖拽稳定性都用它 */
    if (lastPinchScreen) {
      var dtMs = Math.max(now - lastPinchScreen.t, 1);
      var spd = Math.sqrt(
        (pinchX - lastPinchScreen.x) * (pinchX - lastPinchScreen.x) +
        (pinchY - lastPinchScreen.y) * (pinchY - lastPinchScreen.y)) / dtMs * 1000;
      pinchSpeed = pinchSpeed * 0.65 + spd * 0.35;
    }
    lastPinchScreen = { x: pinchX, y: pinchY, t: now };
    var moving = pinchSpeed > TRANS_LOCK_SPEED;

    /* 手势确认：pinch 会话滞回 → 运动锁 → 投票 */
    var effType = g.type;
    if (state.pinchDown) {
      var exitTh = PINCH_EXIT * (moving ? 1.35 : 1);   /* 快速移动放宽 35% */
      if (g.pinch > exitTh) effType = (effType === 'pinch') ? 'none' : effType;
      else effType = 'pinch';   /* 会话中：只要还捏着就保持 pinch */
    } else if (moving && state.cur !== 'none' && effType !== 'pinch') {
      effType = state.cur;   /* 移动中锁定当前手势（捏合进入放行） */
    }

    /* 滑动窗口多数投票 */
    voteWin.push(effType);
    if (voteWin.length > VOTE_WIN) voteWin.shift();
    var votes = {}, bestType = 'none', bestN = 0;
    for (var vi = 0; vi < voteWin.length; vi++) {
      votes[voteWin[vi]] = (votes[voteWin[vi]] || 0) + 1;
      if (votes[voteWin[vi]] > bestN) { bestN = votes[voteWin[vi]]; bestType = voteWin[vi]; }
    }
    var voted = bestN >= Math.min(VOTE_MIN, voteWin.length) ? bestType : 'none';

    if (voted === state.cand) state.candCount++;
    else { state.cand = voted; state.candCount = bestN; }

    var confirmed = null;
    if (state.candCount >= HOLD_FRAMES && state.cur !== state.cand) {
      state.cur = state.cand;
      state.since = now;
      confirmed = state.cur;
    }

    /* 食指尖（point 指针） */
    var tipX = lm[8].x;
    var tipY = lm[8].y;

    g.confirmed = confirmed;

    /* 持续类手势数据流（每帧）+ 光标反馈 */
    if (state.cur === 'pinch') {
      fireEvent('pinchmove', { x: pinchX, y: pinchY, pinch: g.pinch, strength: g.pinchStrength });
      updateCursor('pinch', pinchX, pinchY, g.pinchStrength, true);
    } else if (state.cur === 'point') {
      var tipSX = Math.round(tipX * window.innerWidth);
      var tipSY = Math.round(tipY * window.innerHeight);
      fireEvent('pointmove', { x: tipSX, y: tipSY });
      updateCursor('point', tipSX, tipSY, 0, false);
    } else if (state.cur === 'open') {
      fireEvent('palmmove', {
        nx: (lm[0].x + lm[5].x + lm[17].x) / 3,
        ny: (lm[0].y + lm[9].y) / 2
      });
      updateCursor(null, 0, 0, 0, false);
    } else {
      updateCursor(null, 0, 0, 0, false);
    }

    /* 确认沿（一次性动作，带冷却） */
    if (confirmed) {
      var cool = COOLDOWN[confirmed] || 600;
      if (!state.lastFire[confirmed] || now - state.lastFire[confirmed] > cool) {
        state.lastFire[confirmed] = now;
        evPush('确认手势: ' + confirmed);
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
    peace: 1200, point: 400, pinch: 400
  };

  var lm8Cache = null;   /* 食指尖（point 用） */
  var lastLms = null;    /* 主手骨架缓存（onResults 写 / 预览读） */
  /* 事件环形缓冲：记录关键转换，卡顿时可精确回放卡在哪一环 */
  var evRing = [];
  var evPush = function (msg) {
    evRing.push('[' + (performance.now() / 1000).toFixed(1) + 's] ' + msg);
    if (evRing.length > 24) evRing.shift();
  };

  /* ======================================================
     二点五、关键点级平滑（21 点 × x/y，One Euro）
     MediaPipe 官方管线同样用 One Euro 做关键点平滑：
     静止时高精度抑抖，快速移动时自动放宽截止频率保低延迟。
     分类与预览都吃平滑后的关键点——分类稳定性大幅提升。
     ====================================================== */

  var LM_SMOOTH_CUTOFF = 1.7;   /* 静止截止频率：越小越稳，越大越跟手 */
  var LM_SMOOTH_BETA = 0.03;    /* 速度增益：越大快速移动延迟越低 */
  var lmSmoothers = null;       /* 21 个 {x, y} 滤波器，丢手重置 */

  function smoothLandmarks(lm, nowMs) {
    var t = nowMs / 1000;
    if (!lmSmoothers) {
      lmSmoothers = [];
      for (var i = 0; i < 21; i++) {
        lmSmoothers.push({
          x: new OneEuro(LM_SMOOTH_CUTOFF, LM_SMOOTH_BETA),
          y: new OneEuro(LM_SMOOTH_CUTOFF, LM_SMOOTH_BETA)
        });
      }
    }
    var out = [];
    for (var k = 0; k < 21; k++) {
      out.push({
        x: lmSmoothers[k].x.filter(lm[k].x, t),
        y: lmSmoothers[k].y.filter(lm[k].y, t),
        z: lm[k].z || 0
      });
    }
    return out;
  }

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
  var mp = null;          /* HandLandmarker 实例（@mediapipe/tasks-vision） */
  var mpLastTs = 0;       /* detectForVideo 时间戳必须单调递增 */
  /* 中间快照画布：不直接喂 video 元素（部分显卡驱动上 WASM 等视频纹理会卡死），
     改为把视频绘到 2D 画布后喂帧——业界通用兼容做法 */
  var snapCanvas = null;
  var snapCtx = null;
  /* 默认 GPU 委托（worker 内单帧约 5-15ms，是识别帧率上限的钥匙；
     GPU 创建失败 worker 内部自动回退 CPU）。调节台可切换并持久化 */
  var DELEGATE_KEY = 'gestureBackend';
  var delegate = 'GPU';
  try {
    var svDe = localStorage.getItem(DELEGATE_KEY);
    if (svDe === 'CPU' || svDe === 'GPU') delegate = svDe;
  } catch (e) { /* localStorage 不可用：用默认 GPU */ }

  /* 资产探活：tasks-vision 共 6 个本地文件，任何 404 都会让管线永不就绪 */
  var MP_DIR = 'lib/mediapipe-tasks/';
  var MP_ASSETS = [
    'vision_bundle.mjs',
    'vision_bundle.worker.js',
    'vision_wasm_internal.js',
    'vision_wasm_internal.wasm',
    'vision_wasm_nosimd_internal.js',
    'vision_wasm_nosimd_internal.wasm',
    'hand_landmarker.task'
  ];

  function probeAssets() {
    return Promise.all(MP_ASSETS.map(function (f) {
      return fetch(MP_DIR + f, { method: 'HEAD' })
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

  /* WebGL 探针：MediaPipe 的 WASM 方案即使 CPU 推理，
     图像预处理（纹理上传/张量变换）也依赖 WebGL——
     硬件加速关闭 / 显卡驱动被黑名单时，症状正是
     「摄像头画面正常但 onResults 永不返回」。必须前置拦截并明确告知 */
  var WEBGL_OK = (function () {
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return false;
      var vs = gl.createShader(gl.VERTEX_SHADER);
      gl.shaderSource(vs, 'attribute vec2 p; void main(){ gl_Position=vec4(p,0.0,1.0); }');
      gl.compileShader(vs);
      var ok = gl.getShaderParameter(vs, gl.COMPILE_STATUS);
      var fs = gl.createShader(gl.FRAGMENT_SHADER);
      gl.shaderSource(fs, 'void main(){ gl_FragColor=vec4(1.0); }');
      gl.compileShader(fs);
      ok = ok && gl.getShaderParameter(fs, gl.COMPILE_STATUS);
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return ok;
    } catch (e) { return false; }
  })();

  /* 引擎日志捕获：MediaPipe 初始化失败只往 console 打日志（页面无感知），
     看门狗停滞时把捕获的日志回显到 HUD，让失败原因自己浮出来 */
  var mpLogs = [];
  var mpConsoleHooked = false;
  function hookMPConsole() {
    if (mpConsoleHooked) return;
    mpConsoleHooked = true;
    ['error', 'warn', 'log'].forEach(function (lv) {
      var orig = console[lv] ? console[lv].bind(console) : function () {};
      console[lv] = function () {
        try {
          var msg = Array.prototype.map.call(arguments, function (a) {
            if (typeof a === 'string') return a;
            if (a instanceof Error) return a.message;
            try { return JSON.stringify(a); } catch (e2) { return String(a); }
          }).join(' ');
          if (/mediapipe|wasm|gl_|webgl|graph|solution|shader|tflite|binarypb|aborted|failed/i.test(msg)) {
            mpLogs.push('[' + lv + '] ' + msg.slice(0, 160));
            if (mpLogs.length > 12) mpLogs.shift();
          }
        } catch (e) { /* 捕获自身异常绝不外泄 */ }
        orig.apply(console, arguments);
      };
    });
  }
  function logTail() {
    return mpLogs.length ? mpLogs.slice(-2).join(' ｜ ') : '无引擎日志';
  }

  var rebuildCount = 0;
  /* 推理链路计数器必须放模块级：updateHud（模块级）的心跳文案要读 resultCount，
     若只在 startCamera 内声明，严格模式下引用即抛 ReferenceError，
     异常顺着 MediaPipe 回调打断推理链 → 推理停滞 → 反复报错 */
  var sendCount = 0, resultCount = 0, failCount = 0;
  var inferring = false, stallCount = 0;
  /* 包装回调与计时戳也必须模块级单例：若在 startCamera 里每次重新包装，
     第二次开启会把包装器再包一层——重复平滑、计数翻倍、事件成对触发 */
  var firstResultAt = 0;
  var lastSendWall = 0;

  /* MediaPipe 结果包装器（唯一实例）：计数 / 延迟 / 关键点平滑后分发 */
  function mpOnResults(res) {
    inferring = false;
    resultCount++;
    if (lastSendWall) lastLatency = Math.round(performance.now() - lastSendWall);
    if (!firstResultAt) firstResultAt = performance.now();
    var hasHands = res && res.multiHandLandmarks && res.multiHandLandmarks.length;
    evPush(hasHands ? '帧: 检测到手' : '帧: 无手');
    if (hasHands) {
      /* 关键点平滑后分发：分类、预览、双手缩放吃同一份平滑坐标 */
      var smAll = res.multiHandLandmarks.map(function (h) {
        return smoothLandmarks(h, performance.now());
      });
      lastLms = smAll[0];
      var res2 = {};
      for (var kk in res) res2[kk] = res[kk];
      res2.multiHandLandmarks = smAll;
      onResults(res2);   /* 转发给真正的识别处理（此前遗漏导致识别链断裂） */
    } else {
      lastLms = null;
      onResults(res);
    }
  }

  /* tasks-vision 结果 → 统一包装格式（计数/平滑/分类链路整链复用）。
     x 取 1-x 镜像：等价于 legacy 的 selfieMode——
     摄像头原图不镜像，直接映射屏幕会让「手向右移、光标向左跑」 */
  function feedFromTasks(r) {
    var lms = (r && r.landmarks ? r.landmarks : []).map(function (hand) {
      return hand.map(function (p) { return { x: 1 - p.x, y: p.y, z: p.z }; });
    });
    var handed = (r && (r.handedness || r.handednesses)) || [];
    mpOnResults({
      multiHandLandmarks: lms,
      multiHandedness: handed.map(function (h) {
        return (h && h.length) ? h : [{ score: 1 }];
      })
    });
  }

  /* ---- 推理 Worker（优先）与主线程同步引擎（回退） ----
     Worker 把 detectForVideo（约 30-50ms/帧）摘出主线程：
     3D 场景与光标不再被推理阻塞，这是「交互卡顿」的根治方案 */
  var gWorker = null;
  var workerReady = false;
  var workerFailed = false;
  var workerReadyRes = null;
  var workerReadyPromise = null;
  var pendingBitmaps = 0;    /* 背压：上一帧位图未回结果前不发新帧（深度 1） */
  var detectMsEma = 0;
  var workerDelegate = null; /* Worker 内实际生效的委托（GPU 可能失败回退 CPU） */
  /* 识别帧率（调节台滑杆实时可调，localStorage 持久化）：
     gap = 1000/fps；实际帧率 = min(设定值, 1000/单帧推理耗时) —— 背压兜底 */
  var FPS_KEY = 'gestureFps';
  function fpsToGap(fps) {
    return Math.max(15, Math.min(200, Math.round(1000 / fps)));
  }
  var savedFps = 30;
  try {
    var svFps = parseInt(localStorage.getItem(FPS_KEY), 10);
    if (svFps >= 5 && svFps <= 60) savedFps = svFps;
  } catch (e) { /* 隐私模式等 localStorage 不可用：用默认 30fps */ }
  var SEND_GAP_W = fpsToGap(savedFps);   /* Worker 模式：独立线程，不占主线程 */
  var curFps = savedFps;
  function setFps(fps) {
    fps = Math.max(5, Math.min(60, Math.round(fps)));
    try { localStorage.setItem(FPS_KEY, String(fps)); } catch (e) {}
    curFps = fps;
    SEND_GAP_W = fpsToGap(fps);
    SEND_GAP = SEND_GAP_W;   /* 同步回退模式同拍 */
    return fps;
  }
  function getFps() {
    return curFps;
  }

  function ensureWorker() {
    if (workerFailed || typeof Worker === 'undefined') return null;
    if (gWorker) return workerReadyPromise;   /* 已存在：暖实例直接复用 */
    try {
      gWorker = new Worker('js/gesture-worker.js');   /* 经典 Worker：wasm 加载器需要 importScripts */
    } catch (e) {
      workerFailed = true;
      return null;
    }
    gWorker.onmessage = onWorkerMsg;
    gWorker.onerror = function (e) {
      mpLogs.push('[worker] ' + String(e && e.message || 'Worker 加载失败').slice(0, 160));
      if (!workerReady) {
        workerFailed = true;
        if (workerReadyRes) { workerReadyRes(false); workerReadyRes = null; }
      }
    };
    workerReadyPromise = new Promise(function (res) { workerReadyRes = res; });
    /* dir 必须是绝对 URL：worker 内 importScripts 相对 worker 脚本解析；
       委托参数透传（GPU 由 worker 内部失败自动回退 CPU） */
    gWorker.postMessage({ type: 'init', dir: new URL(MP_DIR, document.baseURI).href, delegate: delegate });
    return workerReadyPromise;
  }

  function onWorkerMsg(e) {
    var m = e.data || {};
    if (m.type === 'ready') {
      workerReady = true;
      workerDelegate = m.delegate || 'CPU';
      if (workerReadyRes) { workerReadyRes(true); workerReadyRes = null; }
    } else if (m.type === 'error') {
      mpLogs.push('[worker] ' + String(m.message || '').slice(0, 160));
      workerFailed = true;
      if (workerReadyRes) { workerReadyRes(false); workerReadyRes = null; }
    } else if (m.type === 'result') {
      pendingBitmaps = Math.max(0, pendingBitmaps - 1);
      detectMsEma = m.emaMs || detectMsEma;
      onWorkerResult(m);
    } else if (m.type === 'detectError') {
      pendingBitmaps = Math.max(0, pendingBitmaps - 1);
      failCount++;
      hudSay('推理异常：' + String(m.message || '').slice(0, 80), true);
    }
  }

  function onWorkerResult(m) {
    var hands = m.landmarks || [];
    mpOnResults({
      multiHandLandmarks: hands,
      multiHandedness: (m.conf || []).map(function (s) {
        return [{ score: typeof s === 'number' ? s : 1 }];
      })
    });
  }

  async function startCamera(fromRebuild) {
    if (camOn) return;
    /* 每次开启都是新会话：心跳/诊断计数从头累计；
       rebuildCount 只在看门狗触发的重建链上保留（防无限重建），
       用户手动开启必须重置，否则上次会话重建过会让本次慢启动被误判「环境不兼容」 */
    if (!fromRebuild) rebuildCount = 0;
    sendCount = 0; resultCount = 0; failCount = 0;
    inferring = false; stallCount = 0;
    firstResultAt = 0; lastSendWall = 0;

    /* 管线健康预检：资产完整性 + SIMD 支持。
       任何缺失都会导致「推理永不返回 → 看门狗无限重建」，必须前置拦截 */
    hud.classList.add('show');
    hudSay('检查手势引擎资源…');
    /* 探活看门狗：网络慢或请求挂起时不能永远停在「检查资源」；
       4 秒探不完就跳过预检直接加载（资产真缺失时引擎加载失败会兜底报错） */
    var missing = await Promise.race([
      probeAssets(),
      new Promise(function (res) { setTimeout(function () { res(null); }, 4000); })
    ]);
    if (missing && missing.length) {
      hudSay('引擎文件缺失：' + missing.join(', '), true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 6000);
      return;
    }
    if (!SIMD_OK) {
      /* 非 SIMD 环境：FilesetResolver 会自动改用 nosimd wasm（已备齐文件） */
      hudSay('检测到无 SIMD 支持，已切换兼容模式');
    }
    if (!WEBGL_OK) {
      hud.classList.add('show');
      hudSay('显卡 WebGL 不可用（手势识别必需）：Chrome 设置→系统→开启「使用硬件加速」后重启浏览器；若在远程桌面/虚拟机中请换本机浏览器', true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 12000);
      return;
    }
    hookMPConsole();   /* 从这里开始捕获引擎日志，失败时回显 */

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
    /* play() 的 promise 在隐藏标签页/自动播放受限时会永远挂起（不是拒绝），
       把 startCamera 整个冻结在这——必须限时放行；
       后续 pump 与 drawHudCanvas 的 readyState 守卫会兜住「无画面」状态 */
    try {
      await Promise.race([
        video.play(),
        new Promise(function (r) { setTimeout(r, 3000); })
      ]);
    } catch (e) {
      /* iOS 偶发 play() 竞态：等一帧再试一次 */
      await new Promise(function (r) { setTimeout(r, 200); });
      try { await Promise.race([video.play(), new Promise(function (r) { setTimeout(r, 3000); })]); } catch (e2) { /* 继续走，readyState 检查会兜底 */ }
    }

    if (!snapCanvas) {
      snapCanvas = document.createElement('canvas');
      snapCanvas.width = 320;
      snapCanvas.height = 240;
      snapCtx = snapCanvas.getContext('2d', { willReadFrequently: true });
    }

    /* 引擎选择：Worker 承接 CPU/GPU 两种委托（GPU 由 worker 内部
       失败自动回退 CPU 并如实上报）；Worker 不可用才走主线程同步回退 */
    var useWorker = false;
    {
      var wp = ensureWorker();
      if (wp) {
        hud.classList.add('show');
        if (!workerReady) hudSay('手势引擎加载中…（首次约 5-15s）');
        var wok = await Promise.race([
          wp,
          new Promise(function (res) { setTimeout(function () { res(false); }, 20000); })
        ]);
        if (wok) {
          useWorker = true;
        } else {
          hudSay('推理 Worker 不可用，回退主线程模式');
        }
      }
    }
    if (!useWorker) {
    /* 同步回退引擎：@mediapipe/tasks-vision HandLandmarker（官方对已停维护
       legacy solutions 的替代品）。detectForVideo 同步返回结果——
       legacy「send 后 onResults 永不触发」的整类静默故障从机制上消失 */
    if (!window.__MPVision) {
      hud.classList.add('show');
      hudSay('手势引擎加载中…（首次约 5-15s）');
      try {
        /* import() 相对的是脚本自身 URL（js/），必须先解析成基于页面的
           绝对地址——本地站点根路径与 GitHub Pages 子路径都正确 */
        window.__MPVision = await import(new URL(MP_DIR + 'vision_bundle.mjs', document.baseURI).href);
      } catch (e) {
        hudSay('手势引擎加载失败：' + String(e && e.message || e).slice(0, 80) +
          ' ｜ ' + logTail(), true);
        setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 9000);
        return;
      }
    }

    try {
      var fileset = await window.__MPVision.FilesetResolver.forVisionTasks(MP_DIR);
      var createWith = function (dg) {
        return window.__MPVision.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MP_DIR + 'hand_landmarker.task', delegate: dg },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.55,
          minTrackingConfidence: 0.55
        });
      };
      hudSay('手势引擎初始化中（' + delegate + '）…');
      try {
        mp = await createWith(delegate === 'GPU' ? 'GPU' : 'CPU');
      } catch (eGpu) {
        /* 官方迁移模式：GPU 创建失败自动回退 CPU */
        if (delegate === 'GPU') {
          hudSay('GPU 初始化失败，自动回退 CPU');
          delegate = 'CPU';
          mp = await createWith('CPU');
        } else {
          throw eGpu;
        }
      }
    } catch (e) {
      hudSay('手势引擎初始化失败：' + String(e && e.message || e).slice(0, 80) +
        ' ｜ ' + logTail(), true);
      setTimeout(function () { if (!camOn) hud.classList.remove('show'); }, 9000);
      return;
    }
    }

    camOn = true;
    btn.classList.add('on');
    btn.setAttribute('aria-pressed', 'true');
    hud.classList.add('show');
    hudSay('手势识别已开启 ✋ 抬手到镜头前');

    /* 快照亮度探针：直接测量喂给 MediaPipe 的画布内容（黑帧检测） */
    window.BlogGesture.snapLum = function () {
      try {
        var d = snapCtx.getImageData(0, 0, snapCanvas.width, snapCanvas.height).data;
        var sum = 0, n = 0;
        for (var i = 0; i < d.length; i += 400) {
          sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
          n++;
        }
        return Math.round(sum / n);
      } catch (e) { return 'ERR: ' + e.message; }
    };

    /* 诊断接口：面板/对话里可随时读取识别链路各环节状态 */
    window.BlogGesture.diag = function () {
      return {
        camOn: camOn,
        videoState: video.readyState,          /* 2=有画面 */
        videoW: video.videoWidth,              /* 0=还没出帧 */
        paused: video.paused,
        send: sendCount, result: resultCount, fail: failCount,
        inferring: inferring, stalls: stallCount,
        backend: useWorker ? (workerDelegate || delegate) : delegate,
        build: window.__BUILD || '?',
        webgl: WEBGL_OK, simd: SIMD_OK,
        engine: useWorker ? 'worker' : 'sync',
        detectMs: Math.round(detectMsEma),
        fpsTarget: getFps(),
        logs: mpLogs.slice(-4)
      };
    };

    /* 推理节流：15fps 起步（手势识别足够，为主线程减压）；
       adaptPerf 在慢机器上自动放慢（模块级 SEND_GAP） */
    var lastSend = 0;

    /* 预览循环：独立于推理——就算推理卡死，摄像头画面照常显示；
       顺带驱动跟随光标的惯性插值（60fps）与暗画面探针 */
    var previewFrames = 0;
    var dimWarn = false;
    var previewLoop = function () {
      if (!camOn) return;
      previewFrames++;
      if (previewFrames % 45 === 0 && window.BlogGesture.snapLum) {
        var lum = window.BlogGesture.snapLum();
        dimWarn = typeof lum === 'number' && lum < 22;   /* 平均亮度过低 → 识别率下降 */
      }
      drawHudCanvas(lastLms, dimWarn);
      cursorTick();
      requestAnimationFrame(previewLoop);
    };
    requestAnimationFrame(previewLoop);
    var camStartedAt = performance.now();
    var retried = false;

    var pump = function () {
      if (!camOn) return;
      var t = performance.now();
      if (useWorker) {
        /* Worker 模式：主线程只做「video→快照画布→ImageBitmap 移交」，
           detect 在 worker 线程跑，主线程零阻塞（3D 满帧不卡）。
           背压深度 1：上一帧位图未回结果前不发新帧 */
        if (pendingBitmaps === 0 &&
            t - lastSend > SEND_GAP_W &&
            video.readyState >= 2 && video.videoWidth > 0) {
          sendCount++;
          lastSend = t;
          lastSendWall = t;
          pendingBitmaps++;
          try {
            snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
            createImageBitmap(snapCanvas).then(function (bmp) {
              if (!camOn || !gWorker) {
                if (bmp && bmp.close) bmp.close();
                pendingBitmaps = Math.max(0, pendingBitmaps - 1);
                return;
              }
              gWorker.postMessage({ type: 'detect', bitmap: bmp, ts: performance.now() }, [bmp]);
            }).catch(function () {
              pendingBitmaps = Math.max(0, pendingBitmaps - 1);
            });
          } catch (e) {
            pendingBitmaps = Math.max(0, pendingBitmaps - 1);
            failCount++;
          }
        }
      } else if (t - lastSend > SEND_GAP &&
                 video.readyState >= 2 && video.videoWidth > 0) {
        sendCount++;
        lastSend = t;
        lastSendWall = t;   /* 供 mpOnResults 计算单帧延迟 */
        try {
          /* 视频 → 快照画布 → 推理（绕开 video 纹理直传的驱动兼容问题）。
             detectForVideo 同步返回：出错会抛异常（failCount 兜住），
             正常必有结果——不存在 legacy「回调永不触发」的静默路径 */
          snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
          var ts = performance.now();
          if (ts <= mpLastTs) ts = mpLastTs + 1;   /* 时间戳必须单调递增 */
          mpLastTs = ts;
          var r = mp.detectForVideo(snapCanvas, ts);
          feedFromTasks(r);
        } catch (e) {
          failCount++;
          hudSay('推理异常：' + String(e && e.message || e).slice(0, 80), true);
        }
      }
      /* 看门狗：开启 12 秒仍无任何结果 → 重建引擎（最多 1 次），
         二次仍失败则带上捕获的引擎日志明确告知 */
      if (firstResultAt === 0 && performance.now() - camStartedAt > 12000 && !retried) {
        if (rebuildCount >= 1) {
          retried = true;
          hudSay('推理无法启动：' + logTail() +
            ' —— 多半是显卡驱动/硬件加速问题，建议 Chrome 设置→系统→开启硬件加速后重启', true);
          stopCamera();
          return;
        }
        rebuildCount++;
        retried = true;
        hudSay('引擎推理异常（' + logTail() + '），自动重建…');
        if (useWorker) {
          /* Worker 模式：换一个全新 worker 再试一次（workerFailed 不置位，
             重建仍先试 Worker，再不行下轮会话走同步回退） */
          if (gWorker) { gWorker.terminate(); gWorker = null; }
          workerReady = false;
          workerReadyPromise = null;
          pendingBitmaps = 0;
        } else {
          try { mp.close(); } catch (e) {}
          mp = null;
        }
        setTimeout(function () { if (camOn) { camOn = false; startCamera(true); } }, 300);
        return;
      }
      setTimeout(pump, useWorker ? SEND_GAP_W : SEND_GAP);
    };
    setTimeout(pump, useWorker ? SEND_GAP_W : SEND_GAP);
  }

  function stopCamera() {
    camOn = false;
    window.__gesturePinching = false;
    btn.classList.remove('on');
    btn.setAttribute('aria-pressed', 'false');
    hud.classList.remove('show');
    SEND_GAP = SEND_GAP_W;   /* 会话结束：自适应拉慢的推理节拍复位（跟随设定帧率） */
    /* 会话复位：下次开启是干净状态 */
    state.cur = 'none';
    state.cand = 'none';
    state.candCount = 0;
    state.pinchDown = false;
    state.palmSm = null;
    twoHandRef = null;
    lostFrames = 0;
    voteWin.length = 0;
    fingerHyst = null;
    lmSmoothers = null;
    lastPinchScreen = null;
    pinchSpeed = 0;
    lowConfRun = 0;
    updateCursor(null, 0, 0, 0, false);
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null;
    /* 释放推理引擎实例：下次开启会新建，不关的话每次开关都泄漏一整份 WASM 内存 */
    if (mp) { try { mp.close(); } catch (e) {} mp = null; }
    lastLms = null;
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
  /* 置信度门控：MediaPipe 的 multiHandedness score 在运动模糊/遮挡时骤降，
     单帧低分不丢手（防抓取中被瞬时低分打断），连续 3 帧低分才算真丢 */
  var lowConfRun = 0;
  var lastConf = 0;
  var fpsSm = 0;        /* 识别帧率 EMA（徽章显示用） */
  var lastLatency = 0;  /* 最近一帧 send→result 延迟 ms */
  var fingerHyst = null;  /* 上一帧手指状态（单指滞回用），丢手清零 */

  function onNoHand() {
    lostFrames++;
    window.__gesturePinching = false;
    updateCursor(null, 0, 0, 0, false);
    if (state.pinchDown) {
      state.pinchDown = false;
      fireEvent('pinchend', {});
    }
    state.cur = 'none';
    state.cand = 'none';
    lowConfRun = 0;
    if (lostFrames > 6) {
      /* 手已离开一段时间：平滑器与滞回状态作废（再出现视为新手） */
      lmSmoothers = null;
      fingerHyst = null;
    }
    if (lostFrames === 45) {          /* ~1.5s 无手 */
      hudSay('未检测到手：调整距离（40-60cm）与光照', true);
    }
    updateHud(null);
  }

  /* 自适应性能：连续慢帧自动放慢推理节拍（tasks-vision 不支持运行时
     切换模型复杂度，改为降低推理帧率保主线程 3D 渲染） */
  var SEND_GAP = fpsToGap(savedFps);   /* 与 Worker 模式同拍（同步回退路径用） */
  var slowFrames = 0;
  function adaptPerf(dtMs) {
    if (dtMs > 55) slowFrames++;
    else slowFrames = Math.max(0, slowFrames - 1);
    if (slowFrames >= 20 && SEND_GAP < 200) {
      SEND_GAP = Math.min(SEND_GAP * 2, 200);
      hudSay('已降低推理帧率（' + Math.round(1000 / SEND_GAP) + 'fps，低配自适应）');
      slowFrames = 0;
    }
  }
  var lastFrameTs = 0;

  function onResults(res) {
    var now = performance.now();
    if (lastFrameTs) {
      adaptPerf(now - lastFrameTs);
      var instFps = 1000 / Math.max(now - lastFrameTs, 1);
      fpsSm = fpsSm ? fpsSm * 0.85 + instFps * 0.15 : instFps;
    }
    lastFrameTs = now;

    var lms = res.multiHandLandmarks;
    drawHudCanvas(lastLms);   /* v34 改签名后此调用漏改——传 res 导致每次推理抛异常 */
    if (!lms || !lms.length) { onNoHand(); return; }

    var conf = (res.multiHandedness && res.multiHandedness[0] &&
      typeof res.multiHandedness[0].score === 'number')
      ? res.multiHandedness[0].score : 1;
    lastConf = conf;
    if (conf < 0.35) {
      lowConfRun++;
      if (lowConfRun < 3) return;   /* 瞬时低分：跳过本帧，会话与数据流保持 */
    } else {
      lowConfRun = 0;
    }

    if (lostFrames >= 45) hudSay('手势识别中 ✋');
    lostFrames = 0;

    var mainLm = pickMainHand(lms);
    lm8Cache = mainLm[8];
    var g = classifyHand(mainLm, false, fingerHyst);
    fingerHyst = g.fingers;
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
    '<div class="gh-badges" aria-hidden="true">' +
    '<span class="gh-badge" id="gh-bfps">--fps</span>' +
    '<span class="gh-badge" id="gh-blat">--ms</span>' +
    '<span class="gh-badge" id="gh-bconf">--%</span>' +
    '<span class="gh-badge" id="gh-bbe">CPU</span></div>' +
    '<div class="gh-legend" id="gh-legend" aria-hidden="true"></div>';
  document.body.appendChild(hud);

  /* 活动手势图例：当前手势对应芯片高亮（Magic Leap/visionOS 的状态可视化思路） */
  var LEGEND = [
    ['pinch', '🤏 抓取'], ['point', '☝️ 指针'], ['open', '✋ 视角'], ['fist', '✊ 静止'],
    ['thumbUp', '👍 快进'], ['thumbDown', '👎 慢放'], ['peace', '✌️ 线框']
  ];
  var legendEl = hud.querySelector('#gh-legend');
  var chipEls = {};
  LEGEND.forEach(function (item) {
    var s = document.createElement('span');
    s.className = 'gh-chip';
    s.dataset.g = item[0];
    s.textContent = item[1];
    legendEl.appendChild(s);
    chipEls[item[0]] = s;
  });
  function setChips(cur) {
    for (var kk in chipEls) chipEls[kk].classList.toggle('on', kk === cur);
  }

  /* 链路状态徽章：帧率 / 延迟 / 置信度 / 推理后端，节流 400ms 刷新 */
  var bFps = hud.querySelector('#gh-bfps');
  var bLat = hud.querySelector('#gh-blat');
  var bConf = hud.querySelector('#gh-bconf');
  var bBe = hud.querySelector('#gh-bbe');
  var lastBadgeRefresh = 0;
  function refreshBadges(now) {
    if (now - lastBadgeRefresh < 400) return;
    lastBadgeRefresh = now;
    bFps.textContent = Math.round(fpsSm) + 'fps';
    bLat.textContent = lastLatency + 'ms';
    /* 还没见过手时置信度无意义，显示 — 而非 0% */
    bConf.textContent = lastConf ? Math.round(lastConf * 100) + '%' : '—';
    bBe.textContent = delegate;
  }

  var toast = document.createElement('div');
  toast.id = 'gesture-toast';
  toast.setAttribute('aria-live', 'polite');
  document.body.appendChild(toast);

  /* ---------- 跟随光标（visionOS 式捏合反馈） ----------
     空心环 = 捏合力度（弧长随力度增长），中心点 = 指尖/捏合点。
     状态色：青=悬停/指针，琥珀=捏合预备，紫=抓取中。
     位置经 rAF 惯性插值（cursorTick，预览循环驱动）。 */
  var cursor = null, gcRing = null;
  var curX = -100, curY = -100, curTX = -100, curTY = -100, curVisible = false;
  var GC_RING_C = 94.25;   /* r=15 的周长，须与 CSS stroke-dasharray 一致 */
  if (!IS_LIKE_MOBILE) {
    cursor = document.createElement('div');
    cursor.id = 'gesture-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.innerHTML =
      '<svg viewBox="0 0 44 44" aria-hidden="true">' +
      '<circle class="gc-ring-bg" cx="22" cy="22" r="15"/>' +
      '<circle class="gc-ring" cx="22" cy="22" r="15"/></svg>' +
      '<div class="gc-dot"></div>';
    document.body.appendChild(cursor);
    gcRing = cursor.querySelector('.gc-ring');
  }

  function updateCursor(mode, x, y, strength, grabbed) {
    if (!cursor) return;
    if (!mode || !camOn) {
      if (curVisible) { cursor.classList.remove('show'); curVisible = false; }
      return;
    }
    if (!curVisible) {
      curX = curTX = x;
      curY = curTY = y;
      curVisible = true;
      cursor.classList.add('show');
    }
    curTX = x; curTY = y;
    cursor.classList.toggle('grab', !!grabbed);
    cursor.classList.toggle('ready', !grabbed && strength > 0.35);
    cursor.classList.toggle('point', mode === 'point');
    var st = Math.max(0, Math.min(1, grabbed ? 1 : strength));
    gcRing.style.strokeDashoffset = String(GC_RING_C * (1 - st));
  }

  function cursorTick() {
    if (!cursor || !curVisible) return;
    var ease = REDUCED ? 1 : 0.25;
    curX += (curTX - curX) * ease;
    curY += (curTY - curY) * ease;
    cursor.style.transform = 'translate3d(' + Math.round(curX) + 'px,' + Math.round(curY) + 'px,0)';
  }

  var hudStatus = hud.querySelector('#gh-status');
  var ghCanvas = hud.querySelector('#gh-canvas');
  var ghCtx = ghCanvas.getContext('2d');

  var GESTURE_NAMES = {
    fist: '✊ 时间静止', open: '✋ 时间恢复', thumbUp: '👍 快进 ×2.5',
    thumbDown: '👎 慢放 ×0.4', pinch: '🤏 抓取', point: '☝️ 指针',
    peace: '✌️ 线框切换'
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

  function drawHudCanvas(lm, dim) {
    /* 参数：主手 21 关键点缓存或 null（预览循环独立于推理持续绘制）；
       dim：快照亮度探针判定画面过暗 */
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
    /* 美颜三连：提亮白皙 → 磨皮平滑 → 柔光罩（移动端/减动效设备跳过磨皮层，
       每帧省 2 次全画布 drawImage + blur 滤镜的 GPU 开销） */
    ghCtx.filter = 'brightness(1.13) contrast(0.93) saturate(0.85)';
    ghCtx.drawImage(video, 0, 0, w, h);
    if (!IS_LIKE_MOBILE && !REDUCED) {
      ghCtx.filter = 'blur(2px)';
      ghCtx.globalAlpha = 0.30;               /* 模糊层叠刷 = 磨皮 */
      ghCtx.drawImage(video, 0, 0, w, h);
      ghCtx.filter = 'none';
      ghCtx.globalCompositeOperation = 'soft-light';
      ghCtx.globalAlpha = 0.20;
      ghCtx.fillStyle = '#fffdf6';            /* 白皙柔光罩 */
      ghCtx.fillRect(0, 0, w, h);
      ghCtx.globalCompositeOperation = 'source-over';
    }
    ghCtx.filter = 'none';
    ghCtx.globalAlpha = 1;
    ghCtx.restore();
    if (dim) {
      ghCtx.fillStyle = 'rgba(180, 40, 60, 0.72)';
      ghCtx.fillRect(0, h - 17, w, 17);
      ghCtx.fillStyle = '#ffe4e6';
      ghCtx.font = '10px ui-monospace, monospace';
      ghCtx.textAlign = 'center';
      ghCtx.fillText('⚠ 画面偏暗 · 识别率下降', w / 2, h - 5);
    }
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
      /* 掌心指示点 */
      ghCtx.fillStyle = 'rgba(196, 181, 253, 0.95)';
      ghCtx.beginPath();
      ghCtx.arc((lm[0].x + lm[5].x + lm[17].x) / 3 * w,
        (lm[0].y + lm[5].y + lm[17].y) / 3 * h, 2.5, 0, 6.2832);
      ghCtx.fill();
      /* 捏合力度环：围绕拇指食指中点，弧长=力度，颜色随力度升级
         （青 → 琥珀 → 紫），与屏幕光标同一套视觉语言 */
      var pinD = dist(lm[4], lm[8]) / palmSize(lm);
      var str = Math.max(0, Math.min(1, (0.55 - pinD) / 0.35));
      var mx = (lm[4].x + lm[8].x) / 2 * w;
      var my = (lm[4].y + lm[8].y) / 2 * h;
      /* 底环 */
      ghCtx.strokeStyle = 'rgba(148, 178, 214, 0.22)';
      ghCtx.lineWidth = 2;
      ghCtx.beginPath();
      ghCtx.arc(mx, my, 10, 0, 6.2832);
      ghCtx.stroke();
      /* 力度弧 */
      if (str > 0.02) {
        ghCtx.strokeStyle = str > 0.75 ? '#c4b5fd' : str > 0.35 ? '#fbbf24' : 'rgba(103,232,249,0.75)';
        ghCtx.lineWidth = 2.5;
        ghCtx.lineCap = 'round';
        ghCtx.beginPath();
        ghCtx.arc(mx, my, 10, -Math.PI / 2, -Math.PI / 2 + str * 6.2832);
        ghCtx.stroke();
      }
    }
  }

  function updateHud(g) {
    if (!camOn) return;
    setChips(g ? state.cur : null);
    refreshBadges(performance.now());   /* 无手时也刷新：帧率/置信度始终有意义 */
    if (!g) {
      hudSay('把手放到镜头前');
      return;
    }
    /* 无特定手势时的活性心跳：让用户确认识别在持续运行 */
    if (resultCount > 0 && state.cur === 'none') {
      hudSay('识别中 · 已处理 ' + resultCount + ' 帧');
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
    /* 推理后端热切换：CPU=WebAssembly / GPU=WebGL（调节台调用）。
       两种委托都由 Worker 承接，换后端需重建 worker（模型重载约 2-3s） */
    setBackend: function (d) {
      if (d !== 'CPU' && d !== 'GPU') return false;
      if (delegate === d) return true;
      delegate = d;
      try { localStorage.setItem(DELEGATE_KEY, d); } catch (e) {}
      if (gWorker && workerDelegate !== d) {
        gWorker.terminate();
        gWorker = null;
        workerReady = false;
        workerReadyPromise = null;
        workerDelegate = null;
        pendingBitmaps = 0;
      }
      if (camOn) {   /* 热切换：关流重开 */
        stopCamera();
        setTimeout(startCamera, 250);
      }
      return true;
    },
    /* 识别帧率实时调节（调节台滑杆，localStorage 持久化） */
    setFps: setFps,
    getFps: getFps,
    backend: function () { return delegate; },
    ring: function () { return evRing.slice(-24); },
    counters: function () {
      return { send: sendCount, result: resultCount, fail: failCount,
               stalls: stallCount };
    },
    fingersUp: fingersUp,
    state: state,
    /* 实时链路质量（徽章同源）：帧率 / 延迟 / 置信度 / 捏合点速度 */
    quality: function () {
      return { fps: Math.round(fpsSm), latency: lastLatency,
               conf: Math.round(lastConf * 100), pinchSpeed: Math.round(pinchSpeed),
               detectMs: Math.round(detectMsEma) };
    },
    isOn: function () { return camOn; }
  };
})();
