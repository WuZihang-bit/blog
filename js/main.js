/* ==========================================================================
   吴子航的博客 · 全站脚本 v3
   --------------------------------------------------------------------------
   1. 深色模式切换（初始值在 <head> 的内联脚本里设置，避免闪烁）
      —— 切换时向粒子背景派发 starburst 事件，从按钮处荡开涟漪
   2. 首页眉行「解码」动画：乱码字符从左到右落定
   3. 文章卡片 3D 悬停（仅支持 hover 的精确指针，尊重 reduced-motion）
   4. 轻量代码高亮：注释 / 字符串 / 关键字 / 数字
   ========================================================================== */

(function () {
  'use strict';

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var FINE_POINTER = window.matchMedia &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  /* ---------- 深色模式切换 ---------- */

  var toggle = document.getElementById('theme-toggle');

  if (toggle) {
    toggle.addEventListener('click', function () {
      var next = document.documentElement.dataset.theme === 'dark'
        ? 'light'
        : 'dark';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('theme', next);
      } catch (e) {
        /* 隐私模式下 localStorage 可能不可用，忽略即可 */
      }

      /* 从按钮位置荡开一圈粒子涟漪 */
      var r = toggle.getBoundingClientRect();
      window.dispatchEvent(new CustomEvent('starburst', {
        detail: {
          x: r.left + r.width / 2,
          y: r.top + r.height / 2,
          scale: 0.8
        }
      }));
    });
  }

  /* ---------- 首页眉行「解码」动画 ---------- */

  function decodeText(el) {
    var final = el.textContent;
    var pool = '01<>/*#$%&ABCDEF◇◆▮▯';
    var settled = 0;
    el.textContent = '';

    var timer = setInterval(function () {
      settled += 1.4;
      var out = '';
      for (var i = 0; i < final.length; i++) {
        var ch = final.charAt(i);
        out += (i < settled || ch === ' ')
          ? ch
          : pool.charAt((Math.random() * pool.length) | 0);
      }
      el.textContent = out;
      if (settled >= final.length) {
        clearInterval(timer);
        el.textContent = final;
      }
    }, 40);
  }

  var eyebrow = document.querySelector('.hero-eyebrow');
  if (eyebrow && !REDUCED) decodeText(eyebrow);

  /* ---------- 文章卡片 3D 悬停 ---------- */

  if (!REDUCED && FINE_POINTER) {
    var cards = document.querySelectorAll('.post-item');
    Array.prototype.forEach.call(cards, function (card) {
      card.addEventListener('pointermove', function (e) {
        /* 漂浮模式下 transform 由物理引擎接管 */
        if (document.body.classList.contains('float-mode')) return;
        var r = card.getBoundingClientRect();
        if (r.width < 1) return;
        var px = (e.clientX - r.left) / r.width - 0.5;
        var py = (e.clientY - r.top) / r.height - 0.5;
        card.classList.add('tilt');
        card.style.transform = 'perspective(900px) rotateX(' +
          (-py * 3.5).toFixed(2) + 'deg) rotateY(' +
          (px * 4.5).toFixed(2) + 'deg) translateY(-3px)';
      });
      card.addEventListener('pointerleave', function () {
        card.classList.remove('tilt');
        card.style.transform = '';
      });
    });
  }

  /* ---------- 站龄自动计算 ---------- */

  var daysEl = document.getElementById('stat-days');
  if (daysEl) {
    var LAUNCH = new Date('2026-10-18');
    var d = Math.max(1, Math.floor((Date.now() - LAUNCH) / 86400000) + 1);
    daysEl.textContent = d;
  }

  /* ---------- 文章页阅读进度条 ---------- */

  var postContent = document.querySelector('.post-content');
  if (postContent && !REDUCED) {
    var bar = document.createElement('div');
    bar.className = 'reading-progress';
    bar.setAttribute('aria-hidden', 'true');
    document.body.appendChild(bar);
    var updateProgress = function () {
      var rect = postContent.getBoundingClientRect();
      var total = rect.height - window.innerHeight * 0.4;
      var read = Math.min(Math.max(-rect.top, 0), Math.max(total, 1));
      bar.style.transform = 'scaleX(' + (read / Math.max(total, 1)).toFixed(4) + ')';
    };
    window.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();
  }

  /* ---------- 移动端顶栏汉堡菜单（≤768px 文字链接收纳） ---------- */

  (function () {
    var nav = document.querySelector('.site-nav');
    if (!nav) return;
    var burger = document.createElement('button');
    burger.id = 'nav-burger';
    burger.type = 'button';
    burger.className = 'theme-toggle';
    burger.setAttribute('aria-label', '菜单');
    burger.setAttribute('aria-expanded', 'false');
    burger.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
      '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';
    nav.insertBefore(burger, nav.firstChild);

    burger.addEventListener('click', function () {
      var open = nav.classList.toggle('menu-open');
      burger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    /* 点击菜单项后自动收起 */
    nav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { nav.classList.remove('menu-open'); });
    });
    document.addEventListener('click', function (e) {
      if (!nav.contains(e.target)) nav.classList.remove('menu-open');
    });
  })();

  
  /* ---------- 文章目录 TOC + 返回顶部（长文导航） ---------- */

  (function () {
    var content = document.querySelector('.post-content');
    if (!content) return;
    var heads = content.querySelectorAll('h2');
    if (heads.length < 2) return;   /* 短文不需要 */

    /* 侧边悬浮目录（桌面）；移动端收进返回顶部按钮长按 */
    var toc = document.createElement('nav');
    toc.className = 'toc-float';
    toc.setAttribute('aria-label', '文章目录');
    var html = '<b>目录</b>';
    heads.forEach(function (h, i) {
      if (!h.id) h.id = 'sec-' + i;
      html += '<a href="#' + h.id + '">' + h.textContent + '</a>';
    });
    toc.innerHTML = html;
    document.body.appendChild(toc);

    /* 返回顶部 */
    var top = document.createElement('button');
    top.id = 'back-top';
    top.type = 'button';
    top.setAttribute('aria-label', '返回顶部');
    top.innerHTML =
      '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<polyline points="18 15 12 9 6 15"/><line x1="12" y1="19" x2="12" y2="3"/></svg>';
    top.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    document.body.appendChild(top);
    window.addEventListener('scroll', function () {
      top.classList.toggle('show', window.scrollY > 600);
    }, { passive: true });

    /* 阅读进度高亮当前章节 */
    var links = toc.querySelectorAll('a');
    var onScroll = function () {
      var cur = -1;
      heads.forEach(function (h, i) {
        if (h.getBoundingClientRect().top < 120) cur = i;
      });
      links.forEach(function (a, i) {
        a.classList.toggle('on', i === cur);
      });
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  })();

  /* ---------- 全局错误仪表：引擎异常时给用户可见的降级提示 ---------- */

  (function () {
    var shown = {};
    function report(key, msg) {
      if (shown[key]) return;
      shown[key] = true;
      var bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:95;' +
        'padding:10px 16px;border:1px solid rgba(253,164,175,0.4);border-radius:10px;' +
        'background:rgba(30,10,16,0.92);color:#fecdd3;font-size:12.5px;max-width:78vw;' +
        'font-family:inherit;';
      bar.textContent = msg;
      document.body.appendChild(bar);
      setTimeout(function () { bar.remove(); }, 8000);
    }
    window.addEventListener('error', function (e) {
      if (window.__bgLastError && !shown.bg) {
        report('bg', '星空背景遇到问题，已自动降级（内容不受影响）');
      }
      if (window.__solarLastError && !shown.solar) {
        report('solar', '3D 引擎遇到问题，已自动保活（刷新可恢复）');
      }
    });
    /* 每 5 秒巡检一次引擎探针 */
    setInterval(function () {
      if (window.__bgLastError && !shown.bg) {
        report('bg', '星空背景遇到问题，已自动降级（内容不受影响）');
      }
      if (window.__solarLastError && !shown.solar) {
        report('solar', '3D 引擎遇到问题，已自动保活（刷新可恢复）');
      }
    }, 5000);
  })();

  /* ---------- PWA：Service Worker 注册（仅 https，本地 http 跳过） ---------- */

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { /* 静默 */ });
  }

  /* ---------- 图标按钮悬停提示（仅无文字说明的纯图标按钮） ---------- */

  var TIPS = {
    'theme-toggle': '深色 / 浅色主题',
    'solar-reset': '还原太阳系',
    'tune-toggle': '太阳系调节台',
    'copilot-toggle': 'AI 副驾驶 · 指令与问答'
  };
  Object.keys(TIPS).forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.setAttribute('data-tip', TIPS[id]);
  });

  /* ---------- 轻量代码高亮 ---------- */

  var KEYWORDS = {
    public: 1, private: 1, protected: 1, class: 1, interface: 1, extends: 1,
    implements: 1, static: 1, final: 1, void: 1, int: 1, long: 1, double: 1,
    float: 1, boolean: 1, char: 1, byte: 1, short: 1, new: 1, return: 1,
    if: 1, else: 1, for: 1, while: 1, switch: 1, case: 1, break: 1,
    continue: 1, try: 1, catch: 1, finally: 1, throw: 1, throws: 1,
    import: 1, package: 1, this: 1, super: 1, null: 1, true: 1, false: 1,
    def: 1, pass: 1, in: 1, is: 1, not: 1, and: 1, or: 1, lambda: 1,
    None: 1, True: 1, False: 1, self: 1, async: 1, await: 1, yield: 1,
    var: 1, let: 1, const: 1, function: 1, typeof: 1, struct: 1, enum: 1
  };

  function escapeHtml(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /* 普通片段：关键字与数字上色 */
  function plain(text) {
    return escapeHtml(text)
      .replace(/[A-Za-z_][A-Za-z0-9_]*/g, function (w) {
        return KEYWORDS[w] ? '<span class="tok-k">' + w + '</span>' : w;
      })
      .replace(/\d+(?:\.\d+)?/g, function (n) {
        return '<span class="tok-n">' + n + '</span>';
      });
  }

  function highlight(block) {
    var lang = (block.className.match(/language-([\w-]+)/) || [])[1] || '';
    var src = block.textContent;

    /* CSS 里 # 是颜色而不是注释，其余语言把 # 当行注释 */
    var commentAlt = lang === 'css' ? '' : '|#[^\\n]*';
    var re = new RegExp(
      '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/' + commentAlt + ')' +
      '|("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\')',
      'g'
    );

    var out = '';
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      out += plain(src.slice(last, m.index));
      var cls = m[1] !== undefined ? 'tok-c' : 'tok-s';
      out += '<span class="' + cls + '">' + escapeHtml(m[0]) + '</span>';
      last = m.index + m[0].length;
    }
    out += plain(src.slice(last));

    block.innerHTML = out;
  }

  var blocks = document.querySelectorAll('pre code[class*="language-"]');
  for (var i = 0; i < blocks.length; i++) {
    try {
      highlight(blocks[i]);
    } catch (e) {
      /* 高亮失败不影响内容展示 */
    }
  }
})();
