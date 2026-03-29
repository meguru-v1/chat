let API_BASE = '/api';

// GitHub Pages等のリモート環境からローカルサーバーに接続するための設定
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  API_BASE = 'http://localhost:3000/api';
  console.log('GitHub Pages環境のため、APIサーバーを http://localhost:3000 に向けました');
}

// DOM Elements
const form = document.getElementById('recordForm');
const videoIdInput = document.getElementById('videoIdInput');
const submitBtn = document.getElementById('submitBtn');
const activeList = document.getElementById('activeSessionsList');
const historyList = document.getElementById('historySessionsList');
const toast = document.getElementById('toast');

// Utils
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

function createSessionElement(session, isActive) {
  const li = document.createElement('li');
  li.className = 'session-item';

  let badgeHtml = '';
  let metaHtml = '';
  let actionHtml = '';

  if (isActive) {
    badgeHtml = `<div class="badge recording"><i class="fas fa-circle"></i> RECORDING</div>`;
    metaHtml = `
      <span title="開始時刻"><i class="far fa-clock"></i> ${formatDate(session.startTime)}</span>
      <span title="取得コメント数"><i class="far fa-comment-dots"></i> ${session.messageCount || 0} msgs</span>
    `;
    actionHtml = `
      <button class="btn-danger" onclick="stopRecording('${session.videoId}')">
        <i class="fas fa-stop"></i> 停止
      </button>
    `;
  } else {
    badgeHtml = `<div class="badge completed"><i class="fas fa-check"></i> COMPLETED</div>`;
    metaHtml = `
      <span title="開始〜終了"><i class="far fa-calendar"></i> ${formatDate(session.firstMessage)}</span>
      <span title="総コメント数"><i class="far fa-comment-dots"></i> ${session.messageCount || 0} msgs</span>
    `;
    actionHtml = `
      <button class="btn-download" onclick="window.open('${API_BASE}/sessions/${session.sessionId}/pdf', '_blank')">
        <i class="fas fa-file-pdf"></i> PDFをDL
      </button>
    `;
  }

  li.innerHTML = `
    <div class="session-info">
      <div class="session-id">
        ${session.videoId || session.sessionId}
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

// API Calls
async function loadStatus() {
  try {
    // アクティブセッション
    const actRes = await fetch(`${API_BASE}/record/status`);
    const actData = await actRes.json();
    
    if (actData.sessions && actData.sessions.length > 0) {
      activeList.innerHTML = '';
      actData.sessions.filter(s => s.status === 'recording').forEach(s => {
        activeList.appendChild(createSessionElement(s, true));
      });
    } else {
      activeList.innerHTML = '<div class="empty-state">現在録画中のセッションはありません</div>';
    }

    // 履歴セッション
    const histRes = await fetch(`${API_BASE}/sessions`);
    const histData = await histRes.json();

    if (histData.sessions && histData.sessions.length > 0) {
      historyList.innerHTML = '';
      histData.sessions.forEach(s => {
        historyList.appendChild(createSessionElement(s, false));
      });
    } else {
      historyList.innerHTML = '<div class="empty-state">保存されたセッションはありません</div>';
    }

  } catch (err) {
    console.error('ステータスロード失敗:', err);
  }
}

async function startRecording(e) {
  e.preventDefault();
  const videoId = videoIdInput.value.trim();
  if (!videoId) return;

  const originalText = submitBtn.innerHTML;
  submitBtn.innerHTML = '<div class="loader"></div> 処理中...';
  submitBtn.disabled = true;

  try {
    const res = await fetch(`${API_BASE}/record/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      videoIdInput.value = '';
      showToast(`録画を開始しました: ${videoId}`);
      loadStatus();
    } else {
      showToast(data.error || 'エラーが発生しました', 'error');
    }
  } catch (err) {
    showToast('通信エラーが発生しました', 'error');
  } finally {
    submitBtn.innerHTML = originalText;
    submitBtn.disabled = false;
  }
}

async function stopRecording(videoId) {
  if (!confirm(`${videoId} の録画を停止しますか？`)) return;

  try {
    const res = await fetch(`${API_BASE}/record/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      showToast(`${videoId} の録画を停止しました`);
      setTimeout(loadStatus, 1500); // すぐに履歴に反映されないため少し待機
    } else {
      showToast(data.error || '停止に失敗しました', 'error');
    }
  } catch (err) {
    showToast('通信エラーが発生しました', 'error');
  }
}

// ---------------------------
// 初期化
// ---------------------------
form.addEventListener('submit', startRecording);

// 初回ロード
loadStatus();

// 5秒おきにステータスを自動更新
setInterval(loadStatus, 5000);
