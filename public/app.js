/**
 * Smart-Archiver v2.1 (GAS Proxy Mode)
 * トークン設定不要・セキュア中継方式
 */

// ==========================================
// 【重要】ここにデプロイした GAS の URL を貼ってください
// ==========================================
const GAS_PROXY_URL = 'https://script.google.com/macros/s/AKfycbyw6esXjC9lw6xQlBETaZTRBW8Yrw0A7M3wGecOFc4vpGEj4cn2IEPoMDaROqfCsxnGuQ/exec';

// 現在表示しているリポジトリ情報を自動取得 (フォーク対応)
const getRepoInfo = () => {
    const host = window.location.hostname;
    const path = window.location.pathname;
    
    // GitHub Pages の場合: username.github.io/reponame/
    if (host.includes('.github.io')) {
        const owner = host.split('.')[0];
        const repo = path.split('/')[1] || 'chat';
        return `${owner}/${repo}`;
    }
    // デフォルト（GAKUさんの環境）
    return 'meguru-v1/chat';
};

const GITHUB_REPO = getRepoInfo();

// ---------------------------
// DOM Elements
// ---------------------------
const form = document.getElementById('recordForm');
const videoIdInput = document.getElementById('videoIdInput');
const submitBtn = document.getElementById('submitBtn');
const activeList = document.getElementById('activeSessionsList');
const historyList = document.getElementById('historySessionsList');
const toast = document.getElementById('toast');

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

/** 履歴アイテムの構築 */
function createSessionElement(session, displayState) {
  const li = document.createElement('li');
  li.className = 'session-item';

  const cloudBadge = `<span class="badge cloud" title="GitHub Actions"><i class="fas fa-cloud"></i> ACTIONS</span> `;
  let badgeHtml = '';
  let metaHtml = '';
  let actionHtml = '';

  if (displayState === 'recording') {
    badgeHtml = `${cloudBadge}<div class="badge recording"><i class="fas fa-circle"></i> EXECUTING</div>`;
    metaHtml = `<span><i class="far fa-clock"></i> ${formatDate(session.startedAt)}</span>`;
    actionHtml = `<button class="btn-danger" onclick="stopActionsRun('${session.githubRunId}')"><i class="fas fa-stop"></i> 停止</button>`;
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
// GitHub API / GAS 通信
// ---------------------------

async function loadStatus() {
  try {
    // 1. GitHub Actions の実行状況を取得 (Publicリポジトリならトークン不要)
    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?per_page=10`;
    const res = await fetch(url);
    const data = await res.json();
    const runs = data.workflow_runs || [];

    // 2. 保存済みセッション履歴 (Sessions.json)
    const resSessions = await fetch('sessions.json?t=' + Date.now());
    let savedSessions = [];
    if (resSessions.ok) {
      savedSessions = await resSessions.json();
    }

    activeList.innerHTML = '';
    historyList.innerHTML = '';

    // 進行中の Action
    const activeRuns = runs.filter(r => r.status === 'in_progress' || r.status === 'queued');
    activeRuns.forEach(run => {
      activeList.appendChild(createSessionElement({
        githubRunId: run.id,
        videoId: '実行中...',
        startedAt: run.created_at
      }, 'recording'));
    });

    if (activeRuns.length === 0) {
      activeList.innerHTML = '<li class="empty-msg">現在実行中の監視/録画はありません</li>';
    }

    // 保存済み履歴
    savedSessions.forEach(session => {
      historyList.appendChild(createSessionElement(session, 'finished'));
    });

    if (savedSessions.length === 0) {
      historyList.innerHTML = '<li class="empty-msg">過去の記録レポートはありません</li>';
    }
  } catch (err) {
    console.error('Failed to load status:', err);
  }
}

async function startRecording(e) {
  e.preventDefault();
  const videoId = videoIdInput.value.trim();
  if (!videoId) return;

  if (!GAS_PROXY_URL.startsWith('http')) {
      showToast('GAS の URL が設定されていません。管理者に連絡してください。', 'error');
      return;
  }

  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = '<div class="loader"></div> リクエスト中...';
  submitBtn.disabled = true;

  try {
    // GAS プロキシ経由で GitHub Actions を起動
    const res = await fetch(GAS_PROXY_URL, {
      method: 'POST',
      mode: 'no-cors', // GAS の制約回避
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: videoId, action: 'record' })
    });

    // mode: 'no-cors' の場合 res.ok は判定できないが、送信自体は成功する
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
// イベント登録
// ---------------------------
form.addEventListener('submit', startRecording);
loadStatus();
setInterval(loadStatus, 20000); // 20秒おきに自動更新
