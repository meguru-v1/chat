# 📺 YouTube Smart-Archiver v3.0 (Actions + GAS Proxy Mode)

YouTube ライブチャットを自動で監視し、統計付き PDF レポートを生成する、完全サーバーレスなアーカイブシステムです。

## ✨ v3.0 の最新機能
- **🎨 レポートデザイン刷新**: ランクキング、カラー帯セクション、ページ番号等を備えたプレミアムな PDF 生成。
- **🛰️ チャンネル管理 UI**: Web ダッシュボードから直接チャンネルの追加・削除が可能（リポジトリの編集不要）。
- **🔍 高性能モニター**: RSS フィードの最新 3 件を巡回し、複数の同時配信や待機所（5分前）も漏らさずキャッチ。
- **🚫 二重録画防止**: GitHub API を連携させ、既に録画中のジョブと同じ動画を重複して起動するのを防ぎます。
- **⚠️ ログ・エラー管理**: GitHub API 制限時の警告表示（復活時刻の提示）や、エラー時の履歴保存機能を搭載。

---

## 🚀 導入方法

### 1. リポジトリの準備
1. このリポジトリを **[Fork]** します。
2. GitHub の **Settings > Secrets and variables > Actions** に以下のシークレットを追加します。
    - `YOUTUBE_API_KEY`: YouTube Data API v3 のキー
    - `GITHUB_TOKEN`: 手動停止や二重起動防止に使用（デフォルトの GITHUB_TOKEN が使われますが、必要に応じて PAT を設定してください）

### 2. 中継サーバー (GAS) の設定
1. `gas/proxy.js` の内容をコピーします。
2. [Google Apps Script](https://script.google.com/) で新規プロジェクトを作成し、コードを貼り付けます。
3. スクリプトの設定（歯車）から以下の「スクリプトプロパティ」を追加します。
    - `GH_TOKEN`: あなたの GitHub トークン (repo 権限)
    - `GH_REPO`: あなたのリポジトリ名 (例: `yourname/chat`)
    - `YOUTUBE_API_KEY`: (推奨) チャンネル名から ID を解決するために必要。
4. 「デプロイ」>「デプロイを管理」から「ウェブアプリ」として公開（アクセス：全員）し、URL をコピーします。
5. `public/app.js` の冒頭にある `GAS_PROXY_URL` に、コピーした URL を貼り付けてコミットします。

### 3. 公開設定
1. GitHub の **Settings > Pages** で、Build and deployment の Source を `GitHub Actions` に設定します。
2. 以降、`https://yourname.github.io/chat/` でダッシュボードが公開されます。

---

## 🎙️ 使い方

- **自動監視**: 10分ごとに `monitor.ts` が巡回します。チャンネルの追加・削除はダッシュボードの UI から行えます。
- **手動録画**: ダッシュボードの入力欄に YouTube の URL または Video ID を入れてボタンを押すと、即座に録画 Actions が起動します。
- **API 制限対策**: クォータ制限（403 エラー）を検知すると、UI 上にリセット時刻が表示され、自動チェック間隔が延長されます。

## 📄 ライセンス
MIT License.
