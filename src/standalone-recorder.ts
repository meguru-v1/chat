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
/** チャット無更新が続いた場合のアイドルタイムアウト (60分) */
const IDLE_TIMEOUT_MS = 60 * 60 * 1000;
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
      const pdfBuffer = await generatePdf(videoId, messages, videoTitle);
      fs.writeFileSync(fullPdfPath, pdfBuffer);
      updateHistory(videoId, messages.length, pdfPath, videoTitle, 'completed');
      console.log(`✅ レポート生成成功: ${pdfPath}`);
    } catch (err) {
      console.error('❌ PDF生成失敗:', err);
      // PDF生成失敗時も、件数は記録しておく
      updateHistory(videoId, messages.length, '', videoTitle, 'error');
    }
  } else {
    updateHistory(videoId, 0, '', videoTitle, 'error');
    console.log('⚠️ メッセージ0件のため、エラーとして履歴に記録しました。');
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
  status: 'completed' | 'error'
) {
  const hPath = path.join(__dirname, '../public/sessions.json');
  let h: any[] = [];
  try {
    h = fs.existsSync(hPath) ? JSON.parse(fs.readFileSync(hPath, 'utf8')) : [];
  } catch {
    h = [];
  }

  const normalizedPath = p ? p.replace(/^public\//, '') : '';
  const newEntry = {
    videoId: vId,
    title,
    date: new Date().toISOString(),
    messageCount: count,
    pdfPath: normalizedPath,
    status,
  };

  if (normalizedPath) {
    h = [newEntry, ...h.filter((s: any) => s.pdfPath !== normalizedPath)];
  } else {
    h = [newEntry, ...h];
  }
  fs.writeFileSync(hPath, JSON.stringify(h.slice(0, 50), null, 2));
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

    // 配信終了 → 正常終了
    if (reason === 'liveChatEnded') {
      console.log('✅ 配信が終了しました。録画を正常終了します。');
      return finish('stream_ended');
    }

    console.error(`❌ APIエラー (Status: ${status ?? 'timeout'})`);

    if (status === 403) {
      console.log('🛑 クォータ切れ or 権限不足 — 録画を終了します。');
      return finish('api_error_403');
    }
    if (status === 404) {
      console.log('🛑 チャットが見つかりません — 録画を終了します。');
      return finish('api_error_404');
    }

    // タイムアウト・一時的エラー → 20秒後にリトライ
    console.warn(`⚠️ 通信エラー (20秒後に再試行): ${err.message}`);
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
