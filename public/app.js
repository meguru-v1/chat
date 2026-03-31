console.log('🚀 Smart-Archiver v2.0 (Pure Actions Mode)');

// ---------------------------
// DOM Elements
// ---------------------------
const form = document.getElementById('recordForm');
const videoIdInput = document.getElementById('videoIdInput');
const submitBtn = document.getElementById('submitBtn');
const activeList = document.getElementById('activeSessionsList');
const historyList = document.getElementById('historySessionsList');
const toast = document.getElementById('toast');
const connectionStatus = document.getElementById('connectionStatus');

// 設定関連 (Footer)
const btnSaveConfig = document.getElementById('btnSaveConfig');
const ghRepoInput = document.getElementById('ghRepo');
const ghTokenInput = document.getElementById('ghToken');

// ---------------------------
// 状態管理 (GitHub 連携のみ)
// ---------------------------
let githubRepo = localStorage.getItem('ghRepo') || '';
let githubToken = localStorage.getItem('ghToken') || '';

// 初期表示用
ghRepoInput.value = githubRepo;
ghTokenInput.value = githubToken;

function updateConnectionStatus() {
  if (githubRepo && githubToken) {
    connectionStatus.innerHTML = `<span style="color:var(--primary-color)"><i class="fas fa-check-circle"></i> 連携中: ${githubRepo}</span>`;
  } else {
    connectionStatus.innerHTML = `<span style="color:var(--danger-color)"><i class="fas fa-exclamation-triangle"></i> 設定未完了</span>`;
  }
}

updateConnectionStatus();

// 設定保存
btnSaveConfig.addEventListener('click', () => {
  githubRepo = ghRepoInput.value.trim();
  githubToken = ghTokenInput.value.trim();
  
  if (githubRepo && githubToken) {
    localStorage.setItem('ghRepo', githubRepo);
    localStorage.setItem('ghToken', githubToken);
    showToast('GitHub 連携設定を保存しました');
  } else {
    localStorage.removeItem('ghRepo');
    localStorage.removeItem('ghToken');
    showToast('設定をクリアしました', 'error');
  }
  
  updateConnectionStatus();
  loadStatus();
});

// ---------------------------
// Utils
// ---------------------------
function showToast(message, type = 'success') {
  toast.className = `show ${type}`;
  toast.innerHTML = `<i class="fas fa-${type === 'success' ? 'check-circle' : 'exclamation-circle'}"></i> ${message}`;
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

/** Actions の実行履歴から要素を構築 */
/** セッション要素の構築 (Action実行中 & 保存済み履歴の両方に対応) */
function createSessionElement(session, displayState) {
  const li = document.createElement('li');
  li.className = 'session-item';

  const cloudBadge = `<span class="badge cloud" title="GitHub Actions"><i class="fas fa-cloud"></i> ACTIONS</span> `;
  let badgeHtml = '';
  let metaHtml = '';
  let actionHtml = '';

  if (displayState === 'recording') {
    badgeHtml = `${cloudBadge}<div class="badge recording"><i class="fas fa-circle"></i> EXECUTING</div>`;
    metaHtml = `
      <span title="開始時刻"><i class="far fa-clock"></i> ${formatDate(session.startedAt)}</span>
    `;
    actionHtml = `
      <button class="btn-danger" onclick="stopActionsRun('${session.githubRunId}')" title="GitHub Actionsを停止">
        <i class="fas fa-stop"></i> 停止
      </button>
    `;
  } else {
    badgeHtml = `${cloudBadge}<div class="badge success"><i class="fas fa-check-circle"></i> FINISHED</div>`;
    metaHtml = `
      <span><i class="fab fa-youtube"></i> ${session.videoId}</span>
      <span><i class="far fa-calendar-alt"></i> ${formatDate(session.date)}</span>
      <span><i class="far fa-comments"></i> ${session.messageCount}件</span>
    `;
    actionHtml = `
      <a href="${session.pdfPath}" target="_blank" class="btn-primary" style="text-decoration:none; display:inline-block; padding:8px 12px; border-radius:6px; font-size:13px">
        <i class="fas fa-file-pdf"></i> レポート表示
      </a>
    `;
  }

  li.innerHTML = `
    <div class="session-info">
      <div class="session-id">
        ${session.videoId === '実行中...' ? '監視中/録画中' : (session.title || session.videoId)} 
        ${badgeHtml}
      </div>
      <div class="session-meta">
        ${metaHtml}
      </div>
    </div>
    <div class="session-action">
      ${actionHtml}
    </div>
  `;
  return li;
}

// ---------------------------
// GitHub API 通信
// ---------------------------
const githubApiHeaders = () => ({
  'Authorization': `token ${githubToken}`,
  'Accept': 'application/vnd.github.v3+json'
});

async function loadStatus() {
  if (!githubRepo || !githubToken) {
    activeList.innerHTML = '<div class="empty-state">GitHub 連携設定が必要です (画面下部)</div>';
    historyList.innerHTML = '<div class="empty-state">設定を完了すると Actions の履歴が表示されます</div>';
    return;
  }

  try {
    // 1. GitHub Actions の実行状況を取得
    const url = `https://api.github.com/repos/${githubRepo}/actions/runs?per_page=10`;
    const res = await fetch(url, { headers: githubApiHeaders() });
    const data = await res.json();
    const runs = data.workflow_runs || [];

    // 2. 保存済みセッション履歴 (Sessions.json) を取得
    // 相対パスでリポジトリ上のファイルにアクセス
    const resSessions = await fetch('sessions.json?t=' + Date.now());
    let savedSessions = [];
    if (resSessions.ok) {
      savedSessions = await resSessions.json();
    }

    activeList.innerHTML = '';
    historyList.innerHTML = '';

    // 進行中の Action を表示
    const activeRuns = runs.filter(r => r.status === 'in_progress' || r.status === 'queued');
    activeRuns.forEach(run => {
      activeList.appendChild(createSessionElement({
        githubRunId: run.id,
        videoId: '実行中...',
        startedAt: run.created_at
      }, 'recording'));
    });

    if (activeRuns.length === 0) {
      activeList.innerHTML = '<li class="empty-msg">現在実行中の自動監視/録画はありません</li>';
    }

    // 保存済み履歴を表示
    savedSessions.forEach(session => {
      historyList.appendChild(createSessionElement(session, 'finished'));
    });

    if (savedSessions.length === 0) {
      historyList.innerHTML = '<li class="empty-msg">過去の記録レポートはありません</li>';
    }

  } catch (err) {
    console.error('Failed to load status:', err);
    activeList.innerHTML = `<div class="empty-state" style="color:var(--danger-color)">ステータス取得エラー: ${err.message}</div>`;
  }
}

async function startRecording(e) {
  e.preventDefault();
  const videoId = videoIdInput.value.trim();
  if (!videoId) return;

  if (!githubRepo || !githubToken) {
    showToast('先に GitHub 連携設定を完了してください', 'error');
    return;
  }

  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = '<div class="loader"></div> 通信中...';
  submitBtn.disabled = true;

  try {
    // リポジトリ情報を取得してデフォルトブランチを特定
    const repoRes = await fetch(`https://api.github.com/repos/${githubRepo}`, { headers: githubApiHeaders() });
    if (!repoRes.ok) throw new Error('リポジトリにアクセスできません');
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || 'main';

    // 録画命令（workflow_dispatch）を送信
    const res = await fetch(`https://api.github.com/repos/${githubRepo}/actions/workflows/record.yml/dispatches`, {
      method: 'POST',
      headers: githubApiHeaders(),
      body: JSON.stringify({
        ref: defaultBranch,
        inputs: { video_id: videoId }
      })
    });

    if (res.ok || res.status === 204) {
      showToast(`GitHub Actions サーバーを起動しました: ${videoId}`);
    } else {
      throw new Error(`起動失敗: ${res.status}`);
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    videoIdInput.value = '';
    submitBtn.innerHTML = originalText;
    submitBtn.disabled = false;
    setTimeout(loadStatus, 2000);
  }
}

// アーティファクトダウンロード機能は PDF 直リンクに置き換えたため削除

async function stopActionsRun(runId) {
  if (!confirm(`このアクション(ID: ${runId})を停止しますか？`)) return;
  try {
    const res = await fetch(`https://api.github.com/repos/${githubRepo}/actions/runs/${runId}/cancel`, { 
      method: 'POST', 
      headers: githubApiHeaders() 
    });
    if (res.ok || res.status === 202) {
      showToast(`停止要求を送信しました`);
      setTimeout(loadStatus, 2000);
    } else {
      showToast('停止に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー', 'error');
  }
}

// ---------------------------
// イベント登録
// ---------------------------
form.addEventListener('submit', startRecording);
loadStatus();
// 15秒おきに自動更新
setInterval(loadStatus, 15000);
