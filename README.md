# 📺 YouTube Live Chat Smart-Archiver (Hybrid / Auto-Monitor)

YouTubeライブ配信のチャットを **APIキー最小限 & ブラウザ方式** で精密に記録し、配信の盛り上がりを分析した **統計付き日本語PDFレポート** を自動生成するツールです。
特定のチャンネルを24時間監視し、ライブが始まった瞬間に自動で録画を開始する「全自動見守りモード」を搭載しています。

## ✨ 主な特徴

- **完全サーバーレス**: GitHub Actions のみで動作し、24時間365日の監視・録画が無料（パブリックリポジトリ）で可能です。
- **24時間全自動監視 (New!)**: `channels.json` にチャンネルIDを登録するだけで、配信開始を自動検知して録画をスタートします。
- **APIキー最小限 & 安定録画**: 監視には低コストな API (1クレジット) を使い、録画には Puppeteer (ブラウザ) を使うことで、制限を回避しつつ確実な記録を実現。
- **最初から記録**: 監視のラグ（最大5分）で流れたチャットも、起動直後の「初期バッファ回収機能」により可能な限り遡って記録します。
- **統計レポート**: 盛り上がりを可視化したグラフ付きの A4 PDF を自動生成。NotoSansJP フォント埋め込みで文字化けもありません。

---

## 🚀 使い方

### 1. 準備 (初回のみ)
1. このリポジトリを自分のアカウントに **[Fork]** します。
2. リポジトリの **[Settings] -> [Secrets and variables] -> [Actions]** で以下のシークレットを設定します。
   - `YOUTUBE_API_KEY`: Google Cloud で発行した YouTube Data API v3 のキー（監視に使用）
   - `MONGODB_URI`: チャット保存用の MongoDB 接続文字列（MongoDB Atlas 等）

### 2. 全自動監視の設定
1. リポジトリ内の `channels.json` を編集し、監視したいチャンネル ID を追加してコミットします。
   ```json
   [
     { "id": "UC_xxxxxxxxxxxx", "name": "チャンネル名" }
   ]
   ```
2. `monitor.yml` ワークフローが自動的に10分おきに巡回を開始します。

### 3. 手動での録画開始
1. **[Actions]** タブから **「📺 YouTube チャット録画 & PDFレポート生成」** を選択。
2. **[Run workflow]** ボタンをクリックし、`video_id` を入力して実行します。

---

## 🏗️ ディレクトリ構成

```
chat/
├── .github/workflows/
│   ├── monitor.yml         # 定期監視ワークフロー
│   └── record.yml          # 録画 & PDF生成ワークフロー
├── channels.json           # 監視対象チャンネルリスト
├── src/
│   ├── monitor.ts          # ライブ配信探知エンジン
│   ├── standalone-recorder.ts  # ブラウザ録画エンジン
│   └── pdfService.ts       # 統計 & PDF生成ロジック
```

## 📜 ライセンス
MIT
