/* ==========================================================================
   吴子航的博客 · 行星档案卡（点击天体弹出真实数据）
   --------------------------------------------------------------------------
   拦截 solar3d 的行星点击（轻点=查看档案，拖拽=交互不变），
   弹出玻璃质感资料卡：质量/距离/公转周期/大气/简介，附「飞过去」按钮
   直接联动 AI 副驾驶自动驾驶。ESC 或点空白关闭。
   ========================================================================== */

(function () {
  'use strict';

  if (!window.Solar3D) return;

  /* 注入卡片 DOM */
  var card = document.createElement('aside');
  card.id = 'planet-card';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML =
    '<button id="pc-close" type="button" aria-label="关闭档案">✕</button>' +
    '<div class="pc-head"><span class="pc-dot"></span><b id="pc-name">—</b><i id="pc-en"></i></div>' +
    '<dl class="pc-grid">' +
      '<div><dt>相对质量</dt><dd id="pc-mass"></dd></div>' +
      '<div><dt>距太阳</dt><dd id="pc-dist"></dd></div>' +
      '<div><dt>公转周期</dt><dd id="pc-year"></dd></div>' +
      '<div><dt>大气成分</dt><dd id="pc-atmo"></dd></div>' +
    '</dl>' +
    '<p id="pc-desc"></p>' +
    '<div class="pc-actions">' +
      '<button type="button" class="pc-btn" id="pc-fly">✦ 带我去看看</button>' +
      '<button type="button" class="pc-btn pc-ghost" id="pc-reset">还原轨道</button>' +
    '</div>';
  document.body.appendChild(card);

  var el = {
    name: card.querySelector('#pc-name'),
    en: card.querySelector('#pc-en'),
    mass: card.querySelector('#pc-mass'),
    dist: card.querySelector('#pc-dist'),
    year: card.querySelector('#pc-year'),
    atmo: card.querySelector('#pc-atmo'),
    desc: card.querySelector('#pc-desc')
  };

  /* 拦截行星点击：在 solar3d 的 onPointerDown 之前监听（capture），
     若点到行星且没有拖拽意图（原地点按）→ 打开档案并吃掉事件 */
  var downPos = null;
  window.addEventListener('pointerdown', function (e) {
    downPos = { x: e.clientX, y: e.clientY, t: performance.now() };
  }, { capture: true, passive: true });

  window.addEventListener('pointerup', function (e) {
    if (!downPos) return;
    var dx = e.clientX - downPos.x, dy = e.clientY - downPos.y;
    var isTap = performance.now() - downPos.t < 400 &&
      dx * dx + dy * dy < 100; /* 位移 <10px 视为点按 */
    downPos = null;
    if (!isTap || window.Solar3D.PARAMS.mouseMode !== 'select') return;
    if (e.target && e.target.closest && e.target.closest('button, a, #tune-panel, #copilot, .site-header')) return;

    /* 询问 solar3d 该点是否命中行星 */
    var hit = window.Solar3D.probePlanetHit(e.clientX, e.clientY);
    if (hit) openCard(hit);
  }, { capture: true, passive: true });

  function openCard(info) {
    el.name.textContent = info.name;
    el.en.textContent = info.en;
    el.mass.textContent = info.mass;
    el.dist.textContent = info.dist;
    el.year.textContent = info.year;
    el.atmo.textContent = info.atmo;
    el.desc.textContent = info.desc;
    card.querySelector('#pc-fly').style.display = info.name === '太阳' ? 'none' : '';
    card.classList.add('open');
    card.setAttribute('aria-hidden', 'false');
  }

  function closeCard() {
    card.classList.remove('open');
    card.setAttribute('aria-hidden', 'true');
  }

  card.querySelector('#pc-close').addEventListener('click', closeCard);

  /* 点击卡片以外的任何地方 → 自动关闭 */
  window.addEventListener('pointerdown', function (e) {
    if (!card.classList.contains('open')) return;
    if (card.contains(e.target)) return;
    closeCard();
  }, true);
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeCard();
  });

  /* 联动副驾驶：档案卡里一键让飞船飞过去 */
  card.querySelector('#pc-fly').addEventListener('click', function () {
    window.Solar3D.pilot.command({ type: 'goto', target: el.name.textContent });
    closeCard();
    var btn = document.getElementById('copilot-toggle');
    if (btn) btn.click();
  });
  card.querySelector('#pc-reset').addEventListener('click', function () {
    window.dispatchEvent(new CustomEvent('solar-reset'));
    closeCard();
  });
})();
