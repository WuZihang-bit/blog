#!/usr/bin/env bash
# ============================================================
# 一键发布博客到 GitHub Pages（只需成功运行一次）
#   前置：先在终端运行  gh auth login  完成登录
#   用法：bash publish.sh
# 做四件事：
#   1. 创建 GitHub 仓库（名字默认 blog，可改）
#   2. 推送全部代码
#   3. 开启 GitHub Pages（main 分支根目录）
#   4. 打印 Giscus 评论系统需要的配置（repoId / categoryId）
#      → 把它们填进 comments.js 的 GISCUS_CONFIG 即完成评论接入
# ============================================================
set -e
REPO_NAME="${1:-blog}"

echo "==> 1/4 创建仓库 $REPO_NAME（若已存在会自动改用已有仓库）"
gh repo create "$REPO_NAME" --public --source=. --remote=origin --push 2>/dev/null \
  || { git remote add origin "https://github.com/$(gh api user -q .login)/$REPO_NAME.git"; }

echo "==> 2/4 推送代码"
git add -A
git commit -m "更新：$(date +%F' '%H:%M)" 2>/dev/null || true
git push -u origin main

OWNER=$(gh api user -q .login)
echo "==> 3/4 开启 GitHub Pages"
gh api -X POST "repos/$OWNER/$REPO_NAME/pages" \
  -f "source[branch]=main" -f "source[path]=/" 2>/dev/null \
  || echo "    （Pages 可能已开启，忽略）"

echo "==> 4/4 获取 Giscus 评论配置"
REPO_ID=$(gh api graphql -f query="repository(owner:\"$OWNER\", name:\"$REPO_NAME\"){id}" -q .data.repository.id)
cat << EOF

============================================================
✅ 发布完成！博客地址：
   https://$OWNER.github.io/$REPO_NAME/
   （首次构建约 1–2 分钟后生效）

📌 Giscus 评论配置（填到 js/comments.js 顶部）：
   repo:          "$OWNER/$REPO_NAME"
   repoId:        "$REPO_ID"

接下来手动做两步（一次性）：
   1. 打开 https://github.com/apps/giscus → Add → 勾选 $REPO_NAME 仓库
   2. 打开 https://giscus.app/zh-CN → 填入 $OWNER/$REPO_NAME
      → Discussion 分类选 Announcements
      → 把页面显示的 categoryId 复制进 js/comments.js
============================================================
EOF
