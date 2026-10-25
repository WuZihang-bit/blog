/* ==========================================================================
   吴子航的博客 · 本地搜索 + 相关文章推荐
   --------------------------------------------------------------------------
   - 搜索：归档页顶部即时过滤（标题/摘要/标签，拼音不参与），
     300ms 防抖，无结果给引导
   - 相关文章：文章页底部按标签重叠度推荐 2 篇
   ========================================================================== */

(function () {
  'use strict';

  var POSTS = [
    { url: 'posts/hello-world.html', root: '', title: '博客上线：重新开始写字',
      excerpt: '为什么在人人都在社交平台的年代，还要自己搭一个博客；以及这个零框架、纯手写 HTML/CSS 的小站会承载些什么。',
      tags: ['随笔', '博客'] },
    { url: 'posts/spring-transaction.html', root: '', title: 'Spring Boot 事务失效的六种常见场景',
      excerpt: '@Transactional 加上了，数据却照样写了一半？整理六个事务失效的高频场景，附可复现的代码和修复方式。',
      tags: ['Java', 'Spring Boot', '后端'] },
    { url: 'posts/persona-agent.html', root: '', title: '给 QQ 群做一个有「人设」的 AI Agent',
      excerpt: '让群聊机器人不再满嘴客服腔：人设设定、说话时机、长期记忆——一个 QQ 群 Agent 的设计与踩坑记录。',
      tags: ['LLM', 'Agent', '项目'] },
    { url: 'posts/september-notes.html', root: '', title: '九月小结：把节奏找回来',
      excerpt: '开学三周：课表、项目、锻炼和睡眠的再平衡。给十月立几个小小的 flag。',
      tags: ['随笔', '生活'] }
  ];

  /* ---------- 归档页：即时搜索 ---------- */

  function initSearch() {
    var page = document.querySelector('.archive-list');
    if (!page || document.getElementById('search-box')) return;
    var input = document.createElement('input');
    input.id = 'search-box';
    input.type = 'search';
    input.placeholder = '搜索标题 / 摘要 / 标签…';
    input.setAttribute('aria-label', '搜索文章');
    var list = page.cloneNode(true);
    page.parentNode.replaceChild(list, page);

    var timer = null;
    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        var q = input.value.trim().toLowerCase();
        var items = list.querySelectorAll('li');
        var shown = 0;
        items.forEach(function (li) {
          var hit = !q;
          if (!hit) {
            var text = li.textContent.toLowerCase();
            var link = li.querySelector('a');
            if (link) {
              var post = POSTS.filter(function (p) {
                return link.href.indexOf(p.url) >= 0 ||
                       link.href.indexOf(p.url.split('/').pop()) >= 0;
              })[0];
              if (post) {
                text = (post.title + ' ' + post.excerpt + ' ' + post.tags.join(' ')).toLowerCase();
              }
            }
            hit = text.indexOf(q) >= 0;
          }
          li.style.display = hit ? '' : 'none';
          if (hit) shown++;
        });
        var none = list.parentNode.querySelector('.search-empty');
        if (!shown && q) {
          if (!none) {
            none = document.createElement('div');
            none.className = 'search-empty';
            none.textContent = '没有匹配的文章 — 试试更短的关键词';
            list.parentNode.appendChild(none);
          }
          none.style.display = '';
        } else if (none) {
          none.style.display = 'none';
        }
      }, 200);
    });

    list.parentNode.insertBefore(input, list);
  }

  /* ---------- 文章页：相关文章（标签重叠度） ---------- */

  function initRelated() {
    var path = location.pathname.split('/').pop();
    var me = POSTS.filter(function (p) { return p.url.indexOf(path) >= 0; })[0];
    if (!me) return;
    var box = document.querySelector('.post-comments');
    if (!box) return;

    var scored = POSTS.filter(function (p) { return p !== me; }).map(function (p) {
      var overlap = p.tags.filter(function (t) { return me.tags.indexOf(t) >= 0; }).length;
      return { p: p, s: overlap };
    }).filter(function (x) { return x.s > 0; })
      .sort(function (a, b) { return b.s - a.s; })
      .slice(0, 2);
    if (!scored.length) return;

    var root = me.url.indexOf('posts/') === 0 ? '../' : '';
    var html = '<h2 class="msg-wall-title">相关阅读</h2><div class="related-grid">';
    scored.forEach(function (x) {
      html += '<a class="related-card" href="' + root + x.p.url + '">' +
        '<b>' + x.p.title + '</b><span>' +
        x.p.tags.map(function (t) { return '#' + t; }).join(' ') + '</span></a>';
    });
    html += '</div>';
    box.insertAdjacentHTML('beforebegin', html);
  }

  if (location.pathname.indexOf('archive') >= 0 ||
      document.querySelector('.archive-list')) {
    initSearch();
  }
  if (document.querySelector('.post-content')) {
    initRelated();
  }
})();
