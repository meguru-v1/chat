#!/usr/bin/env bash
# ============================================================
# setup-repo.sh — GitHub リポジトリ自動セットアップスクリプト
# .env の GITHUB_TOKEN / GITHUB_REPO を使用
# ============================================================
set -euo pipefail

# .env 読み込み（安全なパース: スペース・引用符を含む値も正しく処理）
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    # コメント行と空行をスキップ
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    # 値の前後のクォートを除去してエクスポート
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    export "$key=$value"
  done < .env
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
