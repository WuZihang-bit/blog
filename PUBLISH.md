# 发文清单（PUBLISH）

本站零框架零构建，文章列表是手写在 HTML 里的。发一篇新文章 = 新建 1 个文件 + 更新 3 个列表页 + push。
照着下面 6 步勾完即可。也可以把 Markdown 草稿交给 ZCode，说「按 PUBLISH.md 流程发布这篇文章」，让助手完成 1~4 步的机械活，自己只做第 5、6 步。

## 第 1 步 · 新建文章页

复制 `posts/_template.html` 为 `posts/英文短横线文件名.html`，修改：

- [ ] `<title>`、meta description、og:title / og:description（摘要一两句话）
- [ ] `article:published_time` 和正文 `<time>` 两个日期（保持一致）
- [ ] 阅读时长（按约 300 字/分钟估算）
- [ ] `<h1>` 标题 + 正文
- [ ] 文末标签链接：`../tags.html#tag-xxx` 的 id 必须和 tags.html 里的 section id 对应
- [ ] 「上一篇」链接指向当前最新的那篇文章

## 第 2 步 · 首页加卡片（index.html）

在「最新文章」列表**顶部**插入（替换 `?` 处）：

```html
<article class="post-item">
  <div class="post-meta">
    <time datetime="YYYY-MM-DD">YYYY-MM-DD</time>
    <span class="dot">·</span>
    <span>约 X 分钟</span>
    <span class="dot">·</span>
    <a class="meta-tag" href="tags.html#tag-xxx">标签</a>
  </div>
  <h2><a href="posts/文件名.html">标题</a></h2>
  <p class="post-excerpt">两三句摘要。</p>
</article>
```

- [ ] 已插入；如列表超过 5 条，把最旧的卡片删掉（首页只留最新几篇，全量在归档页）

## 第 3 步 · 归档页加一行（archive.html）

在对应年份列表顶部插入：

```html
<li><time>MM-DD</time><a href="posts/文件名.html">标题</a></li>
```

- [ ] 已插入；如需新年份分组，复制一份年份 `<section>`

## 第 4 步 · 标签页（tags.html）

- [ ] 每个标签：已有 → 在对应 `<section id="tag-xxx">` 的列表里加一行链接
- [ ] 全新标签 → 顶部标签索引导航加 `<a href="#tag-xxx">名称</a>` + 新建一个 section（注意 id 规则：`tag-` + 英文短横线）

## 第 5 步 · 本地检查

- [ ] 在 blog 目录跑 `python preview-server.py`，开 http://127.0.0.1:8123（禁缓存；双击 HTML 预览也行）
- [ ] 新文章页深浅色都正常
- [ ] 从首页 / 归档 / 标签页都能点进新文章
- [ ] 标签锚点跳转正确、「上一篇」链接正确

## 第 6 步 · 发布

```bash
git add .
git commit -m "发布：文章标题"
git push
```

- [ ] push 后约 1 分钟，线上更新：https://wuzihang-blog-example.github.io/blog/ （首次部署后把这里改成真实地址）

## 备注

- 本站部署在 GitHub Pages（main 分支根目录），`.nojekyll` 让所有文件按原样发布。
- 仓库地址与本地目录：`blog/` 即仓库根目录。
