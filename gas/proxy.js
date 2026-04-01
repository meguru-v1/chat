/**
 * YouTube Smart-Archiver: GitHub Actions Proxy
 *
 * 【設定方法】
 * 1. Google スプレッドシート（またはフォーム）のメニューから「拡張機能」→「Apps Script」を開きます。
 * 2. このコードをすべて貼り付けます。
 * 3. 左側の「設定（歯車アイコン）」から「スクリプトプロパティ」を開き、以下を追加します：
 *    - GH_TOKEN: あなたの GitHub 個人アクセストークン (PAT)
 *    - GH_REPO: あなたのリポジトリ名 (例: meguru-v1/chat)
 * 4. 右上の「デプロイ」→「新しいデプロイ」をクリックし、「種類」を「ウェブアプリ」にします。
 * 5. 「アクセスできるユーザー」を「全員」にしてデプロイし、発行された URL をコピーしてください。
 */

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const ghToken = props.getProperty('GH_TOKEN');
  const ghRepo = props.getProperty('GH_REPO');
  
  if (!ghToken || !ghRepo) {
    return createResponse({ status: 'error', message: 'GAS 側の設定(Token/Repo)が未完了です。' });
  }

  const payload = JSON.parse(e.postData.contents);
  const videoId = payload.videoId;
  const action = payload.action || 'record'; // 'record' or 'stop'

  let url, method, body;

  if (action === 'record') {
    // 録画開始 (workflow_dispatch)
    url = `https://api.github.com/repos/${ghRepo}/actions/workflows/record.yml/dispatches`;
    method = 'post';
    body = JSON.stringify({
      ref: 'main',
      inputs: { video_id: videoId }
    });
  } else if (action === 'stop') {
    // 録画停止 (cancel)
    const runId = payload.runId;
    url = `https://api.github.com/repos/${ghRepo}/actions/runs/${runId}/cancel`;
    method = 'post';
    body = null;
  }

  const options = {
    method: method,
    headers: {
      'Authorization': `token ${ghToken}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    payload: body,
    muteHttpExceptions: true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();
    
    if (code === 204 || code === 202 || code === 200) {
      return createResponse({ status: 'success', message: `${action} 命令を GitHub に送信しました。` });
    } else {
      return createResponse({ status: 'error', message: `GitHub API エラー: ${response.getContentText()}` });
    }
  } catch (err) {
    return createResponse({ status: 'error', message: `通信エラー: ${err.message}` });
  }
}

function createResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// CORS対応 (ブラウザからのテスト用)
function doOptions(e) {
  return ContentService.createTextOutput("")
    .setMimeType(ContentService.MimeType.TEXT);
}
