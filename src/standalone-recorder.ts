/**
 * standalone-recorder.ts (Stable API v2.4 - Back to Basics)
 * 
 * 以前の安定版エンジンのロジック (YouTube Data API v3 定期ポーリング) に
 * 完全に回帰し、ブラウザ (Puppeteer) 依存を排除します。
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { generatePdf } from './pdfService';

// ---------- 設定 ----------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60分

// 引数
const args = process.argv.slice(2);
const videoIdArg = args.find(a => a.startsWith('--video-id='))?.split('=')[1];
const timeoutArg = args.find(a => a.startsWith('--timeout='))?.split('=')[1];

if (!videoIdArg) {
  console.error('❌ --video-id=xxx を指定してください');
  process.exit(1);
}
const videoId = videoIdArg;
const maxDurationMinutes = parseInt(timeoutArg || '360', 10);
const maxWaitMs = maxDurationMinutes * 60 * 1000;

// ---------- 状態管理 ----------
let messages: any[] = [];
let isStopping = false;
let messageCount = 0;
let videoTitle = 'タイトル不明'; // タイトルを保持
let pollTimeout: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const startTime = Date.now();

/** アイドルタイマーをリセット */
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('⏰ チャット更新がないためタイムアウト停止');
    finish('idle_timeout');
  }, IDLE_TIMEOUT_MS);
}

/** 終了処理 */
async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;
  if (pollTimeout) clearTimeout(pollTimeout);
  if (idleTimer) clearTimeout(idleTimer);

  console.log(`🏁 録画終了 (${reason}) - 合計 ${messages.length} 件`);

  if (messages.length > 0) {
    // ファイル名をサニタイズ (安全な形式に)
    const safeTitle = videoTitle.replace(/[\\/:*?"<>|]/g, '_').substring(0, 50);
    const dateStr = new Date().toISOString().split('T')[0];
    const pdfFileName = `${safeTitle}_${dateStr}.pdf`;
    const pdfPath = `public/reports/${pdfFileName}`;
    const fullPdfPath = path.join(__dirname, '..', pdfPath);

    try {
      if (!fs.existsSync(path.dirname(fullPdfPath))) fs.mkdirSync(path.dirname(fullPdfPath), { recursive: true });
      const pdfBuffer = await generatePdf(videoId, messages, videoTitle);
      fs.writeFileSync(fullPdfPath, pdfBuffer);
      updateHistory(videoId, messages.length, pdfPath, videoTitle, 'completed');
      console.log(`✅ レポート生成成功: ${pdfPath}`);
    } catch (err) {
      console.error('❌ PDF生成失敗:', err);
      updateHistory(videoId, messages.length, '', videoTitle, 'error');
    }
  } else {
    // ③ メッセージ0件でもエラー履歴として記録
    updateHistory(videoId, 0, '', videoTitle, 'error');
    console.log(`⚠️ メッセージ0件のため、エラーとして履歴に記録しました。`);
  }
  process.exit(0);
}

function updateHistory(vId: string, count: number, p: string, title: string, status: string) {
  const hPath = path.join(__dirname, '../public/sessions.json');
  let h = fs.existsSync(hPath) ? JSON.parse(fs.readFileSync(hPath, 'utf8')) : [];
  const normalizedPath = p ? p.replace(/^public\//, '') : '';
  const newEntry = { 
    videoId: vId, 
    title: title,
    date: new Date().toISOString(), 
    messageCount: count, 
    pdfPath: normalizedPath,
    status: status
  };
  // pdfPath が空（エラー）の場合は videoId + date で重複排除
  if (normalizedPath) {
    h = [newEntry, ...h.filter((s: any) => s.pdfPath !== normalizedPath)];
  } else {
    h = [newEntry, ...h];
  }
  fs.writeFileSync(hPath, JSON.stringify(h.slice(0, 50), null, 2));

}

// ---------- YouTube API ----------

async function getLiveChatInfo(vid: string, key: string): Promise<{ chatId: string, title: string }> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${vid}&key=${key}`;
  const res = await axios.get(url);
  const data = res.data;
  if (!data.items?.length) throw new Error('動画が見つかりません');
  
  const title = data.items[0].snippet?.title || '不明なタイトル';
  const chatId = data.items[0].liveStreamingDetails?.activeLiveChatId;
  
  if (!chatId) throw new Error('ライブチャットが見つかりません (配信終了済みか非公開)');
  return { chatId, title };
}

async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (isStopping) return;
  if (Date.now() - startTime >= maxWaitMs) return finish('max_duration');

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000&key=${key}`;
  if (pageToken) url += `&pageToken=${pageToken}`;

  try {
    const res = await axios.get(url);
    const data = res.data;
    if (data.items?.length) {
      // 新着メッセージがあった場合のみアイドルタイマーをリセット
      resetIdleTimer();
      const newMsgs = data.items.map((item: any) => ({
        sessionId: videoId,
        messageId: item.id || '',
        authorName: item.authorDetails.displayName || '不明',
        message: item.snippet.displayMessage || '',
        timestamp: item.snippet.publishedAt
      }));
      messages.push(...newMsgs);
      messageCount += newMsgs.length;
      console.log(`🎙️ 録画中: +${newMsgs.length}件 (合計: ${messageCount}件)`);
    } else {
      console.log(`🎙️ 録画中: 新着なし (合計: ${messageCount}件)`);
    }

    pollTimeout = setTimeout(() => {
      pollChat(liveChatId, key, data.nextPageToken);
    }, 30000); // クォータ節約のため30秒間隔に固定

  } catch (err: any) {
    const status = err.response?.status;
    const responseData = err.response?.data;
    const reason = responseData?.error?.errors?.[0]?.reason;
    const errorData = JSON.stringify(responseData || {});

    // 配信が自然に終了した場合 → 正常終了としてPDFを生成
    if (reason === 'liveChatEnded') {
      console.log(`✅ 配信が終了しました。録画を正常終了します。`);
      return finish('stream_ended');
    }

    console.error(`❌ APIエラー発生 (Status: ${status})`);
    console.error(`📝 詳細: ${errorData}`);

    if (status === 403) {
      console.log(`🛑 録画を終了します。理由: クォータ切れ、または権限不足`);
      return finish(`api_error_403`);
    }
    if (status === 404) {
      console.log(`🛑 録画を終了します。理由: チャットが見つからない`);
      return finish(`api_error_404`);
    }
    console.warn(`⚠️ 通信エラー (20秒後に再試行): ${err.message}`);
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, pageToken), 20000);
  }
}

// ---------- メイン ----------
async function start() {
  console.log(`🚀 Smart-Archiver v2.5 (Stable API Mode) - Video: ${videoId}`);
  if (!YOUTUBE_API_KEY) {
    console.error('❌ YOUTUBE_API_KEY が不足しています');
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
    process.exit(1);
  }
}

start();
