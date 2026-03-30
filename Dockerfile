# ---- Build Stage ----
FROM node:20-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---- Production Stage ----
FROM node:20-slim

# Python依存を削除（Node.jsベースの公式APIポーリング方式に変更したため）

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# フォントダウンロード用スクリプト実行
RUN node dist/utils/fontDownloader.js

EXPOSE 3000
CMD ["node", "dist/app.js"]
