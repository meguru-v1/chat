# 📺 YouTube Live Chat Smart-Archiver

YouTubeライブ配信のチャットを **テキストのみ** で精密に記録し、配信の盛り上がりを分析した **統計付き日本語PDFレポート** を自動生成するNode.js/TypeScriptアプリケーション。

## ✨ 主な機能

- 🎙️ **リアルタイム チャット録画** — `chat-downloader` を使用してYouTubeライブチャットを取得
- ⏱️ **ハイブリッド終了判定** — 配信終了検知 + 5分間アイドルタイムアウト
- 📊 **統計分析** — 総コメント数、毎分流速、ピーク時間帯の自動計算
- 📄 **日本語PDF生成** — NotoSansJPフォント埋め込みで文字化け完全回避
- 🔌 **REST API** — フロントエンドと連携可能なExpress API

## 📋 前提条件

- **Node.js** 20+
- **Python** 3.8+（`chat-downloader` 用）
- **MongoDB** 7+（Docker推奨）
- **Docker & Docker Compose**（推奨）

## 🚀 セットアップ（ローカル）

### 1. 依存インストール

```bash
# Node.js
npm install

# Python (chat-downloader)
pip install chat-downloader
```

### 2. 環境変数

```bash
cp .env.example .env
# .env を編集してMongoDB URI等を設定
```

### 3. MongoDB起動

```bash
docker compose up -d mongodb
```

### 4. フォントダウンロード

```bash
npm run download-font
```

### 5. 開発サーバー起動

```bash
npm run dev
```

## 🐳 Docker で起動（推奨）

```bash
docker compose up --build
```

## 📡 API 仕様

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/api/record/start` | POST | `{ "videoId": "xxx" }` で録画開始 |
| `/api/record/stop` | POST | `{ "videoId": "xxx" }` で録画停止 |
| `/api/record/status` | GET | アクティブセッション一覧 |
| `/api/sessions` | GET | 保存済みセッション一覧 |
| `/api/sessions/:id/pdf` | GET | PDF生成＆ダウンロード |

### 使用例

```bash
# 録画開始
curl -X POST http://localhost:3000/api/record/start \
  -H "Content-Type: application/json" \
  -d '{"videoId": "dQw4w9WgXcQ"}'

# 録画停止
curl -X POST http://localhost:3000/api/record/stop \
  -H "Content-Type: application/json" \
  -d '{"videoId": "dQw4w9WgXcQ"}'

# PDF取得
curl http://localhost:3000/api/sessions/dQw4w9WgXcQ/pdf -o report.pdf
```

## 🏗️ ディレクトリ構成

```
chat/
├── docker-compose.yml       # MongoDB + App
├── Dockerfile              # マルチステージビルド
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── setup-repo.sh           # GitHub自動プッシュ
├── README.md
├── fonts/                  # 自動DL（.gitignore対象）
└── src/
    ├── app.ts              # Express API サーバー
    ├── recorder.ts         # Worker Thread 管理
    ├── pdfService.ts       # 統計 & PDF 生成
    ├── models/
    │   └── ChatMessage.ts  # Mongoose スキーマ
    ├── worker/
    │   └── recorderWorker.ts  # チャット取得Worker
    └── utils/
        └── fontDownloader.ts  # フォント自動DL
```

## 🔧 GitHub連携

```bash
# .env に GITHUB_TOKEN と GITHUB_REPO を設定してから:
chmod +x setup-repo.sh
./setup-repo.sh
```

## 📜 ライセンス

MIT
