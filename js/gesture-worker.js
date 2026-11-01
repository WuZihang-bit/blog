/* ==========================================================================
   吴子航的博客 · 手势推理 Worker（经典 Worker）
   --------------------------------------------------------------------------
   把 MediaPipe 的 detectForVideo 从主线程摘到这里：
   主线程只剩「画快照 + 收结果 + 分发事件」，3D 场景与光标不再被
   推理阻塞（同步推理约 30-50ms/帧，15fps 即每秒占用主线程 ~700ms，
   这就是「交互很卡」的根因）。

   为什么是经典 Worker：tasks-vision 的 wasm 加载器在内部使用
   importScripts()，模块 Worker（type:'module'）里该方法被禁用；
   经典 Worker + importScripts(vision_bundle.worker.js) 是官方包
   在 Worker 环境的正确打开方式。

   协议：
   - 主线程 → { type:'init', dir }   dir 为绝对 URL（importScripts 不认相对路径）
   - 主线程 → { type:'detect', bitmap, ts }   ImageBitmap 移交（零拷贝）
   - Worker → { type:'ready' } / { type:'error', message }
   - Worker → { type:'result', landmarks, conf, dtMs, emaMs }
   - Worker → { type:'detectError', message }

   x 已在此处镜像（1-x），等价 legacy selfieMode——摄像头原图不镜像，
   直接映射屏幕会「手向右移、光标向左跑」。
   ========================================================================== */

/* CJS 桩：vision_bundle.worker.js 是 CommonJS 格式，
   经典 Worker 没有 require/exports，先垫上再 importScripts。
   importScripts 相对 Worker 脚本自身 URL（js/）解析，
   必须基于 self.location 显式回退到站点根的 lib/ */
var module = { exports: {} };
var exports = module.exports;
importScripts(new URL('../lib/mediapipe-tasks/vision_bundle.worker.js', self.location.href).href);
var MP = module.exports;

var landmarker = null;
var lastTs = 0;
var emaMs = 0;
var actDelegate = 'CPU';   /* 实际生效的委托（GPU 可能失败回退 CPU） */

self.onmessage = async function (e) {
  var msg = e.data || {};

  if (msg.type === 'init') {
    try {
      var fileset = await MP.FilesetResolver.forVisionTasks(msg.dir);
      var createWith = function (dg) {
        return MP.HandLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: msg.dir + 'hand_landmarker.task', delegate: dg },
          runningMode: 'VIDEO',
          numHands: 2,
          minHandDetectionConfidence: 0.6,
          minHandPresenceConfidence: 0.55,
          minTrackingConfidence: 0.55
        });
      };
      /* GPU 单帧仅 5-10ms（CPU 约 80-90ms），是识别帧率的上限解锁；
         GPU 创建失败自动回退 CPU 并如实上报实际后端 */
      var wantGpu = msg.delegate === 'GPU';
      try {
        landmarker = await createWith(wantGpu ? 'GPU' : 'CPU');
        actDelegate = wantGpu ? 'GPU' : 'CPU';
      } catch (eGpu) {
        if (!wantGpu) throw eGpu;
        landmarker = await createWith('CPU');
        actDelegate = 'CPU';
      }
      self.postMessage({ type: 'ready', delegate: actDelegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }

  if (msg.type === 'detect' && landmarker) {
    var t0 = performance.now();
    var ts = msg.ts;
    if (ts <= lastTs) ts = lastTs + 1;   /* VIDEO 模式时间戳必须单调递增 */
    lastTs = ts;
    try {
      var r = landmarker.detectForVideo(msg.bitmap, ts);
      var dt = performance.now() - t0;
      emaMs = emaMs ? emaMs * 0.8 + dt * 0.2 : dt;
      var landmarks = (r.landmarks || []).map(function (hand) {
        return hand.map(function (p) { return { x: 1 - p.x, y: p.y, z: p.z }; });
      });
      var conf = (r.handedness || r.handednesses || []).map(function (h) {
        return (h && h[0]) ? h[0].score : 1;
      });
      self.postMessage({
        type: 'result',
        landmarks: landmarks,
        conf: conf,
        dtMs: Math.round(dt),
        emaMs: Math.round(emaMs)
      });
    } catch (err) {
      self.postMessage({ type: 'detectError', message: String(err && err.message || err) });
    } finally {
      if (msg.bitmap && msg.bitmap.close) msg.bitmap.close();   /* 释放位图内存 */
    }
  }
};
