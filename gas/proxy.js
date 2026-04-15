/**
 * YouTube Smart-Archiver: GitHub Actions Proxy v3.0
 *
 * 【設定方法】
 * 1. Google スプレッドシート（またはフォーム）のメニューから「拡張機能」→「Apps Script」を開きます。
 * 2. このコードをすべて貼り付けます。
 * 3. 左側の「設定（歯車アイコン）」から「スクリプトプロパティ」を開き、以下を追加します：
 *    - GH_TOKEN: あなたの GitHub 個人アクセストークン (PAT)
 *    - GH_REPO: あなたのリポジトリ名 (例: meguru-v1/chat)
 * 4. 右上の「デプロイ」→「新しいデプロイ」をクリックし、「種類」を「ウェブアプリ」にします。
 * 5. 「アクセスできるユーザー」を「全員」にしてデプロイし、発行された URL をコピーしてください。
 *
 * 【対応アクション】
 * - record: 録画開始（workflow_dispatch）
 * - stop: 録画停止（cancel）
 * - update_channels: channels.json の追加・削除
 */

function doPost(e) {
  var props = PropertiesService.getScriptProperties();
  var ghToken = props.getProperty('GH_TOKEN');
  var ghRepo = props.getProperty('GH_REPO');
  
  if (!ghToken || !ghRepo) {
    return createResponse({ status: 'error', message: 'GAS 側の設定(Token/Repo)が未完了です。' });
  }

  // ✅ バグ修正: JSONパース失敗時にクラッシュしないよう try-catch で保護
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return createResponse({ status: 'error', message: 'リクエストのフォーマットが不正です。' });
  }
  var action = payload.action || 'record';

  // ---------------------
  // 録画開始
  // ---------------------
  if (action === 'record') {
    var videoId = payload.videoId;
    var url = 'https://api.github.com/repos/' + ghRepo + '/actions/workflows/record.yml/dispatches';
    var body = JSON.stringify({
      ref: 'main',
      inputs: { video_id: videoId }
    });

    return callGitHub(url, 'post', body, ghToken);
  }

  // ---------------------
  // 録画停止
  // ---------------------
  if (action === 'stop') {
    var runId = payload.runId;
    var url = 'https://api.github.com/repos/' + ghRepo + '/actions/runs/' + runId + '/cancel';
    return callGitHub(url, 'post', null, ghToken);
  }

  // ---------------------
  // 録画状況の取得 (API制限回避)
  // ---------------------
  if (action === 'get_status') {
    var url = 'https://api.github.com/repos/' + ghRepo + '/actions/runs?per_page=10';
    return callGitHub(url, 'get', null, ghToken);
  }

  // ---------------------
  // ④ チャンネル管理
  // ---------------------
  if (action === 'update_channels') {
    return handleChannelUpdate(payload, ghToken, ghRepo);
  }

  return createResponse({ status: 'error', message: '不明なアクション: ' + action });
}

/**
 *ブラウザからの GET リクエスト（ステータス確認）に対応
 */
function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  var ghToken = props.getProperty('GH_TOKEN');
  var ghRepo = props.getProperty('GH_REPO');
  
  if (!ghToken || !ghRepo) {
    return createResponse({ status: 'error', message: 'GAS 側の設定未完了' });
  }

  var url = 'https://api.github.com/repos/' + ghRepo + '/actions/runs?per_page=10';
  return callGitHub(url, 'get', null, ghToken);
}

/**
 * ④ channels.json を GitHub Contents API 経由で更新
 */
function handleChannelUpdate(payload, ghToken, ghRepo) {
  var operation = payload.operation; // 'add' or 'remove'
  var filePath = 'channels.json';
  var apiUrl = 'https://api.github.com/repos/' + ghRepo + '/contents/' + filePath;

  try {
    // 1. 現在の channels.json を取得
    var getRes = UrlFetchApp.fetch(apiUrl, {
      headers: {
        'Authorization': 'token ' + ghToken,
        'Accept': 'application/vnd.github.v3+json'
      },
      muteHttpExceptions: true
    });

    if (getRes.getResponseCode() !== 200) {
      return createResponse({ status: 'error', message: 'channels.json の取得に失敗: ' + getRes.getContentText() });
    }

    var fileData = JSON.parse(getRes.getContentText());
    var sha = fileData.sha;
    var content = Utilities.newBlob(Utilities.base64Decode(fileData.content)).getDataAsString();
    var channels = JSON.parse(content);

    // 2. 操作実行
    if (operation === 'add') {
      var channelIdentifier = payload.channelIdentifier || '';
      var channelId = '';
      var channelName = '';

      // UC で始まる場合はチャンネル ID そのもの
      if (channelIdentifier.startsWith('UC')) {
        channelId = channelIdentifier;
        channelName = channelIdentifier; // 名前は後で手動修正可能
      } else {
        // @handle の場合は YouTube API でチャンネル ID を解決
        // ※簡易実装：直接 YouTube ページからスクレイピング
        var ytApiKey = PropertiesService.getScriptProperties().getProperty('YOUTUBE_API_KEY');
        if (ytApiKey && channelIdentifier.startsWith('@')) {
          var handle = channelIdentifier.replace('@', '');
          // ✅ バグ修正: search API(10クレジット)ではなく channels?forHandle(0クレジット)で解決
          var resolveUrl = 'https://www.googleapis.com/youtube/v3/channels?part=snippet&forHandle=' + encodeURIComponent(handle) + '&key=' + ytApiKey;
          var searchRes = UrlFetchApp.fetch(resolveUrl, { muteHttpExceptions: true });
          if (searchRes.getResponseCode() === 200) {
            var searchData = JSON.parse(searchRes.getContentText());
            if (searchData.items && searchData.items.length > 0) {
              channelId = searchData.items[0].id;
              channelName = searchData.items[0].snippet.title;
            }
          }
        }

        if (!channelId) {
          return createResponse({ status: 'error', message: 'チャンネル ID を解決できませんでした。UC... 形式の ID を直接入力してください。' });
        }
      }

      // 重複チェック
      var exists = channels.some(function(ch) { return ch.id === channelId; });
      if (exists) {
        return createResponse({ status: 'error', message: 'このチャンネルは既に登録されています。' });
      }

      channels.push({ id: channelId, name: channelName });

    } else if (operation === 'remove') {
      var removeId = payload.channelId;
      channels = channels.filter(function(ch) { return ch.id !== removeId; });
    }

    // 3. 更新した channels.json をコミット
    var newContent = Utilities.base64Encode(JSON.stringify(channels, null, 2) + '\n');
    var updateBody = JSON.stringify({
      message: 'chore: チャンネルリストを更新 (' + operation + ')',
      content: newContent,
      sha: sha
    });

    var updateRes = UrlFetchApp.fetch(apiUrl, {
      method: 'put',
      headers: {
        'Authorization': 'token ' + ghToken,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      payload: updateBody,
      muteHttpExceptions: true
    });

    if (updateRes.getResponseCode() === 200 || updateRes.getResponseCode() === 201) {
      return createResponse({ status: 'success', message: 'チャンネルリストを更新しました。' });
    } else {
      return createResponse({ status: 'error', message: 'channels.json の更新に失敗: ' + updateRes.getContentText() });
    }

  } catch (err) {
    return createResponse({ status: 'error', message: '通信エラー: ' + err.message });
  }
}

function callGitHub(url, method, body, token) {
  var options = {
    method: method,
    headers: {
      'Authorization': 'token ' + token,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    payload: body,
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(url, options);
    var code = response.getResponseCode();
    var content = response.getContentText();
    
    // get_status の場合は取得した JSON をそのまま返す
    if (method.toLowerCase() === 'get') {
      return createResponse(JSON.parse(content));
    }

    if (code === 204 || code === 202 || code === 200) {
      return createResponse({ status: 'success', message: '命令を GitHub に送信しました。' });
    } else {
      return createResponse({ status: 'error', message: 'GitHub API エラー: ' + content });
    }
  } catch (err) {
    return createResponse({ status: 'error', message: '通信エラー: ' + err.message });
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
