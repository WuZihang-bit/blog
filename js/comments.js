/* ==========================================================================
   吴子航的博客 · 评论 / 留言系统（Giscus · GitHub Discussions）
   --------------------------------------------------------------------------
   读者评论直接进 GitHub Discussions，作者在 Discussions 或本页回复，
   双向互动、免服务器、支持 Markdown 与表情回应。

   接入步骤（运行过一次 publish.sh 后）：
   1. https://github.com/apps/giscus 安装到本仓库
   2. https://giscus.app/zh-CN 生成配置
   3. 把下面 GISCUS_CONFIG 的 ▢ 占位符填掉即可，无其他代码改动
   ========================================================================== */

(function () {
  'use strict';

  var GISCUS_CONFIG = {
    repo: '▢OWNER/▢REPO',                 // 例如 'wuzihang/blog'
    repoId: '▢REPO_ID',                   // publish.sh 会打印
    category: 'Announcements',
    categoryId: '▢CATEGORY_ID',           // giscus.app 生成页显示
    theme: 'transparent_dark',
    lang: 'zh-CN'
  };

  function mountComments(el) {
    if (!el) return;

    /* 未配置：显示引导卡片（部署前本地预览用） */
    if (GISCUS_CONFIG.repoId.indexOf('▢') === 0 ||
        GISCUS_CONFIG.categoryId.indexOf('▢') === 0) {
      el.innerHTML =
        '<div class="cm-pending">' +
          '<b>评论区建设中</b>' +
          '<span>基于 GitHub Discussions 的留言系统——运行 publish.sh 后，' +
          '按其输出的指引填好 js/comments.js 顶部的配置即可启用。</span>' +
        '</div>';
      return;
    }

    /* 已配置：注入 giscus */
    var s = document.createElement('script');
    s.src = 'https://giscus.app/client.js';
    s.setAttribute('data-repo', GISCUS_CONFIG.repo);
    s.setAttribute('data-repo-id', GISCUS_CONFIG.repoId);
    s.setAttribute('data-category', GISCUS_CONFIG.category);
    s.setAttribute('data-category-id', GISCUS_CONFIG.categoryId);
    s.setAttribute('data-mapping', el.getAttribute('data-giscus-mapping') || 'pathname');
    s.setAttribute('data-strict', '0');
    s.setAttribute('data-reactions-enabled', '1');
    s.setAttribute('data-emit-metadata', '0');
    s.setAttribute('data-input-position', 'top');
    s.setAttribute('data-theme', GISCUS_CONFIG.theme);
    s.setAttribute('data-lang', GISCUS_CONFIG.lang);
    s.crossOrigin = 'anonymous';
    s.async = true;
    el.appendChild(s);

    /* 跟随站点深浅主题 */
    window.addEventListener('starburst', function () { /* 占位：主题切换后刷新 giscus */ });
    var origToggle = document.getElementById('theme-toggle');
    if (origToggle) {
      origToggle.addEventListener('click', function () {
        var dark = document.documentElement.dataset.theme === 'dark';
        setTimeout(function () {
          var f = el.querySelector('iframe.giscus-frame');
          if (f && f.contentWindow) {
            f.contentWindow.postMessage({
              giscus: { setConfig: { theme: dark ? 'transparent_dark' : 'light' } }
            }, 'https://giscus.app');
          }
        }, 60);
      });
    }
  }

  window.MountComments = mountComments;

  /* 自动挂载页面里的占位 */
  document.addEventListener('DOMContentLoaded', function () {
    mountComments(document.getElementById('giscus-box'));
  });
})();
