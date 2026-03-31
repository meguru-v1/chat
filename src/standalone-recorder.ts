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

// ---------- グローバルエラーハンドリング ----------
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未ハンドルの拒絶が発生しました:', reason);
  // 致命的な場合は終了
  if (!isStopping) finish('unhandled_rejection');
});

// ---------- YouTube API 機能 ----------

let retryCount = 0;
let consecutive403Count = 0;
const MAX_RETRIES = 60; // リトライ回数（1分間隔 * 60 = 1時間まで粘る）
let lastMessageTime = Date.now();

async function getActiveLiveChatId(vid: string, key: string): Promise<string> {
  console.log(`🔍 [API] liveChatId を取得中... (Video: ${vid})`);
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
  console.log(`✅ [API] liveChatId 取得成功: ${details.activeLiveChatId}`);
  return details.activeLiveChatId;
}

async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (isStopping) return;

  // タイムアウトチェック (Actions全体の制限)
  const elapsedTotal = Date.now() - startTime;
  if (elapsedTotal >= maxWaitMs) {
    console.log(`⏰ ワークフローの制限時間 (${timeoutMinutes}分) に達したため、安全に終了処理へ移行します`);
    return finish('workflow_timeout');
  }

  // アイドルタイムアウトチェック (15分間何も起きなければ終了とみなす)
  const idleElapsed = Date.now() - lastMessageTime;
  if (idleElapsed > 15 * 60 * 1000) {
    console.log(`💤 15分間新しい動きがないため、配信終了と判断します`);
    return finish('idle_timeout');
  }

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000&key=${key}`;
  if (pageToken) url += `&pageToken=${pageToken}`;

  try {
    const res = await fetch(url);
    
    if (!res.ok) {
      if (res.status === 403 || res.status === 404 || res.status >= 500) {
        retryCount++;
        if (res.status === 403) consecutive403Count++;

        const waitSec = 60;
        console.warn(`⚠️ API警告 (${res.status}): 再接続を試みます (${retryCount}/${MAX_RETRIES}) ... ${waitSec}秒待機`);
        
        // 403 が 3回続いたら、チャットIDをリフレッシュしてみる
        if (consecutive403Count >= 3) {
          console.log(`🔄 403 エラーが継続しているため、セッションのリセット（再取得）を試みます...`);
          try {
            const newChatId = await getActiveLiveChatId(videoId, key);
            consecutive403Count = 0;
            pollTimeout = setTimeout(() => pollChat(newChatId, key, undefined), 5000); // 5秒後に新規リクエスト
            return;
          } catch (e: any) {
            console.error(`❌ セッションのリセットに失敗しました: ${e.message}`);
          }
        }

        if (retryCount >= MAX_RETRIES) {
          console.error(`❌ 最大リトライ回数 (計1時間) に達しました。配信終了とみなします。`);
          return finish('api_error_limit');
        }
        
        pollTimeout = setTimeout(() => pollChat(liveChatId, key, pageToken), waitSec * 1000);
        return;
      }
      throw new Error(`API致命的エラー: ${res.status}`);
    }

    // 成功した場合はリトライカウンタをリセット
    retryCount = 0;
    consecutive403Count = 0;
    const data = (await res.json()) as any;
    
    if (data.items && data.items.length > 0) {
      lastMessageTime = Date.now(); // 最終アクティビティ更新
      const messagesToSave = data.items.map((item: any) => ({
        sessionId: videoId,
        messageId: item.id, // YouTube のユニークメッセージID
        timestamp: new Date(item.snippet.publishedAt),
        authorName: item.authorDetails.displayName || '不明',
        message: item.snippet.displayMessage || ''
      })).filter((m: any) => m.message);

      if (messagesToSave.length > 0) {
        // 重複エラー (E11000) を無視して挿入
        await ChatMessage.insertMany(messagesToSave, { ordered: false }).catch((err) => {
          if (err.code !== 11000) console.error(`❌ DB保存エラー: ${err.message}`);
        });
        
        // 累計カウントを正確にする（今回は厳密さよりパフォーマンス優先で増分を加算）
        messageCount += messagesToSave.length; 
        console.log(`📡 [${new Date().toLocaleTimeString()}] +${messagesToSave.length} 件取得 (累計: ${messageCount} 件)`);
      }
    } else {
      // メッセージが空でも生存ログを出す
      const now = Date.now();
      if (!global.lastLogTime || now - global.lastLogTime > 60000) {
        console.log(`🕒 待機中... (最終取得から ${(idleElapsed/60000).toFixed(1)} 分) / 累計: ${messageCount} 件`);
        global.lastLogTime = now;
      }
    }

    const interval = data.pollingIntervalMillis || 10000;
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, data.nextPageToken), interval);

  } catch (err: any) {
    console.error(`❌ 通信エラー (60秒後に再試行): ${err.message}`);
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, pageToken), 60000);
  }
}

// global型定義の補強
declare global {
  var lastLogTime: number | undefined;
}

// ---------- 終了・PDF生成 ----------

async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;
  if (pollTimeout) clearTimeout(pollTimeout);

  console.log(`🏁 録画フェーズ完了 (理由: ${reason}) / 保存件数: ${messageCount} 件`);
  console.log(`📄 PDF生成を開始します... (Video: ${videoId})`);

  try {
    const outputDir = path.resolve(process.cwd(), 'output');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);

    const pdfBuffer = await generatePdf(videoId);
    const pdfPath = path.join(outputDir, `chat-report-${videoId}.pdf`);
    fs.writeFileSync(pdfPath, pdfBuffer);

    console.log(`✅ レポート生成成功: ${pdfPath}`);
  } catch (err: any) {
    console.error(`❌ PDF生成エラー: ${err.message}`);
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
      console.log('🔌 MongoDB 切断完了');
    }
    console.log('🚪 プロセスを終了します');
    process.exit(0);
  }
}

// ---------- メイン実行 ----------

async function main() {
  console.log('--- YouTube Chat Standalone Recorder (Tough Mode) ---');
  console.log(`🎯 Target: ${videoId}`);
  console.log(`⏳ Timeout: ${timeoutMinutes} min`);
  
  if (!apiKey || apiKey === 'your_api_key_here') {
    console.error('❌ YOUTUBE_API_KEY が未設定です。GitHub Secretsを確認してください。');
    process.exit(1);
    return;
  }

  const validApiKey = apiKey!;

  try {
    console.log(`🔌 MongoDB に接続中...`);
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('✅ MongoDB 接続成功');

    const liveChatId = await getActiveLiveChatId(videoId, validApiKey);
    console.log(`🚀 録画メインループを開始します (早期終了防止モード有効)`);
    
    // シグナルハンドリング
    process.on('SIGINT', () => finish('manual_stop'));
    process.on('SIGTERM', () => finish('manual_stop'));

    pollChat(liveChatId, validApiKey);
  } catch (err: any) {
    console.error(`❌ 起動フェーズで致命的エラーが発生しました: ${err.message}`);
    process.exit(1);
  }
}

main();

