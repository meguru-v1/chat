# 📺 YouTube Live Chat Smart-Archiver

YouTubeライブ配信のチャットを **APIキー不要** で精密に記録し、配信の盛り上がりを分析した **統計付き日本語PDFレポート** を自動生成するツールです。

## 🚀 GitHub だけで使う（設定不要・無料！）

**ブラウザだけで完結。インストールも API キーの発行も不要です。**

1. このリポジトリを自分のアカウントに **[Fork]** する
2. リポジトリの **[Actions]** タブを開く
3. 左メニューから **「📺 YouTube チャット録画 & PDFレポート生成」** を選択
4. **[Run workflow]** ボタンをクリック
5. `video_id` にYouTubeライブ配信のVideo IDを入力して実行
6. 実行完了後、**Artifacts** セクションからPDFレポートをダウンロード

> 💡 **Video IDとは？** YouTubeのURL `https://www.youtube.com/watch?v=XXXXXXXXXXX` の `v=` 以降の部分です。

---

## ✨ 主な機能

- 🎙️ **APIキー完全不要** — `youtube-chat` ライブラリによるスクレイピング方式を採用。面倒な設定は一切ありません。
- ⏱️ **長時間録画対応** — GitHub Actions の上限（6時間）まで、安定して録画・保存を継続します。
- 📊 **等間隔・時刻ベース統計** — 総コメント数、10〜15分ごとのチャット密度、ピーク時刻を自動計算。
- 📄 **日本語PDF自動生成** — 日本時間 (JST) で記録された美しいレポートを生成。NotoSansJP フォント埋め込みで文字化けもありません。
- 🆓 **完全無料** — 公開リポジトリとして使用する場合、GitHub Actions の実行コストは完全に無料です。

---

## 🏗️ ディレクトリ構成

```
chat/
├── .github/workflows/
│   └── record.yml          # GitHub Actions ワークフロー
├── package.json
├── tsconfig.json
└── src/
    ├── standalone-recorder.ts  # 録画 & PDF生成メインエンジン
    ├── pdfService.ts           # 統計 & 日本語PDF生成ロジック
    ├── models/
    │   └── ChatMessage.ts      # MongoDB スキーマ
    └── utils/
        └── fontDownloader.ts   # フォント自動セットアップ
```

---

## 🖥️ ローカルで開発・実行する場合

### 前提条件
- Node.js 20+
- MongoDB 7+ (Docker推奨)

### セットアップ
```bash
npm install
npm run download-font
# 録画実行（引数に Video ID を指定）
npx ts-node src/standalone-recorder.ts --video-id [VIDEO_ID] --timeout 360
```

## 📜 ライセンス
MIT
