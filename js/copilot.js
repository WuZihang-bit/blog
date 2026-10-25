/* ==========================================================================
   吴子航的博客 · AI 副驾驶 Agent（仅首页加载）
   --------------------------------------------------------------------------
   「感知 → 规划 → 执行 → 反馈」Agent，规划器为真 LLM（智谱 GLM）：
   - 用户任意自然语言 → LLM 输出结构化 JSON 命令序列 → 队列执行
   - LLM 不可用（无 key / 断网 / 超时 / 输出非法）时自动降级为本地意图识别
   - 记忆：上一目标注入提示词（「再去土星」的「再」能被理解）
   - 工具层：飞行指令（goto/orbit/chase/slingshot/cancel）+ 系统工具
     （还原太阳系 / 渲染模式 / 时间流速 / 鼠标模式）+ 遥测问答

   ⚠ 安全：key 写在前端 JS 里对访问者可见，仅适合个人演示；
   正式部署请换成服务端代理转发，并为 key 设置消费限额。
   ========================================================================== */

(function () {
  'use strict';

  if (!window.Solar3D || !window.Solar3D.pilot) return;

  /* ---------- LLM 配置（智谱开放平台，OpenAI 兼容接口） ----------
     凭证以分段编码存放，避免被源码搜索/爬虫直接抓取明文。
     注意：纯前端无法真正保密（有心人可断点还原），此混淆用于
     防批量扫库；正式公开部署请换服务端代理转发并设消费限额。 */
  var LLM_KEY = (function () {
    var s = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    function d(x) {                          /* base64 → 反转字符串 */
      var t = atob(x), out = '';
      for (var i = t.length - 1; i >= 0; i--) out += t[i];
      return out;
    }
    return d('NWExOTBhYjQyNjVmNjgzNTM1MzE=') + d('cGU4Z25VVFlVZmJnMkhwWi5kOGYzZGJiZDc4MzI=');
  })();
  var LLM_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";
  var LLM_MODEL = "glm-4-flash";

  var PLANETS = ['水星', '金星', '地球', '火星', '木星', '土星', '天王星', '海王星'];
  var EN = {
    mercury: '水星', venus: '金星', earth: '地球', mars: '火星',
    jupiter: '木星', saturn: '土星', uranus: '天王星', neptune: '海王星',
    sun: '太阳', sol: '太阳'
  };

  /* ======================================================
     本地意图识别（降级方案 / 无 LLM 时的规划器）
     ====================================================== */

  function findPlanet(text) {
    for (var i = 0; i < PLANETS.length; i++) {
      if (text.indexOf(PLANETS[i]) >= 0) return PLANETS[i];
    }
    var low = text.toLowerCase();
    for (var k in EN) {
      if (low.indexOf(k) >= 0) return EN[k];
    }
    return null;
  }

  function parseOne(text) {
    var t = (text || '').trim();
    if (!t) return null;

    var qp = findPlanet(t);
    if (/(速度|飞得多快)/.test(t)) return { type: 'query', q: 'speed' };
    if (/(在哪|位置)/.test(t)) return { type: 'query', q: 'pos' };
    if (/(距离|多远)/.test(t)) return { type: 'query', q: 'dist', target: qp };

    if (/(还原|复位).{0,4}(太阳系|系统)|太阳系.{0,3}(还原|复位)/.test(t)) {
      return { type: 'sys', act: 'reset' };
    }
    if (/线框/.test(t)) return { type: 'sys', act: 'render', value: 'wire' };
    if (/点云/.test(t)) return { type: 'sys', act: 'render', value: 'points' };
    if (/实体/.test(t)) return { type: 'sys', act: 'render', value: 'solid' };
    var ts = t.match(/时间[^\d]*(\d+(?:\.\d+)?)\s*倍/);
    if (/慢放|时间.{0,3}慢/.test(t)) return { type: 'sys', act: 'time', value: 0.4 };
    if (ts) return { type: 'sys', act: 'time', value: parseFloat(ts[1]) };
    if (/快进|时间.{0,3}加速/.test(t)) return { type: 'sys', act: 'time', value: 2.5 };
    if (/时间.{0,3}(正常|恢复)/.test(t)) return { type: 'sys', act: 'time', value: 1 };
    if (/自由模式/.test(t)) return { type: 'sys', act: 'mouse', value: 'free' };
    if (/选中模式/.test(t)) return { type: 'sys', act: 'mouse', value: 'select' };
    if (/(引力场|时空弯曲|弯曲网格)/.test(t)) {
      var gvOn = !/(关闭|关掉|取消|隐藏)/.test(t);
      return { type: 'sys', act: 'grav', value: gvOn };
    }

    if (/(停止|取消|停下|别飞|stop|cancel)/i.test(t)) return { type: 'cancel' };

    var planet = findPlanet(t);
    if (planet === '太阳') planet = null;

    if (/(弹弓|借力|slingshot)/i.test(t)) {
      var dst = (planet && planet !== '木星' && planet !== '土星')
        ? planet : '海王星';
      return { type: 'slingshot', target: dst };
    }
    if (/(追|跟随|跟踪|chase)/i.test(t) && /(碎|岩|块|debris|frag)/i.test(t)) {
      return { type: 'chase' };
    }
    var revs = t.match(/(\d+)\s*圈/);
    var revCn = t.match(/([一二两三四五六七八九十])\s*圈/);
    var CN_NUM = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
    if (/(绕|环绕|盘旋|orbit)/i.test(t)) {
      return {
        type: 'orbit',
        target: planet || '地球',
        revolutions: revs ? parseInt(revs[1], 10)
          : revCn ? CN_NUM[revCn[1]] : 1
      };
    }
    if (planet || /(去|飞往|前往|带我|goto|go to|fly)/i.test(t)) {
      return { type: 'goto', target: planet || '地球' };
    }
    return null;
  }

  /* ======================================================
     LLM 规划器（GLM）：自然语言 → 结构化命令数组
     ====================================================== */

  var SYSTEM_PROMPT = [
    '你是「深空站」飞船副驾驶兼博客问答助手。用户的话分两类处理，只输出 JSON，不要任何其他文字。',
    '',
    '【A. 飞船/系统指令】输出命令数组（可多步，按执行顺序，最多 5 步）：',
    '{"type":"goto","target":"行星中文名"} 直飞某行星',
    '{"type":"orbit","target":"行星中文名","revolutions":1到9} 环绕某行星',
    '{"type":"chase"} 追踪最近的碎块',
    '{"type":"slingshot","target":"目标行星"} 引力弹弓航线',
    '{"type":"cancel"} 停止当前动作',
    '{"type":"query","q":"speed|pos|dist","target":"行星中文名(dist时填)"} 查询遥测',
    '{"type":"sys","act":"reset"} 还原太阳系',
    '{"type":"sys","act":"render","value":"wire|points|solid"} 渲染模式',
    '{"type":"sys","act":"time","value":数字} 时间流速倍率',
    '{"type":"sys","act":"mouse","value":"free|select"} 鼠标模式',
    '{"type":"sys","act":"grav","value":true} 开关引力场可视化',
    '',
    '【B. 问答/闲聊/知识】（问知识、问博客、问「怎么看/为什么/是什么」、打招呼）输出单个对象：',
    '{"type":"say","text":"回答，120字内，口语化，可用emoji"}',
    '',
    '规则：',
    '1. 行星只用这八个中文名：水星 金星 地球 火星 木星 土星 天王星 海王星（太阳不能直飞）。',
    '2. 复合指令拆多步；「借力/弹弓」直接用 slingshot 不加 goto。',
    '3. 模糊两可时优先理解为问答（say）。',
    '4. 回答可利用博客背景：作者吴子航是电子科大学生，方向金融后端×大模型，站内有太阳系引力沙盒。',
    '示例：',
    '「带我去土星」→ [{"type":"goto","target":"土星"}]',
    '「木星大红斑是什么」→ {"type":"say","text":"大红斑是木星大气中持续了至少350年的反气旋风暴，直径能装下整个地球。想看的话说『带我去木星』就行 🪐"}',
    '「现在距离火星多远」→ [{"type":"query","q":"dist","target":"火星"}]',
    '「先去木星然后借力去海王星绕两圈」→ [{"type":"slingshot","target":"海王星"},{"type":"orbit","target":"海王星","revolutions":2}]'
  ].join('\n');

  function llmPlan(text, lastTarget) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 12000);

    var userMsg = '上一目标：' + (lastTarget || '无') +
      '（「再/继续」类指令沿用该目标）\n用户指令：' + text;

    return fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LLM_KEY
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg }
        ],
        temperature: 0.2,
        max_tokens: 400
      }),
      signal: ctrl.signal
    })
      .then(function (r) {
        clearTimeout(timer);
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var content = data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.content || '';
        return llmParsePayload(content);
      })
      .finally(function () { clearTimeout(timer); });
  }

  /* 校验并规范化 LLM 输出的单条命令 */
  function normalizeCmd(c) {
    if (!c || !c.type) return null;
    var KNOWN = ['goto', 'orbit', 'chase', 'slingshot', 'cancel', 'query', 'sys'];
    if (KNOWN.indexOf(c.type) < 0) return null;

    if (c.type === 'goto' || c.type === 'orbit' || c.type === 'slingshot') {
      var t = findPlanet(String(c.target || ''));
      if (!t) return null;
      var out = { type: c.type, target: t };
      if (c.type === 'orbit') {
        var n = parseInt(c.revolutions, 10);
        out.revolutions = isNaN(n) ? 1 : Math.max(1, Math.min(9, n));
      }
      return out;
    }
    if (c.type === 'query') {
      var q = ['speed', 'pos', 'dist'].indexOf(c.q) >= 0 ? c.q : 'speed';
      var qq = { type: 'query', q: q };
      if (q === 'dist') {
        var dt = findPlanet(String(c.target || ''));
        if (!dt) return null;
        qq.target = dt;
      }
      return qq;
    }
    if (c.type === 'sys') {
      var act = ['reset', 'render', 'time', 'mouse', 'grav'].indexOf(c.act) >= 0 ? c.act : null;
      if (!act) return null;
      var o = { type: 'sys', act: act };
      if (act === 'render' && ['wire', 'points', 'solid'].indexOf(c.value) >= 0) o.value = c.value;
      else if (act === 'time') {
        var v = parseFloat(c.value);
        o.value = isNaN(v) ? 1 : Math.max(0.1, Math.min(5, v));
      } else if (act === 'mouse' && ['free', 'select'].indexOf(c.value) >= 0) o.value = c.value;
      else if (act === 'grav') o.value = !!c.value;
      return o;
    }
    return { type: 'cancel' };
  }

  /* say 对象（问答/闲聊）：LLM 可能返回对象而非数组 */
  function normalizeSay(c) {
    if (!c || !c.text || typeof c.text !== 'string') return null;
    return { type: 'say', text: c.text.slice(0, 200) };
  }

  function llmParsePayload(content) {
    /* 优先匹配数组（命令序列），其次单个对象（say） */
    var arr = content.match(/\[[\s\S]*\]/);
    if (arr) {
      var cmds = JSON.parse(arr[0]);
      if (!Array.isArray(cmds)) throw new Error('not array');
      return cmds.slice(0, 5).map(normalizeCmd).filter(Boolean);
    }
    var obj = content.match(/\{[\s\S]*\}/);
    if (obj) {
      var say = normalizeSay(JSON.parse(obj[0]));
      if (say) return [say];
    }
    throw new Error('no json');
  }

  /* 本地降级规划：按连接词拆句 */
  function localPlan(text) {
    var parts = (text || '')
      .split(/然后|再|接着|最后|；|;|\n|，/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
    var cmds = [];
    for (var i = 0; i < parts.length; i++) {
      var c = parseOne(parts[i]);
      if (c) cmds.push(c);
    }
    return cmds;
  }

  /* ======================================================
     Agent：记忆 + 队列 + 执行器
     ====================================================== */

  var agent = {
    queue: [],      // 命令对象数组
    total: 0,
    done: 0,
    lastTarget: null,
    waiting: false,
    busy: false
  };

  function execInstant(cmd) {
    if (cmd.type === 'sys') {
      if (cmd.act === 'reset') {
        window.dispatchEvent(new CustomEvent('solar-reset'));
        return '太阳系已还原';
      }
      if (cmd.act === 'render') {
        window.Solar3D.setRenderMode(cmd.value);
        return '渲染模式：' +
          (cmd.value === 'wire' ? '线框' : cmd.value === 'points' ? '点云' : '实体');
      }
      if (cmd.act === 'time') {
        window.Solar3D.PARAMS.timeScale = cmd.value;
        return '时间流速 ×' + cmd.value;
      }
      if (cmd.act === 'mouse') {
        window.Solar3D.PARAMS.mouseMode = cmd.value;
        return cmd.value === 'free' ? '已切自由模式（拖拽旋转 · 滚轮缩放）' : '已切选中模式';
      }
      if (cmd.act === 'grav' && window.Solar3D.toggleGravField) {
        var on = window.Solar3D.toggleGravField(!!cmd.value);
        return on ? '引力场可视化：开（时空弯曲网格）' : '引力场可视化：关';
      }
    }
    return null;
  }

  function runQuery(cmd) {
    var ship = window.Solar3D.ship();
    var st = window.Solar3D.pilot.status();
    if (cmd.q === 'speed') {
      return st.flying ? '当前速度 ' + ship.speed + ' u/s' : '飞船未出动（速度 0）';
    }
    if (cmd.q === 'pos') {
      return st.flying
        ? '飞船位置 (' + ship.x + ', ' + ship.y + ', ' + ship.z + ')'
        : '飞船停在机库（未出动）';
    }
    if (cmd.q === 'dist') {
      if (!ship.flying) return '飞船未出动，谈不上距离';
      var w = cmd.target && window.Solar3D.planetWorld(cmd.target);
      if (!w) return (cmd.target || '目标') + '无法定位';
      var d = Math.round(Math.sqrt(
        (ship.x - w.x) * (ship.x - w.x) + (ship.z - w.z) * (ship.z - w.z)
      ));
      return '距' + cmd.target + ' ' + d + ' 单位，速度 ' + ship.speed + ' u/s';
    }
    return null;
  }

  function step(cmd) {
    if (cmd.type === 'query') return { msg: runQuery(cmd) };

    if (cmd.type === 'say') return { msg: cmd.text, spoken: true };

    if (cmd.type === 'cancel') {
      agent.queue = [];
      var r = window.Solar3D.pilot.command({ type: 'cancel' });
      return { msg: r.msg + '，队列已清空' };
    }

    if (cmd.type === 'sys') return { msg: execInstant(cmd) };

    var res = window.Solar3D.pilot.command(cmd);
    return { msg: res.msg, bad: !res.ok, async: res.ok };
  }

  function pump() {
    if (!agent.queue.length) {
      if (!agent.manualAbort) say('全部任务完成 ✓');
      agent.busy = false;
      return;
    }
    var cmd = agent.queue[0];
    var res = step(cmd);

    if (res.bad) {
      agent.queue = [];
      agent.busy = false;
      say(res.msg + ' · 队列已中止', true);
      return;
    }

    agent.queue.shift();
    agent.done += 1;

    if (res.spoken) {
      /* 知识问答：对话式展示，无编号 */
      agent.busy = false;
      say(res.msg);
      return;
    }

    if (res.async) {
      say('[' + agent.done + '/' + agent.total + '] ' + res.msg);
      agent.waiting = true;
    } else {
      say('[' + agent.done + '/' + agent.total + '] ' + res.msg);
      if (!agent.queue.length) {
        agent.busy = false;
        return;
      }
      pump();
    }
  }

  /* 飞行任务完成检测：轮询副驾驶状态 */
  setInterval(function () {
    if (!agent.busy || !agent.waiting) return;
    var st = window.Solar3D.pilot.status();
    if (!st.on) {
      if (st.text === '已切回手动') {
        agent.queue = [];
        agent.busy = false;
        agent.waiting = false;
        say('手动接管 · 后续任务已中止');
        return;
      }
      agent.waiting = false;
      pump();
    } else if (box && box.classList.contains('open')) {
      say('[' + agent.done + '/' + agent.total + '] ' + st.text +
        ' · ' + st.speed + ' u/s');
    }
  }, 380);

  /* ======================================================
     规划入口：LLM 优先，本地降级
     ====================================================== */

  function feed(text) {
    var t = (text || '').trim();
    if (!t) return;
    if (agent.planning) return;

    /* 本地快捷路径：单句且本地能解析 → 直接走，零延迟 */
    if (!/，|然后|再|接着|最后/.test(t)) {
      var local = parseOne(t);
      if (local) {
        if (local.target) agent.lastTarget = local.target;
        startQueue([local]);
        return;
      }
    }

    /* LLM 规划（已确认离线则直接本地规划，不白等超时） */
    if (llmOnline === false) {
      var offCmds = localPlan(t);
      if (!offCmds.length) {
        say('本地模式听不懂这句，试试快捷指令', true);
        return;
      }
      say('本地模式 · GLM 离线');
      startQueue(offCmds);
      return;
    }
    agent.planning = true;
    say('GLM 正在规划航线…');
    llmPlan(t, agent.lastTarget)
      .then(function (cmds) {
        agent.planning = false;
        if (!cmds.length) {
          say('GLM 没有给出可行的命令序列', true);
          return;
        }
        startQueue(cmds);
      })
      .catch(function (err) {
        agent.planning = false;
        /* 降级：本地规划 */
        var cmds = localPlan(t);
        if (!cmds.length) {
          say('没听懂这句（LLM 也联系不上）', true);
          return;
        }
        say('GLM 不可用，已用本地规划');
        startQueue(cmds);
      });
  }

  function startQueue(cmds) {
    /* 记忆：记录最后一个带目标命令的目标 */
    for (var i = cmds.length - 1; i >= 0; i--) {
      if (cmds[i].target) { agent.lastTarget = cmds[i].target; break; }
    }
    agent.queue = cmds;
    agent.total = cmds.length;
    agent.done = 0;
    agent.manualAbort = false;
    agent.busy = true;
    agent.waiting = false;
    if (cmds.length > 1) say('规划完成 · 共 ' + cmds.length + ' 步任务');
    pump();
  }

  /* ======================================================
     UI：顶栏按钮 + 底部指令胶囊
     ====================================================== */

  var btn = document.createElement('button');
  btn.id = 'copilot-toggle';
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.title = 'AI 副驾驶 Agent（GLM 规划）';
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', 'AI 副驾驶');
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>' +
    '<path d="M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z"/></svg>';
  var nav = document.querySelector('.site-nav');
  if (nav) nav.insertBefore(btn, document.getElementById('theme-toggle'));

  var box = document.createElement('div');
  box.id = 'copilot';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML =
    '<div class="cp-status" id="cp-status"><span id="cp-online" class="cp-online checking">检测中…</span>随便说，我来规划：例：先去木星，然后借力去海王星，绕两圈</div>' +
    '<form class="cp-row" id="cp-form">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>' +
      '<input id="cp-input" type="text" placeholder="随便说：去看看土星长什么样 / 带我回家 / 追碎块…" autocomplete="off" aria-label="飞船指令">' +
      '<button type="submit" class="cp-send">执行</button>' +
    '</form>' +
    '<div class="cp-chips">' +
      '<button type="button" data-cmd="先去木星，然后借力去海王星，绕两圈">木星弹弓→海王星绕两圈</button>' +
      '<button type="button" data-cmd="带我去土星">带我去土星</button>' +
      '<button type="button" data-cmd="追踪碎块">追踪碎块</button>' +
      '<button type="button" data-cmd="距离地球多远">距离地球多远</button>' +
      '<button type="button" data-cmd="时间快进，然后切线框模式">时间快进+线框</button>' +
    '</div>';
  document.body.appendChild(box);

  var pill = document.createElement('div');
  pill.id = 'copilot-pill';
  pill.setAttribute('aria-hidden', 'true');
  document.body.appendChild(pill);

  var statusEl = box.querySelector('#cp-status');
  var input = box.querySelector('#cp-input');
  var onlineEl = box.querySelector('#cp-online');

  /* ---------- GLM 在线探活：真实调用一次，确定 Agent 形态 ---------- */

  var llmOnline = null;   // null=检测中 true=在线 false=离线

  function setOnlineBadge(on) {
    llmOnline = on;
    if (!onlineEl) return;
    if (on) {
      onlineEl.textContent = '● GLM 在线';
      onlineEl.classList.remove('checking', 'off');
      onlineEl.classList.add('on');
    } else {
      onlineEl.textContent = '● 本地模式（GLM 离线，指令照常可用）';
      onlineEl.classList.remove('checking', 'on');
      onlineEl.classList.add('off');
    }
  }

  (function probeLLM() {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 9000);
    fetch(LLM_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LLM_KEY
      },
      body: JSON.stringify({
        model: LLM_MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4
      }),
      signal: ctrl.signal
    })
      .then(function (r) {
        clearTimeout(timer);
        setOnlineBadge(r.ok);
      })
      .catch(function () {
        clearTimeout(timer);
        setOnlineBadge(false);
      });
  })();

  function say(msg, bad) {
    statusEl.textContent = msg;
    statusEl.classList.toggle('bad', !!bad);
  }

  box.querySelector('#cp-form').addEventListener('submit', function (e) {
    e.preventDefault();
    feed(input.value);
  });
  box.querySelectorAll('.cp-chips button').forEach(function (b) {
    b.addEventListener('click', function () { feed(b.getAttribute('data-cmd')); });
  });

  function open() {
    box.classList.add('open');
    box.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-pressed', 'true');
    setTimeout(function () { input.focus(); }, 120);
  }
  function close() {
    box.classList.remove('open');
    box.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-pressed', 'false');
  }

  btn.addEventListener('click', function () {
    if (box.classList.contains('open')) close();
    else open();
  });

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && box.classList.contains('open')) close();
  });

  /* 状态轮询：副驾驶进行中 + 胶囊收起 → 迷你状态条 */
  setInterval(function () {
    var st = window.Solar3D.pilot.status();
    if (st.on) {
      btn.classList.add('busy');
      if (!box.classList.contains('open') && !agent.busy) {
        pill.textContent = '✦ ' + st.text + ' · ' + st.speed + ' u/s';
        pill.classList.add('show');
      }
    } else {
      btn.classList.remove('busy');
      if (!agent.busy) pill.classList.remove('show');
    }
  }, 400);
})();
