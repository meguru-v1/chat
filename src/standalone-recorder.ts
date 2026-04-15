/**
 * standalone-recorder.ts — チャット録画エンジン v3.1
 *
 * ✅ 安定性向上:
 *   - SIGTERM / SIGINT シグナルハンドラ: GitHub Actions の強制終了時も必ずPDFを生成
 *   - axios タイムアウト: 通信詰まりを10秒で強制終了
 *   - VIDEO_ID 環境変数 fallback: シェルインジェクション経路を削減
 *
 * ✅ セキュリティ:
 *   - video_id を正規表現でバリデーション (11文字英数字のみ)
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { generatePdf } from './pdfService';

// ---------- 設定 ----------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
/** チャット無更新が続いた場合のアイドルタイムアウト (120分) */
const IDLE_TIMEOUT_MS = 120 * 60 * 1000;
/** axios の通信タイムアウト (10秒) */
const AXIOS_TIMEOUT_MS = 10_000;

// ---------- 引数 / 環境変数 ----------
const args = process.argv.slice(2);
// --video-id=XXX 形式の引数、または環境変数 VIDEO_ID を優先して使用
const videoIdArg =
  args.find(a => a.startsWith('--video-id='))?.split('=')[1] ??
  process.env.VIDEO_ID ?? '';
const timeoutArg =
  args.find(a => a.startsWith('--timeout='))?.split('=')[1] ??
  process.env.TIMEOUT ?? '330';

// ✅ セキュリティ: video_id のバリデーション (YouTube ID は 11文字の英数字/-/_)
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;
if (!videoIdArg || !VIDEO_ID_REGEX.test(videoIdArg)) {
  console.error(`❌ 不正な --video-id: "${videoIdArg}" (11文字の英数字のみ許可)`);
  process.exit(1);
}

const videoId = videoIdArg;
const maxDurationMinutes = Math.min(Math.max(parseInt(timeoutArg, 10) || 330, 1), 330);
const maxWaitMs = maxDurationMinutes * 60 * 1000;

console.log(`📋 設定: video_id=${videoId}, timeout=${maxDurationMinutes}分`);

// ---------- 状態管理 ----------
let messages: any[] = [];
let isStopping = false;
let messageCount = 0;
let videoTitle = 'タイトル不明';
let pollTimeout: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let fatalRetryCount = 0;
const MAX_FATAL_RETRIES = 10;
const startTime = Date.now();

// ---------- ユーティリティ ----------

/** アイドルタイマーをリセット (新着メッセージがある場合に呼ぶ) */
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('⏰ チャット更新がないためタイムアウト停止');
    finish('idle_timeout');
  }, IDLE_TIMEOUT_MS);
}

/** ---------- 終了処理 ----------------------------------------
 * GitHub Actions に SIGTERM で強制終了される前に
 *必ず呼ばれるようシグナルハンドラ経由でも使用する。
 * 何があってもPDFと履歴を残す。
 * --------------------------------------------------- */
let finishCalled = false;
async function finish(reason: string) {
  if (finishCalled) return;
  finishCalled = true;

  if (pollTimeout) clearTimeout(pollTimeout);
  if (idleTimer) clearTimeout(idleTimer);

  console.log(`🏁 録画終了 (${reason}) - 合計 ${messages.length} 件`);

  if (messages.length > 0) {
    const safeTitle = videoTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
    const dateStr = new Date().toISOString().split('T')[0];
    const pdfFileName = `${safeTitle}_${dateStr}.pdf`;
    const pdfPath = `public/reports/${pdfFileName}`;
    const fullPdfPath = path.join(__dirname, '..', pdfPath);

    try {
      if (!fs.existsSync(path.dirname(fullPdfPath))) {
        fs.mkdirSync(path.dirname(fullPdfPath), { recursive: true });
      }
      console.log(`📄 PDF生成中 (${messages.length}件)...`);
      
      // ✅ SIGKILL対策: PDF生成前に先に履歴を書き込む（成功ステータスで仮登録）
      updateHistory(videoId, messages.length, pdfPath, videoTitle, 'completed');

      const pdfBuffer = await generatePdf(videoId, messages, videoTitle);
      fs.writeFileSync(fullPdfPath, pdfBuffer);
      console.log(`✅ レポート生成成功: ${pdfPath}`);
    } catch (err) {
      console.error('❌ PDF生成失敗:', err);
      // PDFが作れなかった場合、仮登録した成功エントリをエラーで上書き修正する
      updateHistory(videoId, messages.length, '', videoTitle, 'error', 'pdf_generation_failed');
    }
  } else {
    updateHistory(videoId, 0, '', videoTitle, 'error', reason);
    console.log('⚠️ メッセージ0件のため、エラーとして履歴に記録しました。');
  }

  if (process.env.GITHUB_ENV) {
    const durationMins = Math.floor((Date.now() - startTime) / 60000);
    fs.appendFileSync(process.env.GITHUB_ENV, `RECORD_MSG_COUNT=${messages.length}\n`);
    fs.appendFileSync(process.env.GITHUB_ENV, `RECORD_DURATION_MINS=${durationMins}\n`);
    fs.appendFileSync(process.env.GITHUB_ENV, `RECORD_REASON=${reason}\n`);
  }

  // シグナルハンドラから呼ばれた場合は非同期で終了できないので同期的に終了
  process.exit(0);
}

/** sessions.json を更新 */
function updateHistory(
  vId: string,
  count: number,
  p: string,
  title: string,
  status: 'completed' | 'error',
  reason?: string
) {
  const hPath = path.join(__dirname, '../public/sessions.json');
  let h: any[] = [];
  try {
    h = fs.existsSync(hPath) ? JSON.parse(fs.readFileSync(hPath, 'utf8')) : [];
  } catch (e: any) {
    console.warn('⚠️ sessions.json の読み込みに失敗。新規作成します:', e.message);
    h = [];
  }

  const normalizedPath = p ? p.replace(/^\/public\//, '').replace(/^public\//, '') : '';

  // ✅ パストラバーサル防止: パスが reports/ ディレクトリ内に収まるか確認
  if (normalizedPath) {
    const resolved = path.resolve(__dirname, '..', 'public', normalizedPath);
    const reportsDir = path.resolve(__dirname, '..', 'public', 'reports');
    if (!resolved.startsWith(reportsDir)) {
      console.error(`❌ 不正なpdfPath detected: "${normalizedPath}" — 履歴への書き込みを中止`);
      return;
    }
  }

  const newEntry: any = {
    videoId: vId,
    title,
    date: new Date().toISOString(),
    messageCount: count,
    pdfPath: normalizedPath,
    status,
  };
  // エラー理由をUI表示用に記録
  if (reason) newEntry.reason = reason;

  if (normalizedPath) {
    h = [newEntry, ...h.filter((s: any) => s.pdfPath !== normalizedPath)];
  } else {
    h = [newEntry, ...h];
  }

  // ===== PDFの自動クリーンアップ（2週間または50件超過） =====
  const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
  const now = Date.now();
  const keptHistory: any[] = [];

  for (let i = 0; i < h.length; i++) {
    const entry = h[i];
    const ageMs = now - new Date(entry.date).getTime();
    
    // 2週間以上前、または新しい順から数えて50件目以降なら削除対象
    if (ageMs > TWO_WEEKS_MS || i >= 50) {
      if (entry.pdfPath) {
        const fullOldPath = path.join(__dirname, '..', 'public', entry.pdfPath);
        if (fs.existsSync(fullOldPath)) {
          console.log(`🗑️ 古いレポートを自動削除しました: ${entry.pdfPath}`);
          try {
            fs.unlinkSync(fullOldPath);
          } catch (e: any) {
            console.error(`削除エラー (${entry.pdfPath}):`, e.message);
          }
        }
      }
    } else {
      keptHistory.push(entry);
    }
  }

  fs.writeFileSync(hPath, JSON.stringify(keptHistory, null, 2));
}

// ---------- シグナルハンドラ ----------------------------------------
// GitHub Actions が6時間制限で SIGTERM を送ってきた際に PDF を保存する
process.on('SIGTERM', () => {
  console.log('\n⚡ SIGTERM 受信 — 緊急PDF生成を開始します...');
  // asyncを使えないので finish() を起動し、その完了を待たずに猶予を持たせる
  finish('sigterm_forced').finally(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('\n⚡ SIGINT 受信（Ctrl+C）— 録画を終了します...');
  finish('sigint_manual').finally(() => process.exit(0));
});

// ---------- YouTube API ----------

const ytAxios = axios.create({ timeout: AXIOS_TIMEOUT_MS });

async function getLiveChatInfo(vid: string, key: string): Promise<{ chatId: string; title: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${encodeURIComponent(vid)}&key=${encodeURIComponent(key)}`;
  const res = await ytAxios.get(url);
  const data = res.data;
  if (!data.items?.length) throw new Error('動画が見つかりません');

  const title: string = data.items[0].snippet?.title ?? '不明なタイトル';
  const chatId: string | undefined = data.items[0].liveStreamingDetails?.activeLiveChatId;

  if (!chatId) throw new Error('ライブチャットが見つかりません (配信終了済みか非公開)');
  return { chatId, title };
}

async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (finishCalled) return;

  // 最大録画時間チェック
  if (Date.now() - startTime >= maxWaitMs) {
    return finish('max_duration');
  }

  const url =
    `https://www.googleapis.com/youtube/v3/liveChat/messages` +
    `?liveChatId=${encodeURIComponent(liveChatId)}` +
    `&part=snippet,authorDetails&maxResults=2000` +
    `&key=${encodeURIComponent(key)}` +
    (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '');

  try {
    const res = await ytAxios.get(url);
    const data = res.data;

    fatalRetryCount = 0; // 正常に通信できた場合はリトライカウントをリセット

    if (data.items?.length) {
      resetIdleTimer();
      const newMsgs = data.items.map((item: any) => {
        const type = item.snippet?.type;
        let superChatAmount;
        if (type === 'superChatEvent') {
          superChatAmount = item.snippet?.superChatDetails?.amountDisplayString;
        } else if (type === 'superStickerEvent') {
          superChatAmount = item.snippet?.superStickerDetails?.amountDisplayString;
        }
        return {
          sessionId: videoId,
          messageId: item.id ?? '',
          authorName: item.authorDetails?.displayName ?? '不明',
          message: item.snippet?.displayMessage ?? '',
          timestamp: item.snippet?.publishedAt,
          superChatAmount
        };
      });
      messages.push(...newMsgs);
      messageCount += newMsgs.length;
      console.log(`🎙️ 録画中: +${newMsgs.length}件 (合計: ${messageCount}件)`);
    } else {
      console.log(`🎙️ 録画中: 新着なし (合計: ${messageCount}件)`);
    }

    if (finishCalled) return;

    // API が指定する待機時間を尊重（最小15秒、最大60秒）
    const interval = Math.min(Math.max(data.pollingIntervalMillis ?? 30_000, 15_000), 60_000);
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, data.nextPageToken), interval);

  } catch (err: any) {
    const status: number | undefined  = err.response?.status;
    const responseData = err.response?.data;
    const reason: string | undefined = responseData?.error?.errors?.[0]?.reason;

    // ❌ クォータ完全消費 → retryしても絶対に回復しないので即終了
    if (status === 403 && (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded')) {
      console.log(`🛑 APIクォータが上限に達しました (403: ${reason}) — 録画を終了します。`);
      return finish('api_error_quota');
    }

    // ⏳ 配信切断・一時的アクセス拒否・チャットID期限切れ → 最大10回・30秒待ちで再接続
    //    - liveChatEnded: OBSドロップや長時間配信中のID自動更新が原因の場合がある
    //    - 404:          チャットIDが古くなり新しいIDに切り替わった場合
    //    - 403 (forbidden等): チャットが一時的に無効化された場合
    if (reason === 'liveChatEnded' || status === 404 || status === 403) {
      if (fatalRetryCount < MAX_FATAL_RETRIES) {
        fatalRetryCount++;
        console.warn(`⚠️ チャット切断シグナルを受信 (HTTP ${status}: ${reason ?? 'unknown'}). 一時的なドロップやID更新の可能性があるため30秒待機して再確認します (${fatalRetryCount}/${MAX_FATAL_RETRIES})...`);
        if (!finishCalled) {
          pollTimeout = setTimeout(async () => {
            try {
              // ライブチャットIDが切り替わっていないか再確認
              const info = await getLiveChatInfo(videoId, key);
              if (info.chatId && info.chatId !== liveChatId) {
                console.log(`♻️ ライブチャットIDのローテーションを検知！ 新ID: ${info.chatId} で録画を再開します。`);
                fatalRetryCount = 0;
                pollChat(info.chatId, key, undefined);
              } else {
                // IDは変わっていないが配信はまだ続いている → 同じIDで再開
                console.log(`🔄 配信は継続中。同じチャットIDで録画を再開します...`);
                fatalRetryCount = 0;
                pollChat(liveChatId, key, undefined);
              }
            } catch (e: any) {
              if (e.response?.status === 403 && (e.response?.data?.error?.errors?.[0]?.reason === 'quotaExceeded' || e.response?.data?.error?.errors?.[0]?.reason === 'dailyLimitExceeded')) {
                console.log('🛑 再確認中にクォータ切れを検出 — 録画を終了します。');
                finish('api_error_quota');
              } else {
                // 動画情報取得に失敗しても念のため元IDでリトライを継続
                console.warn(`⚠️ ライブ情報の再取得に失敗。元のIDで再試行します: ${e.message}`);
                pollChat(liveChatId, key, pageToken);
              }
            }
          }, 30_000);
        }
        return;
      }
      
      console.log(`🛑 ${MAX_FATAL_RETRIES}回再試行しましたが回復しないため終了します。`);
      return finish(`stream_ended_confirmed`);
    }

    // タイムアウト・一時的エラー(500等) → 20秒後にリトライ
    console.warn(`⚠️ 通信エラー (Status: ${status ?? 'timeout'}, 20秒後に再試行): ${err.message}`);
    if (!finishCalled) {
      pollTimeout = setTimeout(() => pollChat(liveChatId, key, pageToken), 20_000);
    }
  }
}

// ---------- メイン ----------
async function start() {
  console.log(`🚀 Smart-Archiver v3.1 (Stable API Mode) — Video: ${videoId}`);
  if (!YOUTUBE_API_KEY) {
    console.error('❌ YOUTUBE_API_KEY が設定されていません');
    process.exit(1);
  }

  try {
    const info = await getLiveChatInfo(videoId, YOUTUBE_API_KEY);
    videoTitle = info.title;
    console.log(`📺 対象動画: ${videoTitle}`);

    if (process.env.GITHUB_ENV) {
      // ランダムなデリミタを生成して、タイトルにEOF互換文字が含まれるインジェクションを防ぐ
      const delimiter = `EOF_${Math.random().toString(36).substring(2, 15)}`;
      fs.appendFileSync(process.env.GITHUB_ENV, `VIDEO_TITLE<<${delimiter}\n${videoTitle}\n${delimiter}\n`);
    }

    resetIdleTimer();
    pollChat(info.chatId, YOUTUBE_API_KEY);
  } catch (err: any) {
    console.error('❌ 開始エラー:', err.message);
    // ライブチャットが存在しない場合はエラーとして記録して終了
    updateHistory(videoId, 0, '', videoTitle, 'error');
    process.exit(1);
  }
}

start();
