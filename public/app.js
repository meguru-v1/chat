console.log('🚀 Smart-Archiver v1.2 Initialized');
let API_BASE = '/api';

// GitHub Pages等のリモート環境からローカルサーバーに接続するための設定（ローカルモードの場合）
if (window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
  API_BASE = 'http://localhost:3000/api';
}

// ---------------------------
// DOM Elements
// ---------------------------
const form = document.getElementById('recordForm');
const videoIdInput = document.getElementById('videoIdInput');
const submitBtn = document.getElementById('submitBtn');
const activeList = document.getElementById('activeSessionsList');
const historyList = document.getElementById('historySessionsList');
const toast = document.getElementById('toast');

// クラウド設定関連
const btnOpenCloudConfig = document.getElementById('btnOpenCloudConfig');
const cloudConfigModal = document.getElementById('cloudConfigModal');
const btnCancelConfig = document.getElementById('btnCancelConfig');
const btnSaveConfig = document.getElementById('btnSaveConfig');
const ghRepoInput = document.getElementById('ghRepo');
const ghTokenInput = document.getElementById('ghToken');

// ---------------------------
// クラウドモードの状態管理
// ---------------------------
let isCloudMode = false;
let githubRepo = localStorage.getItem('ghRepo') || '';
let githubToken = localStorage.getItem('ghToken') || '';

function checkCloudMode() {
  if (githubRepo && githubToken) {
    isCloudMode = true;
    btnOpenCloudConfig.innerHTML = '<i class="fas fa-cloud" style="color:var(--primary-color)"></i> クラウドモード (ON)';
    btnOpenCloudConfig.style.borderColor = 'var(--primary-color)';
  } else {
    isCloudMode = false;
    btnOpenCloudConfig.innerHTML = '<i class="fas fa-cloud"></i> クラウド設定';
    btnOpenCloudConfig.style.borderColor = '';
  }
}

// 初期判定
checkCloudMode();

// 設定モーダルの開閉
btnOpenCloudConfig.addEventListener('click', () => {
  ghRepoInput.value = githubRepo;
  ghTokenInput.value = githubToken;
  cloudConfigModal.style.display = 'block';
});
btnCancelConfig.addEventListener('click', () => {
  cloudConfigModal.style.display = 'none';
});
btnSaveConfig.addEventListener('click', () => {
  githubRepo = ghRepoInput.value.trim();
  githubToken = ghTokenInput.value.trim();
  
  if (githubRepo && githubToken) {
    localStorage.setItem('ghRepo', githubRepo);
    localStorage.setItem('ghToken', githubToken);
    showToast('クラウドモードを有効化しました');
  } else {
    localStorage.removeItem('ghRepo');
    localStorage.removeItem('ghToken');
    showToast('ローカルモードに戻りました');
  }
  
  cloudConfigModal.style.display = 'none';
  checkCloudMode();
  loadStatus(); // 新しいモードで更新
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

/** セッションリストの要素を構築する */
function createSessionElement(session, displayState) {
  const li = document.createElement('li');
  li.className = 'session-item';

  let badgeHtml = '';
  let metaHtml = '';
  let actionHtml = '';

  // 表示モード (local vs cloud)
  const isCloud = !!session.githubRunId;
  const cloudBadge = isCloud ? `<span class="badge cloud" title="クラウド環境で実行中"><i class="fas fa-cloud"></i> CLOUD</span> ` : '';

  if (displayState === 'recording') {
    badgeHtml = `${cloudBadge}<div class="badge recording"><i class="fas fa-circle"></i> RECORDING</div>`;
    metaHtml = `
      <span title="開始時刻"><i class="far fa-clock"></i> ${formatDate(session.startedAt || session.startTime)}</span>
      <span title="ステータス"><i class="fas fa-bolt"></i> アクティブ</span>
    `;
    actionHtml = isCloud ? `
      <button class="btn-danger" onclick="stopCloudRecording('${session.githubRunId}')" title="GitHub Actionsを強制終了">
        <i class="fas fa-stop"></i> 停止
      </button>
    ` : `
      <button class="btn-danger" onclick="stopRecording('${session.videoId}')">
        <i class="fas fa-stop"></i> 停止
      </button>
    `;
  } else if (displayState === 'error') {
    badgeHtml = `${cloudBadge}<div class="badge error"><i class="fas fa-exclamation-triangle"></i> ERROR</div>`;
    metaHtml = `
      <span title="エラー原因" style="color:var(--danger-color)"><i class="fas fa-times-circle"></i> 録画失敗</span>
    `;
    actionHtml = isCloud ? `
      <button class="btn-secondary" style="font-size:0.8rem; padding: 0.5rem;" onclick="window.open('${session.htmlUrl}', '_blank')">
        <i class="fab fa-github"></i> ログ確認
      </button>
    ` : ``;
  } else {
    // completed
    badgeHtml = `${cloudBadge}<div class="badge completed"><i class="fas fa-check"></i> COMPLETED</div>`;
    metaHtml = `
      <span title="終了時刻"><i class="far fa-clock"></i> ${formatDate(session.finishedAt)}</span>
    `;
    
    if (isCloud) {
       actionHtml = `
        <button class="btn-download" onclick="downloadCloudArtifact('${session.githubRunId}', this)" title="1日限定・ZIPダウンロード">
          <i class="fas fa-file-pdf"></i> PDF(ZIP)をダウンロード
        </button>
      `;
    } else {
      actionHtml = `
        <button class="btn-download" onclick="window.open('${API_BASE}/sessions/${session.sessionId}/pdf', '_blank')">
          <i class="fas fa-file-pdf"></i> PDFをDL
        </button>
      `;
    }
  }

  // HTMLの組み立て
  // ※ ${...}のネストが壊れないように分割して組み立てます
  const infoHtml = `
    <div class="session-info">
      <div class="session-id">
        ${session.videoId || session.sessionId || session.name || '不明'} 
        ${badgeHtml}
      </div>
      <div class="session-meta">
        ${metaHtml}
      </div>
    </div>
  `;
  const btnHtml = `
    <div class="session-action">
      ${actionHtml}
    </div>
  `;

  li.innerHTML = infoHtml + btnHtml;
  return li;
}

// ---------------------------
// ローカルモード用 API Call
// ---------------------------
async function loadLocalStatus() {
  try {
    const actRes = await fetch(`${API_BASE}/record/status`);
    const actData = await actRes.json();
    
    activeList.innerHTML = '';
    let hasActive = false;

    if (actData.sessions && actData.sessions.length > 0) {
      actData.sessions.forEach(s => {
        if (s.status === 'recording' || s.status === 'stopping') {
          activeList.appendChild(createSessionElement(s, s.status));
          hasActive = true;
        } else if (s.status === 'finished' && (s.messageCount === 0 || s.finishReason === 'process_error')) {
          activeList.appendChild(createSessionElement(s, 'error'));
          hasActive = true;
        }
      });
    }

    if (!hasActive) {
      activeList.innerHTML = '<div class="empty-state">現在アクティブなセッションはありません</div>';
    }

    const histRes = await fetch(`${API_BASE}/sessions`);
    const histData = await histRes.json();

    if (histData.sessions && histData.sessions.length > 0) {
      historyList.innerHTML = '';
      histData.sessions.forEach(s => {
        historyList.appendChild(createSessionElement(s, 'completed'));
      });
    } else {
      historyList.innerHTML = '<div class="empty-state">保存されたセッションはありません</div>';
    }
  } catch (err) {
    if (!isCloudMode) activeList.innerHTML = '<div class="empty-state" style="color:var(--danger-color)"><i class="fas fa-unlink"></i> ローカルサーバーに接続できません (ターミナルが起動していない可能性があります)</div>';
  }
}

async function startLocalRecording(videoId) {
  const res = await fetch(`${API_BASE}/record/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId })
  });
  const data = await res.json();
  if (res.ok) {
    showToast(`録画を開始しました: ${videoId}`);
  } else {
    showToast(data.error || 'エラーが発生しました', 'error');
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
      setTimeout(loadStatus, 1500);
    } else {
      showToast(data.error || '停止に失敗しました', 'error');
    }
  } catch (err) {
    showToast('通信エラーが発生しました', 'error');
  }
}

// ---------------------------
// クラウドモード用 API Call (GitHub API)
// ---------------------------
const githubApiHeaders = () => ({
  'Authorization': `token ${githubToken}`,
  'Accept': 'application/vnd.github.v3+json'
});

async function loadCloudStatus() {
  try {
    const url = `https://api.github.com/repos/${githubRepo}/actions/runs?per_page=15`;
    const res = await fetch(url, { headers: githubApiHeaders() });
    if (!res.ok) {
      if (res.status === 401) throw new Error('トークンが無効です');
      if (res.status === 404) throw new Error('リポジトリが見つかりません');
      throw new Error('API取得エラー');
    }
    const data = await res.json();
    
    // アプリの録画に関するワークフローだけを抽出
    const recordRuns = data.workflow_runs.filter(w => w.name.includes('📺 YouTube チャット録画'));

    activeList.innerHTML = '';
    historyList.innerHTML = '';
    let hasActive = false;
    let hasHistory = false;

    recordRuns.forEach(run => {
      // sessionぽい形式に適当にマッピングする
      const s = {
        githubRunId: run.id,
        // display_title (run-name) があればそれを使い、なければ run_number を動画IDとして表示
        videoId: run.display_title || (run.name + ` (#${run.run_number})`), 
        status: run.status,
        startedAt: run.created_at,
        finishedAt: run.updated_at,
        htmlUrl: run.html_url
      };

      if (run.status === 'in_progress' || run.status === 'queued') {
        activeList.appendChild(createSessionElement(s, 'recording'));
        hasActive = true;
      } else {
        // completed
        if (run.conclusion === 'success') {
          historyList.appendChild(createSessionElement(s, 'completed'));
        } else {
          // failure or cancelled
          activeList.appendChild(createSessionElement(s, 'error'));
          hasActive = true;
        }
        hasHistory = true;
      }
    });

    if (!hasActive) activeList.innerHTML = '<div class="empty-state">現在アクティブなクラウドセッションはありません</div>';
    if (!hasHistory) historyList.innerHTML = '<div class="empty-state">保存されたクラウドセッションはありません</div>';

  } catch (err) {
    activeList.innerHTML = `<div class="empty-state" style="color:var(--danger-color)"><i class="fas fa-exclamation-triangle"></i> クラウド通信エラー: ${err.message}</div>`;
  }
}

async function startCloudRecording(videoId) {
  try {
    // 1. リポジトリ名の形式チェック
    if (!githubRepo.includes('/')) {
      throw new Error('リポジトリ名は "ユーザー名/リポジトリ名" の形式で入力してください');
    }

    showToast('クラウド情報を確認中...', 'success');

    // 2. リポジトリ情報を取得してデフォルトブランチを特定
    const repoUrl = `https://api.github.com/repos/${githubRepo}`;
    const repoRes = await fetch(repoUrl, { headers: githubApiHeaders() });
    
    if (!repoRes.ok) {
      if (repoRes.status === 404) throw new Error('リポジトリが見つかりません。名前を確認してください。');
      if (repoRes.status === 401) throw new Error('トークンが無効です。GitHub設定を確認してください。');
      throw new Error('リポジトリ情報の取得に失敗しました');
    }
    
    const repoData = await repoRes.json();
    const defaultBranch = repoData.default_branch || 'main';

    // 3. 録画命令（workflow_dispatch）を送信
    const dispatchUrl = `https://api.github.com/repos/${githubRepo}/actions/workflows/record.yml/dispatches`;
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      headers: githubApiHeaders(),
      body: JSON.stringify({
        ref: defaultBranch,
        inputs: { video_id: videoId }
      })
    });

    if (res.ok || res.status === 204) {
      showToast(`クラウド上で ${videoId} の録画命令を送信しました (${defaultBranch})`);
    } else {
      const d = await res.json().catch(()=>({}));
      // GitHubからの詳細なメッセージを表示（例: "Workflow does not have 'workflow_dispatch' trigger" 等）
      const errorMsg = d.message || `エラー: ${res.status}`;
      throw new Error(`GitHubからの拒否: ${errorMsg}`);
    }
  } catch (err) {
    showToast(err.message, 'error');
    console.error('Cloud Start Error:', err);
  }
}

async function downloadCloudArtifact(runId, btn) {
  const originalText = btn.innerHTML;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 準備中...';
  btn.disabled = true;

  try {
    // 1. その実行(Run)に紐づく成果物一覧を取得
    const listUrl = `https://api.github.com/repos/${githubRepo}/actions/runs/${runId}/artifacts`;
    const listRes = await fetch(listUrl, { headers: githubApiHeaders() });
    const listData = await listRes.json();

    if (!listData.artifacts || listData.artifacts.length === 0) {
      throw new Error('PDFがまだ生成されていないか、1日の保存期限を過ぎています。');
    }

    // 2. 最初の成果物をダウンロードするためのURL(ZIP)を取得
    const artifactId = listData.artifacts[0].id;
    const downloadUrl = `https://api.github.com/repos/${githubRepo}/actions/artifacts/${artifactId}/zip`;
    
    // APIはリダイレクトを返すが、ブラウザの window.open では Authorization ヘッダーを送れないため、
    // 一度 fetch でリダイレクト先の「署名付きS3 URL」を取得してから、そこにジャンプする。
    const res = await fetch(downloadUrl, { 
      headers: githubApiHeaders(),
      redirect: 'follow' // 自動でリダイレクト先を追跡
    });

    if (res.ok) {
      // res.url が Amazon S3 等の署名付き直リンクになっている
      window.location.href = res.url;
      showToast('ダウンロードを開始しました(ZIP形式)');
    } else {
      throw new Error('URLの取得に失敗しました。');
    }
  } catch (err) {
    console.error('Download Error:', err);
    showToast(err.message, 'error');
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

async function stopCloudRecording(runId) {
  if (!confirm(`クラウド上の録画プロセス(ID: ${runId})を強制終了しますか？`)) return;
  const url = `https://api.github.com/repos/${githubRepo}/actions/runs/${runId}/cancel`;
  
  try {
    const res = await fetch(url, { method: 'POST', headers: githubApiHeaders() });
    if (res.ok || res.status === 202) {
      showToast(`クラウドプロセスの強制終了を要求しました`);
      setTimeout(loadStatus, 2000);
    } else {
      showToast('停止に失敗しました', 'error');
    }
  } catch (e) {
    showToast('通信エラー', 'error');
  }
}

// ---------------------------
// ユニバーサル (Main)
// ---------------------------
async function loadStatus() {
  if (isCloudMode) {
    await loadCloudStatus();
  } else {
    await loadLocalStatus();
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
    if (isCloudMode) {
      await startCloudRecording(videoId);
    } else {
      await startLocalRecording(videoId);
    }
  } finally {
    videoIdInput.value = '';
    submitBtn.innerHTML = originalText;
    submitBtn.disabled = false;
    setTimeout(loadStatus, 1500); // 処理が開始されるまで少し待つ
  }
}

// 初期セパレーター
form.addEventListener('submit', startRecording);
loadStatus();
// 10秒おきにステータスを自動更新 (ActionsのAPIリミットを考慮して10秒に延長)
setInterval(loadStatus, 10000);
