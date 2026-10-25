#!/usr/bin/env bash
# ============================================================
# 新建一篇文章的脚手架
#   用法：bash new-post.sh my-new-post "文章的中文标题"
# 做三件事：
#   1. 复制模板为 posts/<文件名>.html 并替换标题
#   2. 提醒你要编辑的五个位置（见模板内注释）
#   3. 提醒发布前列表页要加的三处链接
# ============================================================
set -e
SLUG="${1:?用法: bash new-post.sh my-new-post \"文章标题\"}"
TITLE="${2:-未命名文章}"
DATE=$(date +%F)

cp posts/_template.html "posts/$SLUG.html"
# Windows Git Bash 自带 sed
sed -i "s|文章标题 · 吴子航的博客|$TITLE · 吴子航的博客|; s|<h1>文章标题</h1>|<h1>$TITLE</h1>|; s|content=\"2026-10-19\"|content=\"$DATE\"|" "posts/$SLUG.html"

cat << EOF
✅ 已创建 posts/$SLUG.html（标题：$TITLE，日期：$DATE）

接下来手动完成（模板文件顶部注释也有说明）：
  1. 编辑 posts/$SLUG.html：摘要、阅读时长、正文、文末标签
  2. index.html    —— 首页文章列表加一篇（最上面）
  3. archive.html  —— 归档列表加一行
  4. tags.html     —— 对应标签 section 加一行（新标签要加索引）
  5. 新文章顶部「上一篇」指向原最新文章，原最新文章「下一篇」指向新文章

写完预览：python preview-server.py → http://127.0.0.1:8123
发布上线：bash publish.sh
EOF
