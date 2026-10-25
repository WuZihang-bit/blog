/* ==========================================================================
   吴子航的博客 · 太阳系调节台（仅首页加载）
   --------------------------------------------------------------------------
   顶部导航的滑杆按钮打开侧滑面板，实时调节太阳系与星场的全部可调参数：
   时间流速、引力强度、甩出限速、可拖质量、太阳/行星大小、轨道亮度、
   视差、星点密度、连线距离、流星频率、星尘数量。
   所有改动即时生效；「恢复默认」一键回滚，「还原太阳系」复位天体。
   ========================================================================== */

(function () {
  'use strict';

  if (!window.Solar3D || !window.Solar3D.PARAMS) return;

  var S = window.Solar3D;
  var P = S.PARAMS;
  var B = window.BlogBackground;

  /* ---------- 导航按钮 ---------- */

  var btn = document.createElement('button');
  btn.id = 'tune-toggle';
  btn.type = 'button';
  btn.className = 'theme-toggle';
  btn.title = '太阳系调节台';
  btn.setAttribute('aria-pressed', 'false');
  btn.setAttribute('aria-label', '太阳系调节台');
  btn.innerHTML =
    '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/>' +
    '<line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/>' +
    '<line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/>' +
    '<line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/>' +
    '<line x1="17" y1="16" x2="23" y2="16"/></svg>';
  var nav = document.querySelector('.site-nav');
  if (nav) nav.insertBefore(btn, document.getElementById('theme-toggle'));

  /* ---------- 参数定义 ---------- */

  var defs = [
    {
      group: '时间与运动',
      items: [
        { label: '时间流速', min: 0, max: 4, step: 0.1, hint: '0 = 时间静止', get: function () { return P.timeScale; }, set: function (v) { P.timeScale = v; } },
        { label: '行星大小', min: 0.5, max: 2.2, step: 0.05, get: function () { return P.planetScale; }, set: function (v) { P.planetScale = v; } },
        { label: '太阳大小', min: 10, max: 40, step: 1, get: function () { return P.sunSize; }, set: function (v) { P.sunSize = v; } },
        { label: '轨道线亮度', min: 0, max: 0.5, step: 0.02, get: function () { return P.orbitOpacity; }, set: function (v) { P.orbitOpacity = v; } },
        { label: '视角视差', min: 0, max: 2.5, step: 0.1, get: function () { return P.parallax; }, set: function (v) { P.parallax = v; } }
      ]
    },
    {
      group: '引力与拖拽',
      items: [
        { label: '太阳引力', min: 1500, max: 20000, step: 250, get: function () { return P.sunGravity; }, set: function (v) { P.sunGravity = v; } },
        { label: '行星引力系数', min: 0, max: 0.2, step: 0.01, get: function () { return P.planetGravity; }, set: function (v) { P.planetGravity = v; } },
        { label: '甩出限速', min: 8, max: 60, step: 1, get: function () { return P.releaseSpeed; }, set: function (v) { P.releaseSpeed = v; } },
        { label: '可拖拽质量上限', min: 0.5, max: 12, step: 0.5, hint: '调满可拖木星', get: function () { return P.dragMass; }, set: function (v) { P.dragMass = v; } }
      ]
    },
    {
      group: '星场',
      items: [
        { label: '星点密度', min: 4000, max: 24000, step: 1000, get: function () { return 10000; }, set: function (v) { if (B && B.tune) B.tune.setDensity(v); } },
        { label: '连线距离', min: 60, max: 200, step: 5, get: function () { return 120; }, set: function (v) { if (B && B.tune) B.tune.setLinkDist(v); } },
        { label: '流星间隔（秒）', min: 2, max: 20, step: 1, get: function () { return 6; }, set: function (v) { if (B && B.tune) B.tune.setCometEvery(v); } },
        { label: '星尘数量', min: 10, max: 60, step: 2, get: function () { return 30; }, set: function (v) { if (B && B.tune) B.tune.setBurstSparks(v); } }
      ]
    }
  ];

  /* 首次打开时记录当前值作为「默认」 */
  var defaults = {};
  defs.forEach(function (g) {
    g.items.forEach(function (it) { defaults[it.label] = it.get(); });
  });

  /* ---------- 面板 DOM ---------- */

  var panel = document.createElement('aside');
  panel.id = 'tune-panel';
  panel.setAttribute('aria-hidden', 'true');

  var html = '<header class="tp-head"><span class="tp-title">太阳系调节台</span>' +
    '<button id="tp-close" type="button" aria-label="关闭调节台">✕</button></header>' +
    '<div class="tp-body">';

  /* 渲染模式（科学模式）与鼠标模式：分段控件 */
  html += '<section class="tp-group"><h4>渲染模式</h4>' +
    '<div class="tp-seg" id="tp-rendermode">' +
      '<button type="button" data-m="solid" class="on">实体</button>' +
      '<button type="button" data-m="wire">线框</button>' +
      '<button type="button" data-m="points">点云</button>' +
    '</div></section>' +
    '<section class="tp-group"><h4>引力场</h4>' +
    '<div class="tp-seg" id="tp-grav">' +
      '<button type="button" data-g="off" class="on">隐藏</button>' +
      '<button type="button" data-g="on">时空弯曲网格</button>' +
    '</div></section>' +
    '<section class="tp-group"><h4>鼠标模式</h4>' +
    '<div class="tp-seg" id="tp-mousemode">' +
      '<button type="button" data-m="select" class="on">选中模式</button>' +
      '<button type="button" data-m="free">自由模式</button>' +
    '</div>' +
    '<div class="tp-hint" id="tp-mousehint">选中：点击 / 拖拽行星与碎块</div>' +
    '</section>';

  defs.forEach(function (g) {
    html += '<section class="tp-group"><h4>' + g.group + '</h4>';
    g.items.forEach(function (it) {
      html +=
        '<div class="tp-row">' +
          '<div class="tp-label"><span>' + it.label + '</span>' +
          (it.hint ? '<em>' + it.hint + '</em>' : '') +
          '<b class="tp-val" data-label="' + it.label + '"></b></div>' +
          '<input type="range" data-label="' + it.label + '" min="' + it.min +
            '" max="' + it.max + '" step="' + it.step + '" aria-label="' + it.label + '">' +
        '</div>';
    });
    html += '</section>';
  });

  html += '</div>' +
    '<footer class="tp-foot">' +
      '<button id="tp-default" type="button" class="tp-btn">恢复默认</button>' +
      '<button id="tp-reset" type="button" class="tp-btn tp-primary">还原太阳系</button>' +
    '</footer>';

  panel.innerHTML = html;
  document.body.appendChild(panel);

  /* ---------- 行为 ---------- */

  var inputs = panel.querySelectorAll('input[type="range"]');
  var vals = {};
  panel.querySelectorAll('.tp-val').forEach(function (el) { vals[el.getAttribute('data-label')] = el; });

  function findItem(label) {
    for (var i = 0; i < defs.length; i++) {
      for (var j = 0; j < defs[i].items.length; j++) {
        if (defs[i].items[j].label === label) return defs[i].items[j];
      }
    }
    return null;
  }

  function fmt(v) {
    if (v >= 1000) return String(Math.round(v));
    if (Math.abs(v - Math.round(v)) < 0.001) return String(Math.round(v));
    return v.toFixed(2).replace(/0$/, '');
  }

  function syncRow(label) {
    var it = findItem(label);
    if (!it) return;
    var v = it.get();
    var input = panel.querySelector('input[data-label="' + label + '"]');
    if (input) input.value = v;
    if (vals[label]) vals[label].textContent = fmt(v);
  }

  Array.prototype.forEach.call(inputs, function (input) {
    var label = input.getAttribute('data-label');
    syncRow(label);
    input.addEventListener('input', function () {
      var it = findItem(label);
      if (!it) return;
      var v = parseFloat(input.value);
      it.set(v);
      if (vals[label]) vals[label].textContent = fmt(v);
    });
  });

  function open() {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-pressed', 'true');
    document.body.classList.add('tune-open');
  }
  function close() {
    panel.classList.remove('open');
    panel.setAttribute('aria-hidden', 'true');
    btn.setAttribute('aria-pressed', 'false');
    document.body.classList.remove('tune-open');
  }

  btn.addEventListener('click', function () {
    if (panel.classList.contains('open')) close();
    else open();
  });
  panel.querySelector('#tp-close').addEventListener('click', close);

  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('open')) close();
  });

  panel.querySelector('#tp-reset').addEventListener('click', function () {
    window.dispatchEvent(new CustomEvent('solar-reset'));
  });

  /* 渲染模式分段控件 */
  var seg = panel.querySelector('#tp-rendermode');
  seg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || !window.Solar3D.setRenderMode) return;
    window.Solar3D.setRenderMode(b.getAttribute('data-m'));
    seg.querySelectorAll('button').forEach(function (x) {
      x.classList.toggle('on', x === b);
    });
  });

  /* 引力场开关 */
  var gravSeg = panel.querySelector('#tp-grav');
  gravSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b || !window.Solar3D.toggleGravField) return;
    var on = window.Solar3D.toggleGravField(b.getAttribute('data-g') === 'on');
    gravSeg.querySelectorAll('button').forEach(function (x) {
      x.classList.toggle('on',
        x.getAttribute('data-g') === (on ? 'on' : 'off'));
    });
  });

  /* 鼠标模式分段控件 */
  var mmSeg = panel.querySelector('#tp-mousemode');
  var mmHint = panel.querySelector('#tp-mousehint');
  mmSeg.addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    window.Solar3D.PARAMS.mouseMode = b.getAttribute('data-m');
    mmSeg.querySelectorAll('button').forEach(function (x) {
      x.classList.toggle('on', x === b);
    });
    mmHint.textContent = b.getAttribute('data-m') === 'free'
      ? '自由：拖拽旋转视角 · 滚轮缩放'
      : '选中：点击 / 拖拽行星与碎块';
  });

  panel.querySelector('#tp-default').addEventListener('click', function () {
    defs.forEach(function (g) {
      g.items.forEach(function (it) {
        it.set(defaults[it.label]);
        syncRow(it.label);
      });
    });
  });
})();
