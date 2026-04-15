/**
 * Smart-Archiver v3.0 (GAS Proxy Mode)
 * - チャンネル管理 UI
 * - GitHub API 制限表示
 * - エラー状態の赤バッジ表示
 */

// ==========================================
// 【重要】ここにデプロイした GAS の URL を貼ってください
// ==========================================
const GAS_PROXY_URL = 'https://script.google.com/macros/s/AKfycbyw6esXjC9lw6xQlBETaZTRBW8Yrw0A7M3wGecOFc4vpGEj4cn2IEPoMDaROqfCsxnGuQ/exec';

// 現在表示しているリポジトリ情報を自動取得 (フォーク対応)
const getRepoInfo = () => {
    const host = window.location.hostname;
    const path = window.location.pathname;
    
    if (host.includes('.github.io')) {
        const owner = host.split('.')[0];
        const repo = path.split('/')[1] || 'chat';
        return `${owner}/${repo}`;
    }
    return 'meguru-v1/chat';
};

const GITHUB_REPO = getRepoInfo();

// ⑥ レート制限管理
let isRateLimited = false;
let rateLimitResetTime = null;
let normalInterval = 60000; // 通常 60秒
let limitedInterval = 300000; // 制限中 5分
let statusTimer = null;

// ---------------------------
// DOM Elements
// ---------------------------
const form = document.getElementById('recordForm');
const videoIdInput = document.getElementById('videoIdInput');
const submitBtn = document.getElementById('submitBtn');
const activeList = document.getElementById('activeSessionsList');
const historyList = document.getElementById('historySessionsList');
const toast = document.getElementById('toast');
const rateLimitBanner = document.getElementById('rateLimitBanner');
const rateLimitMessage = document.getElementById('rateLimitMessage');
const channelList = document.getElementById('channelList');
const addChannelForm = document.getElementById('addChannelForm');
const channelUrlInput = document.getElementById('channelUrlInput');

// ---------------------------
// ユーティリティ関数群
// ---------------------------
function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message, type = 'success') {
  toast.className = `show ${type}`;
  toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> ${escapeHTML(message)}`;
  setTimeout(() => {
    toast.className = '';
  }, 4000);
}

function formatDate(dateStr) {
  if (!dateStr) return '-';
  const d = new Date(dateStr);
  return d.toLocaleString('ja-JP', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

// 動画タイトルの独自キャッシュ
const titleCache = {};

/** NoEmbedAPIを利用して画面上のIDを非同期でタイトルに置き換える */
async function resolveTitles() {
  const elements = document.querySelectorAll('.video-title-display');
  for (const el of elements) {
    const videoId = el.getAttribute('data-video-id');
    const currentText = el.textContent.trim();
    
    // 表示名がIDのまま（タイトルが未取得）の場合のみ実行
    if (currentText === videoId && videoId) {
      if (titleCache[videoId]) {
        el.textContent = titleCache[videoId];
      } else {
        try {
          const res = await fetch(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${videoId}`);
          const data = await res.json();
          if (data && data.title) {
            titleCache[videoId] = data.title;
            el.textContent = data.title;
          }
        } catch(e) {}
      }
    }
  }
}

/** 履歴アイテムの構築 */
function createSessionElement(session, displayState) {
  const li = document.createElement('li');
  li.className = 'session-item';

  const cloudBadge = `<span class="badge cloud" title="GitHub Actions"><i class="fas fa-cloud"></i> ACTIONS</span> `;
  let badgeHtml = '';
  let metaHtml = '';
  let actionHtml = '';

  if (displayState === 'recording') {
    badgeHtml = `<div class="badge-group">${cloudBadge}<div class="badge recording"><i class="fas fa-circle"></i> EXECUTING</div></div>`;
    metaHtml = `<span><i class="far fa-clock"></i> ${formatDate(session.startedAt)}</span>`;
    actionHtml = `<button class="btn-danger" onclick="stopActionsRun('${session.githubRunId}')"><i class="fas fa-stop"></i> 停止</button>`;
  } else if (displayState === 'error') {
    // エラー理由の日本語マッピング
    const reasonMap = {
      'api_error_quota':         'クォータ切れ',
      'api_error_403':           'APIアクセス拒否',
      'api_error_404':           'チャット未検出',
      'stream_ended_confirmed':  '配信終了を確認',
      'pdf_generation_failed':   'PDF生成失敗',
      'idle_timeout':            '更新なしタイムアウト',
      'max_duration':            '最大録画時間超過',
      'sigterm_forced':          'Actions強制終了',
      'sigint_manual':           '手動停止',
    };
    const reasonLabel = escapeHTML(session.reason ? (reasonMap[session.reason] || session.reason) : null);
    const reasonHtml = reasonLabel
      ? `<span style="color:#f59e0b;"><i class="fas fa-info-circle"></i> ${reasonLabel}</span>`
      : '';

    // ③ エラー状態の赤バッジ
    badgeHtml = `<div class="badge-group">${cloudBadge}<div class="badge" style="background:rgba(239,68,68,0.2);color:#ef4444;"><i class="fas fa-times-circle"></i> ERROR</div></div>`;
    metaHtml = `
      <span><i class="fab fa-youtube"></i> ${escapeHTML(session.videoId)}</span>
      <span><i class="far fa-calendar-alt"></i> ${formatDate(session.date)}</span>
      <span style="color:#ef4444;"><i class="fas fa-exclamation-triangle"></i> ${Number(session.messageCount).toLocaleString()}件取得</span>
      ${reasonHtml}
    `;
    actionHtml = '';
  } else {
    badgeHtml = `<div class="badge-group">${cloudBadge}<div class="badge success"><i class="fas fa-check-circle"></i> FINISHED</div></div>`;
    metaHtml = `
      <span><i class="fab fa-youtube"></i> ${escapeHTML(session.videoId)}</span>
      <span><i class="far fa-calendar-alt"></i> ${formatDate(session.date)}</span>
      <span><i class="far fa-comments"></i> ${Number(session.messageCount).toLocaleString()}件</span>
    `;
    // ✅ バグ修正: pdfPath が空/undefinedの場合 split で TypeError になる
    const baseUrl = window.location.origin + window.location.pathname.replace(/\/$/, '');
    const safePdfPath = session.pdfPath || '';
    const pdfUrl = safePdfPath
      ? `${baseUrl}/${safePdfPath.split('/').map(encodeURIComponent).join('/')}`
      : '#';
    actionHtml = pdfUrl !== '#'
      ? `
        <a href="${pdfUrl}" target="_blank" class="btn-primary" style="text-decoration:none; display:inline-block; padding:8px 12px; border-radius:6px; font-size:13px">
          <i class="fas fa-file-pdf"></i> レポート表示
        </a>`
      : '<span style="color:var(--muted); font-size:0.8rem;">PDFなし</span>';
  }

  let displayName = session.title || session.videoId;
  // タイトルが特殊な空白、空文字、またはタイトル不明の場合は videoId をセットして fallback の NoEmbed API 取得を誘発する
  if (!session.title || session.title.trim() === '' || session.title === '‍' || session.title === 'タイトル不明') {
    displayName = session.videoId;
  }

  // YouTubeのサムネイルを取得 (高画質が存在しない場合はデフォルトのmqdefaultを使用)
  const thumbUrl = `https://img.youtube.com/vi/${escapeHTML(session.videoId)}/mqdefault.jpg`;

  li.innerHTML = `
    <img class="session-thumb" src="${thumbUrl}" alt="Thumbnail" loading="lazy" onerror="this.src='icons/icon.png'">
    <div class="session-item-body">
      <div class="session-info">
        <div class="session-id">
          <span class="video-title-display" data-video-id="${escapeHTML(session.videoId)}">${escapeHTML(displayName)}</span>
          ${badgeHtml}
        </div>
        <div class="session-meta">
          ${metaHtml}
        </div>
      </div>
      <div class="session-action">
        ${actionHtml}
      </div>
    </div>
  `;
  return li;
}

// ---------------------------
// GitHub API / GAS 通信
// ---------------------------

async function loadStatus() {
  try {
    // 1. [改善] GAS 経由でステータスを取得（API制限 5000枠を共有）
    const url = `${GAS_PROXY_URL}?t=${Date.now()}`;
    const res = await fetch(url);

    // GAS 側でエラーが返ってきた場合
    if (!res.ok) {
      if (res.status === 403) {
        rateLimitMessage.textContent = 'API 制限中ですが、GAS プロキシにより 5分おきに再試行します。';
        rateLimitBanner.style.display = 'block';
        isRateLimited = true;
      }
      return;
    }

    const data = await res.json();
    
    // GAS 側からエラーメッセージが届いた場合
    if (data.status === 'error') {
      console.error('GAS Error:', data.message);
      return;
    }

    const runs = data.workflow_runs || [];

    // 制限バナーの非表示化
    if (isRateLimited) {
      isRateLimited = false;
      rateLimitBanner.style.display = 'none';
      clearInterval(statusTimer);
      statusTimer = setInterval(loadStatus, normalInterval);
    }
    // 2. 保存済みセッション履歴 (Sessions.json)
    const resSessions = await fetch('sessions.json?t=' + Date.now());
    let savedSessions = [];
    if (resSessions.ok) {
      try {
        savedSessions = await resSessions.json();
        if (!Array.isArray(savedSessions)) savedSessions = [];
      } catch (e) {
        console.warn('sessions.json のパースに失敗しました:', e);
        savedSessions = [];
      }
    }

    activeList.innerHTML = '';
    historyList.innerHTML = '';

    // 進行中の Action を表示
    // - status が in_progress / queued / pending の全ジョブを候補に
    // - ワークフローファイル名 (path) に record が含まれ、monitor は除外
    // - 上記が取れない場合は名前の部分一致でフォールバック
    const activeRuns = runs.filter(r => {
      const status = r.status;
      const isActive = status === 'in_progress' || status === 'queued' || status === 'pending';
      if (!isActive) return false;

      // monitor ワークフローは除外
      const path = (r.path || '').toLowerCase();
      const name = (r.name || '').toLowerCase();
      const displayTitle = (r.display_title || '').toLowerCase();

      if (path.includes('monitor') || name.includes('monitor') || name.includes('監視')) return false;

      // record.yml に関連するジョブを検出（複数の判定方法を OR で組み合わせる）
      return (
        path.includes('record') ||
        name.includes('録画') ||
        name.includes('record') ||
        displayTitle.includes('録画中')
      );
    });

    activeRuns.forEach(run => {
      const runName = run.display_title || run.name || '';
      
      // 文字列から11文字のIDらしき部分を抽出
      const videoIdMatch = runName.match(/[a-zA-Z0-9_-]{11}/);
      const displayVideoId = videoIdMatch ? videoIdMatch[0] : '実行中...';
      
      // 文字列からタイトル部分を抽出 (例: "🎙️ 録画中: タイトル — チャンネル名")
      let extractedTitle = undefined;
      const titleSplit = runName.split(' — ');
      if (titleSplit.length > 0) {
        extractedTitle = titleSplit[0].replace('🎙️ 録画中: ', '').replace('🎙️ 録画中:', '').trim();
      }

      activeList.appendChild(createSessionElement({
        githubRunId: run.id,
        videoId: displayVideoId,
        title: extractedTitle || runName,
        startedAt: run.created_at
      }, 'recording'));
    });

    if (activeRuns.length === 0) {
      activeList.innerHTML = '<li class="empty-msg">現在実行中の監視/録画はありません</li>';
    }

    // 保存済み履歴（③ status に応じて表示を切り替え）
    savedSessions.forEach(session => {
      const state = session.status === 'error' ? 'error' : 'finished';
      historyList.appendChild(createSessionElement(session, state));
    });

    if (savedSessions.length === 0) {
      historyList.innerHTML = '<li class="empty-msg">過去の記録レポートはありません</li>';
    }

    // UIの描画完了後に、ID表示のままになっている録画の動画タイトルを非同期取得する
    resolveTitles();

    // ✅ sessions.json のパース保護: 開くことはできたが中身が壊れた欲しないJSONの場合
  } catch (err) {
    console.error('Failed to load status:', err);
    // エラー時に画面が「読み込み中...」のまま固まるバグを修正
    if (activeList.innerHTML.includes('読み込み中')) {
      activeList.innerHTML = '<li class="empty-msg">状態の取得に失敗しました。後ほど再読み込みします。</li>';
    }
    if (historyList.innerHTML.includes('読み込み中')) {
      historyList.innerHTML = '<li class="empty-msg">履歴の取得に失敗しました。</li>';
    }
  }
}

async function startRecording(e) {
  e.preventDefault();
  let input = videoIdInput.value.trim();
  if (!input) return;

  // YouTube の URL から Video ID (11文字) を抽出する
  const regex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/;
  const match = input.match(regex);
  const videoId = match ? match[1] : (input.length === 11 ? input : null);

  if (!videoId) {
    showToast('有効な YouTube URL または Video ID を入力してください', 'error');
    return;
  }

  if (!GAS_PROXY_URL.startsWith('http')) {
      showToast('GAS の URL が設定されていません。管理者に連絡してください。', 'error');
      return;
  }

  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = '<div class="loader"></div> リクエスト中...';
  submitBtn.disabled = true;

  try {
    const res = await fetch(GAS_PROXY_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoId, action: 'record' })
    });

    showToast(`録画リクエストを送信しました: ${videoId}`);
    
  } catch (err) {
    showToast(`送信エラー: ${err.message}`, 'error');
  } finally {
    videoIdInput.value = '';
    submitBtn.innerHTML = originalText;
    submitBtn.disabled = false;
    setTimeout(loadStatus, 3000);
  }
}

async function stopActionsRun(runId) {
  // runId のバリデーション（数値のみ許可）
  if (!runId || !/^\d+$/.test(String(runId))) {
    showToast('無効なタスクIDです', 'error');
    return;
  }
  if (!confirm(`録画中のタスク(ID: ${runId})を停止しますか？`)) return;
  
  if (!GAS_PROXY_URL.startsWith('http')) {
    showToast('停止コマンドを送れません(URL未設定)', 'error');
    return;
  }

  try {
    await fetch(GAS_PROXY_URL, {
      method: 'POST',
      mode: 'no-cors',
      body: JSON.stringify({ runId: runId, action: 'stop' })
    });
    showToast(`停止要求を送信しました`);
    setTimeout(loadStatus, 3000);
  } catch (e) {
    showToast('通信エラー', 'error');
  }
}

// ---------------------------
// ④ チャンネル管理
// ---------------------------

async function loadChannels() {
  try {
    const res = await fetch(`https://raw.githubusercontent.com/${GITHUB_REPO}/main/channels.json?t=${Date.now()}`);
    if (!res.ok) {
      channelList.innerHTML = '<li class="empty-msg">チャンネル情報を取得できませんでした</li>';
      return;
    }
    const channels = await res.json();
    channelList.innerHTML = '';

    if (channels.length === 0) {
      channelList.innerHTML = '<li class="empty-msg">登録チャンネルはありません</li>';
      return;
    }

    channels.forEach((ch, i) => {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.innerHTML = `
        <div class="session-info">
          <div class="session-id">
            <i class="fab fa-youtube" style="color:#ff0000;"></i> ${escapeHTML(ch.name)}
            <span class="badge cloud" title="Channel ID" style="font-size:0.7rem;">${escapeHTML(ch.id).substring(0, 10)}...</span>
          </div>
          <div class="session-meta">
            <span><i class="fas fa-satellite-dish"></i> 10分間隔で自動巡回中</span>
          </div>
        </div>
        <div class="session-action">
          <button class="btn-danger" onclick="removeChannel('${escapeHTML(ch.id)}')" style="font-size:0.8rem; padding:6px 10px;">
            <i class="fas fa-trash"></i> 削除
          </button>
        </div>
      `;
      channelList.appendChild(li);
    });
  } catch (err) {
    console.error('Failed to load channels:', err);
    channelList.innerHTML = '<li class="empty-msg">チャンネル情報の取得に失敗しました</li>';
  }
}

async function addChannel(e) {
  e.preventDefault();
  const input = channelUrlInput.value.trim();
  if (!input) return;

  if (!GAS_PROXY_URL.startsWith('http')) {
    showToast('GAS の URL が設定されていません', 'error');
    return;
  }

  // チャンネル URL から ID or ハンドル名を抽出
  let channelIdentifier = input;
  
  // @handle 形式の場合
  const handleMatch = input.match(/youtube\.com\/@([^\/\s?]+)/);
  if (handleMatch) {
    channelIdentifier = '@' + handleMatch[1];
  }
  
  // /channel/UCXXXX 形式
  const channelIdMatch = input.match(/youtube\.com\/channel\/(UC[a-zA-Z0-9_-]+)/);
  if (channelIdMatch) {
    channelIdentifier = channelIdMatch[1];
  }

  const addBtn = document.getElementById('addChannelBtn');
  const originalText = addBtn.innerHTML;
  addBtn.innerHTML = '<div class="loader"></div> 追加中...';
  addBtn.disabled = true;

  try {
    await fetch(GAS_PROXY_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'update_channels', 
        operation: 'add',
        channelIdentifier: channelIdentifier
      })
    });
    showToast(`チャンネル追加リクエストを送信しました`);
    channelUrlInput.value = '';
    setTimeout(loadChannels, 3000);
  } catch (err) {
    showToast(`送信エラー: ${err.message}`, 'error');
  } finally {
    addBtn.innerHTML = originalText;
    addBtn.disabled = false;
  }
}

async function removeChannel(channelId) {
  // channelId のバリデーション
  if (!channelId || typeof channelId !== 'string') {
    showToast('無効なチャンネルIDです', 'error');
    return;
  }
  if (!confirm('このチャンネルを監視リストから削除しますか？')) return;

  try {
    await fetch(GAS_PROXY_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        action: 'update_channels', 
        operation: 'remove',
        channelId: channelId
      })
    });
    showToast(`チャンネル削除リクエストを送信しました`);
    setTimeout(loadChannels, 3000);
  } catch (err) {
    showToast(`送信エラー: ${err.message}`, 'error');
  }
}

// ---------------------------
// イベント登録
// ---------------------------
form.addEventListener('submit', startRecording);
addChannelForm.addEventListener('submit', addChannel);
loadStatus();
loadChannels();
statusTimer = setInterval(loadStatus, normalInterval); // 60秒おきに自動更新
