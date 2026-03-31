/**
 * standalone-recorder.ts — スタンドアロン録画スクリプト (直行モード)
 *
 * 使い方:
 *   npx ts-node src/standalone-recorder.ts --video-id [VIDEO_ID] --timeout [MINUTES]
 *
 * 背景プロセスや監視ループを介さず、このプロセス一つで録画・終了判定・PDF生成まで完走します。
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ChatMessage } from './models/ChatMessage';
import { generatePdf } from './pdfService';
import fs from 'fs';
import path from 'path';

// ---------- 引数解析 ----------
const args = process.argv.slice(2);
const videoId = getArg('--video-id') || '';
const timeoutMinutes = parseInt(getArg('--timeout') || '360', 10);
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat-archiver';
const apiKey = process.env.YOUTUBE_API_KEY;

function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

if (!videoId) {
  console.error('❌ --video-id が指定されていません');
  process.exit(1);
}

// ---------- 状態管理 ----------
let isStopping = false;
let messageCount = 0;
let pollTimeout: NodeJS.Timeout | null = null;
const startTime = Date.now();
const maxWaitMs = timeoutMinutes * 60 * 1000;

// ---------- YouTube API 機能 ----------

async function getActiveLiveChatId(vid: string, key: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${vid}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) {
    const errObj = (await res.json().catch(() => ({}))) as any;
    throw new Error(`APIエラー: ${res.status} ${errObj.error?.message || ''}`);
  }
  const data = (await res.json()) as any;
  if (!data.items || data.items.length === 0) throw new Error('動画が存在しないか、非公開です');
  const details = data.items[0].liveStreamingDetails;
  if (!details || !details.activeLiveChatId) throw new Error('有効なライブチャットが見つかりません');
  return details.activeLiveChatId;
}

async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (isStopping) return;

  // タイムアウトチェック
  const elapsed = Date.now() - startTime;
  if (elapsed >= maxWaitMs) {
    console.log(`⏰ 指定時間 (${timeoutMinutes}分) に達したため録画を終了します`);
    return finish('timeout');
  }

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000&key=${key}`;
  if (pageToken) url += `&pageToken=${pageToken}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        console.log(`🛑 録画終了: チャットが閉じられました (${res.status})`);
        return finish('stream_ended');
      }
      throw new Error(`APIエラー: ${res.status}`);
    }

    const data = (await res.json()) as any;
    if (data.items && data.items.length > 0) {
      const messagesToSave = data.items.map((item: any) => ({
        sessionId: videoId,
        timestamp: new Date(item.snippet.publishedAt),
        authorName: item.authorDetails.displayName || '不明',
        message: item.snippet.displayMessage || ''
      })).filter((m: any) => m.message);

      if (messagesToSave.length > 0) {
        // バルクインサートを試行（効率化）
        await ChatMessage.insertMany(messagesToSave, { ordered: false }).catch(() => {});
        messageCount += messagesToSave.length;
        console.log(`📡 [${new Date().toLocaleTimeString()}] +${messagesToSave.length} 件取得 (累計: ${messageCount} 件)`);
      }
    }

    const interval = data.pollingIntervalMillis || 10000;
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, data.nextPageToken), interval);

  } catch (err: any) {
    console.warn(`⚠️ 通信警告 (10秒後に再試行): ${err.message}`);
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, pageToken), 10000);
  }
}

// ---------- 終了・PDF生成 ----------

async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;
  if (pollTimeout) clearTimeout(pollTimeout);

  console.log(`🏁 録画フェーズ完了 (理由: ${reason}) / PDF生成を開始します...`);

  try {
    const outputDir = path.resolve(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const pdfBuffer = await generatePdf(videoId);
    const pdfPath = path.join(outputDir, `chat-report-${videoId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    console.log(`✅ レポート生成完了: ${pdfPath}`);
  } catch (err: any) {
    console.error(`❌ PDF生成エラー: ${err.message}`);
  } finally {
    await mongoose.disconnect();
    console.log('🚪 プロセスを終了します');
    process.exit(0);
  }
}

// ---------- メイン実行 ----------

async function main() {
  console.log(`🚀 スタンドアロン録画開始: ${videoId} (上限: ${timeoutMinutes}分)`);
  
  if (!apiKey || apiKey === 'your_api_key_here') {
    console.error('❌ YOUTUBE_API_KEY が設定されていません');
    process.exit(1);
    return;
  }

  // ここからは apiKey は確実に string
  const validApiKey = apiKey!;

  await mongoose.connect(mongoUri);
  console.log('🔌 MongoDB 接続完了');

  const liveChatId = await getActiveLiveChatId(videoId, validApiKey);
  console.log(`📡 録画ループへ突入 (liveChatId: ${liveChatId})`);
  
  // シグナルハンドリング (Actionsの強制終了対策)
  process.on('SIGINT', () => finish('manual_stop'));
  process.on('SIGTERM', () => finish('manual_stop'));

  pollChat(liveChatId, validApiKey);
}

main().catch(err => {
  console.error(`❌ 致命的エラー: ${err.message}`);
  process.exit(1);
});

