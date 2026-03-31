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
function createSessionElement(session, displayState) {
  const li = document.createElement('li');
  li.className = 'session-item';

  let badgeHtml = '';
  let metaHtml = '';
  let actionHtml = '';

  const cloudBadge = `<span class="badge cloud" title="GitHub Actions"><i class="fas fa-cloud"></i> ACTIONS</span> `;

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
  } else if (displayState === 'error') {
    badgeHtml = `${cloudBadge}<div class="badge error"><i class="fas fa-exclamation-triangle"></i> FAILED</div>`;
    metaHtml = `
      <span style="color:var(--danger-color)"><i class="fas fa-times-circle"></i> 実行失敗</span>
    `;
    actionHtml = `
      <button class="btn-secondary" style="font-size:0.8rem; padding: 0.5rem;" onclick="window.open('${session.htmlUrl}', '_blank')">
        <i class="fab fa-github"></i> ログ
      </button>
    `;
  } else {
    badgeHtml = `${cloudBadge}<div class="badge completed"><i class="fas fa-check"></i> SUCCESS</div>`;
    metaHtml = `
      <span title="終了時刻"><i class="far fa-clock"></i> ${formatDate(session.finishedAt)}</span>
    `;
    actionHtml = `
      <button class="btn-download" onclick="downloadArtifact('${session.githubRunId}', this)" title="PDF(ZIP)ダウンロード">
        <i class="fas fa-file-pdf"></i> レポート(ZIP)
      </button>
    `;
  }

  li.innerHTML = `
    <div class="session-info">
      <div class="session-id">
        ${session.videoId || '不明なセッション'} 
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
    const url = `https://api.github.com/repos/${githubRepo}/actions/runs?per_page=15`;
    const res = await fetch(url, { headers: githubApiHeaders() });
    
    if (!res.ok) throw new Error(`API取得失敗: ${res.status}`);
    const data = await res.json();
    
    // 録画に関連するワークフローを抽出
    const recordRuns = data.workflow_runs.filter(w => {
      return w.name && (w.name.includes('録画') || w.name.includes('YouTube') || w.path.includes('record.yml'));
    });

    activeList.innerHTML = '';
    historyList.innerHTML = '';
    let hasActive = false;
    let hasHistory = false;

    recordRuns.forEach(run => {
      const s = {
        githubRunId: run.id,
        videoId: run.display_title || `Session #${run.run_number}`, 
        status: run.status,
        startedAt: run.created_at,
        finishedAt: run.updated_at,
        htmlUrl: run.html_url
      };

      if (run.status === 'in_progress' || run.status === 'queued') {
        activeList.appendChild(createSessionElement(s, 'recording'));
        hasActive = true;
      } else {
        if (run.conclusion === 'success') {
          historyList.appendChild(createSessionElement(s, 'completed'));
        } else {
          activeList.appendChild(createSessionElement(s, 'error'));
          hasActive = true;
        }
        hasHistory = true;
      }
    });

    if (!hasActive) activeList.innerHTML = '<div class="empty-state">実行中のタスクはありません</div>';
    if (!hasHistory) historyList.innerHTML = '<div class="empty-state">完了した履歴はありません</div>';

  } catch (err) {
    activeList.innerHTML = `<div class="empty-state" style="color:var(--danger-color)"><i class="fas fa-exclamation-triangle"></i> 通信エラー: ${err.message}</div>`;
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

async function downloadArtifact(runId, btn) {
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 準備中...';
  btn.disabled = true;

  try {
    const listRes = await fetch(`https://api.github.com/repos/${githubRepo}/actions/runs/${runId}/artifacts`, { headers: githubApiHeaders() });
    const listData = await listRes.json();

    if (!listData.artifacts || listData.artifacts.length === 0) {
      throw new Error('レポートがまだ生成されていないか、期限を過ぎています');
    }

    const artifactId = listData.artifacts[0].id;
    const res = await fetch(`https://api.github.com/repos/${githubRepo}/actions/artifacts/${artifactId}/zip`, { 
      headers: githubApiHeaders(),
      redirect: 'follow'
    });

    if (res.ok) {
      window.location.href = res.url;
      showToast('ダウンロードを開始しました');
    } else {
      throw new Error('URL 取得失敗');
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

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
