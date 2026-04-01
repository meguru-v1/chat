# 📺 YouTube Smart-Archiver v2.1 (Zero-Setup / No-Token Mode)

YouTube ライブチャットを自動で監視し、録画・解析・PDFレポート生成までを GitHub Actions だけで完結させる、究極の個人用アーカイブシステムです。

## ✨ v2.1 の特徴
- **データベース不要**: MongoDB などの外部サービスへの登録は一切不要です。
- **トークン不要 (Web UI)**: ゲストユーザーがブラウザで GitHub トークンを入力する必要がありません。
- **セキュア中継**: Google Apps Script (GAS) を介して安全に録画命令を送ります。
- **オートメーション**: チャンネル ID を登録しておくだけで、24時間 365日 自動で録画が始まります。

---

## 🚀 導入方法 (フォークした人向け)

### 1. リポジトリの準備
1. このリポジトリを **[Fork]** します。
2. GitHub の **Settings > Secrets and variables > Actions** に以下のシークレットを追加します。
   - `YOUTUBE_API_KEY`: YouTube Data API v3 のキー

### 2. 中継サーバー (GAS) の設定 (手動ボタンを使う場合)
1. `gas/proxy.js` の中身をコピーします。
2. [Google Apps Script](https://script.google.com/) で新規プロジェクトを作成し、コードを貼り付けます。
3. スクリプトの設定（歯車）から以下の「スクリプトプロパティ」を追加します。
   - `GH_TOKEN`: あなたの GitHub トークン (repo 権限)
   - `GH_REPO`: あなたのリポジト名 (例: `yourname/chat`)
4. 「デプロイ」>「新しいデプロイ」から「ウェブアプリ」として公開（アクセス：全員）し、URL をコピーします。
5. `public/app.js` の冒頭にある `GAS_PROXY_URL` に、コピーした URL を貼り付けてコミットします。

### 3. 公開設定
1. GitHub の **Settings > Pages** で、Build and deployment の Source を `GitHub Actions` に設定します。
2. これで `https://yourname.github.io/chat/` でダッシュボードが公開されます！

---

## 🎙️ 使い方

- **自動監視**: `public/channels.json` に録画したいチャンネル ID を追記するだけです。10分ごとに自動でチェックされます。
- **手動録画**: ダッシュボードの入力欄に Video ID を入れてボタンを押すと、即座に録画 Actions が起動します。

## 📄 ライセンス
MIT License.
