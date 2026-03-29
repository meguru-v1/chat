#!/usr/bin/env bash
# ============================================================
# setup-repo.sh — GitHub リポジトリ自動セットアップスクリプト
# .env の GITHUB_TOKEN / GITHUB_REPO を使用
# ============================================================
set -euo pipefail

# .env 読み込み
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPO:-}" ]; then
  echo "❌ .env に GITHUB_TOKEN と GITHUB_REPO を設定してください"
  exit 1
fi

echo "📦 Git リポジトリを初期化..."
git init

echo "📝 全ファイルをステージング..."
git add .

echo "💾 初回コミット..."
git commit -m "🎉 Initial commit — YouTube Chat Smart-Archiver"

echo "🔗 リモートリポジトリを追加..."
git remote add origin "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git" 2>/dev/null || \
  git remote set-url origin "https://${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git"

echo "🚀 プッシュ..."
git push -u origin main || git push -u origin master

echo "✅ 完了！ https://github.com/${GITHUB_REPO}"
