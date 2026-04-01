/**
 * standalone-recorder.ts (Stable API v2.2)
 * 
 * 以前の安定版ロジック (YouTube Data API v3) に回帰し、
 * データベース不要で PDF レポートを生成する構成です。
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import { generatePdf } from './pdfService';

// ---------- 設定 ----------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60分間チャット更新がない場合停止

// 引数取得
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
let pollTimeout: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const startTime = Date.now();

/** アイドルタイマーをリセット (通信が生きているか確認) */
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.log('⏰ 60分間チャットの更新またはAPIレスポンスがありません。終了します。');
    finish('idle_timeout');
  }, IDLE_TIMEOUT_MS);
}

/** 終了処理 (PDF生成と履歴更新) */
async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;

  if (pollTimeout) clearTimeout(pollTimeout);
  if (idleTimer) clearTimeout(idleTimer);

  console.log(`🏁 録画終了 (理由: ${reason}) - 合計 ${messages.length} 件`);

  if (messages.length > 0) {
    const reportDir = path.join(__dirname, '../public/reports');
    if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

    const pdfPath = `public/reports/${videoId}.pdf`;
    const fullPdfPath = path.join(__dirname, '..', pdfPath);

    try {
      console.log('📊 PDFレポートを生成中...');
      const pdfBuffer = await generatePdf(videoId, messages);
      fs.writeFileSync(fullPdfPath, pdfBuffer);

      // sessions.json を更新
      updateSessionHistory(videoId, messages.length, pdfPath);
      console.log(`✅ 保存完了: ${pdfPath}`);
    } catch (err) {
      console.error('❌ PDF生成エラー:', err);
    }
  } else {
    console.log('ℹ️ メッセージが0件のため、レポートは生成しません。');
  }

  process.exit(0);
}

/** 履歴 (sessions.json) の更新 */
function updateSessionHistory(vId: string, count: number, pathStr: string) {
  const sessionsPath = path.join(__dirname, '../public/sessions.json');
  let sessions: any[] = [];

  if (fs.existsSync(sessionsPath)) {
    try {
      sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf8'));
    } catch (e) {}
  }

  // 重複削除して、新しい履歴を先頭に追加
  const newSession = {
    videoId: vId,
    date: new Date().toISOString(),
    messageCount: count,
    pdfPath: pathStr.replace('public/', '') // Webからのアクセスパス
  };

  sessions = sessions.filter(s => s.videoId !== vId);
  sessions.unshift(newSession);

  fs.writeFileSync(sessionsPath, JSON.stringify(sessions.slice(0, 50), null, 2));
}

// ==========================================
// YouTube Data API 関連
// ==========================================

/** 1. liveChatId を取得 */
async function getLiveChatId(vid: string, key: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${vid}&key=${key}`;
  const res = await axios.get(url);
  const data = res.data;

  if (!data.items || data.items.length === 0) {
    throw new Error('動画が見つかりませんでした。');
  }

  const details = data.items[0].liveStreamingDetails;
  if (!details || !details.activeLiveChatId) {
    throw new Error('この動画には有効なライブチャットがありません。');
  }

  return details.activeLiveChatId;
}

/** 2. チャットのポーリング */
async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (isStopping) return;

  // 全体のタイムアウトチェック
  if (Date.now() - startTime >= maxWaitMs) {
    return finish('max_duration_reached');
  }

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000&key=${key}`;
  if (pageToken) url += `&pageToken=${pageToken}`;

  try {
    const res = await axios.get(url);
    resetIdleTimer();

    const data = res.data;
    if (data.items && data.items.length > 0) {
      const newMsgs = data.items.map((item: any) => ({
        sessionId: videoId,
        messageId: item.id || '',
        authorName: item.authorDetails.displayName || '不明',
        message: item.snippet.displayMessage || '',
        timestamp: new Date(item.snippet.publishedAt)
      })).filter((m: any) => m.message);

      messages.push(...newMsgs);
      messageCount += newMsgs.length;
      console.log(`🎙️ 録画中: +${newMsgs.length}件 (合計: ${messageCount}件)`);
    }

    const nextToken = data.nextPageToken;
    const interval = data.pollingIntervalMillis || 10000;

    pollTimeout = setTimeout(() => {
      pollChat(liveChatId, key, nextToken);
    }, interval);

  } catch (err: any) {
    if (err.response?.status === 403 || err.response?.status === 404) {
      console.log('🛑 ライブチャットが終了した可能性があります（403/404）');
      return finish('stream_ended');
    }
    console.error(`⚠️ APIエラー (${err.message})... 10秒後に再試行`);
    pollTimeout = setTimeout(() => {
      pollChat(liveChatId, key, pageToken);
    }, 10000);
  }
}

// ==========================================
// 実行
// ==========================================
async function start() {
  console.log(`🚀 Smart-Archiver v2.2 スタート (Video ID: ${videoId})`);

  if (!YOUTUBE_API_KEY) {
    console.error('❌ YOUTUBE_API_KEY がセットされていません');
    process.exit(1);
  }

  try {
    console.log('🔍 YouTube Data API に接続中...');
    const liveChatId = await getLiveChatId(videoId, YOUTUBE_API_KEY);
    console.log(`📡 LiveChatId 取得成功: ${liveChatId}`);

    resetIdleTimer();
    pollChat(liveChatId, YOUTUBE_API_KEY);

  } catch (err: any) {
    console.error('❌ 起動エラー:', err.message);
    process.exit(1);
  }
}

start();
