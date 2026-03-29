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

# Python + chat-downloader のインストール
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv git && \
    python3 -m venv /opt/venv && \
    /opt/venv/bin/pip install --no-cache-dir chat-downloader && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=builder /app/dist ./dist

# フォントダウンロード用スクリプト実行
RUN node dist/utils/fontDownloader.js

EXPOSE 3000
CMD ["node", "dist/app.js"]
