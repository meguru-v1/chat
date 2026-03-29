# 📺 YouTube Live Chat Smart-Archiver

YouTubeライブ配信のチャットを **テキストのみ** で精密に記録し、配信の盛り上がりを分析した **統計付き日本語PDFレポート** を自動生成する。

## 🚀 GitHub だけで使う（ローカル不要！）

### 方法1: GitHub Actions（最もかんたん）

**ブラウザだけで完結。インストール不要。**

1. GitHubリポジトリの **[Actions]** タブを開く
2. 左メニューから **「📺 YouTube チャット録画 & PDFレポート生成」** を選択
3. **[Run workflow]** ボタンをクリック
4. `video_id` にYouTubeライブ配信のVideo IDを入力
5. 実行が完了すると **Artifacts** セクションからPDFをダウンロード

> 💡 **Video IDとは？** YouTubeのURL `https://www.youtube.com/watch?v=XXXXXXXXXXX` の `v=` 以降の部分です。

### 方法2: GitHub Codespaces（開発・カスタマイズ用）

**ブラウザ上でVS Codeが開き、全環境が自動セットアップされる。**

1. リポジトリページで **[<> Code]** → **[Codespaces]** → **[Create codespace on main]**
2. 自動セットアップ完了を待つ（約2分）
3. ターミナルで `npm run dev` を実行
4. `api.http` ファイルを開いてAPIをテスト

---

## ✨ 主な機能

- 🎙️ **リアルタイム チャット録画** — `chat-downloader` でYouTubeライブチャットを取得
- ⏱️ **ハイブリッド終了判定** — 配信終了検知 + 5分間アイドルタイムアウト
- 📊 **統計分析** — 総コメント数、毎分流速、ピーク時間帯の自動計算
- 📄 **日本語PDF生成** — NotoSansJPフォント埋め込みで文字化け完全回避
- 🔌 **REST API** — フロントエンドと連携可能なExpress API

## 📡 API 仕様

| エンドポイント | メソッド | 説明 |
|---|---|---|
| `/health` | GET | ヘルスチェック |
| `/api/record/start` | POST | `{ "videoId": "xxx" }` で録画開始 |
| `/api/record/stop` | POST | `{ "videoId": "xxx" }` で録画停止 |
| `/api/record/status` | GET | アクティブセッション一覧 |
| `/api/sessions` | GET | 保存済みセッション一覧 |
| `/api/sessions/:id/pdf` | GET | PDF生成＆ダウンロード |

## 🏗️ ディレクトリ構成

```
chat/
├── .github/workflows/
│   └── record.yml          # GitHub Actions ワークフロー
├── .devcontainer/
│   └── devcontainer.json   # Codespaces 設定
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── api.http                # APIテスト用
├── .env.example
├── .gitignore
├── setup-repo.sh
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

## 🖥️ ローカルで使う場合

### 前提条件
- Node.js 20+
- Python 3.8+ (`pip install chat-downloader`)
- MongoDB 7+

### セットアップ
```bash
npm install
pip install chat-downloader
npm run download-font
npm run dev
```

## 📜 ライセンス

MIT
