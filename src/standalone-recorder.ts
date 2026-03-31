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
const startTime = Date.now();
const maxWaitMs = timeoutMinutes * 60 * 1000;

// ---------- グローバルエラーハンドリング ----------
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ 未ハンドルの拒絶が発生しました:', reason);
  // 致命的な場合は終了
  if (!isStopping) finish('unhandled_rejection');
});

// ---------- YouTube チャット取得 (スクレイピング方式) ----------

import { LiveChat } from 'youtube-chat';

async function startRecording() {
  console.log(`🚀 ライブチャット監視を開始します (Scraping Mode / APIキー不要)`);
  
  // liveId は YouTube の videoId と同じです
  const liveChat = new LiveChat({ liveId: videoId });
  let lastMessageTime = Date.now();

  // チャット受信
  liveChat.on('chat', async (chatItem) => {
    if (isStopping) return;

    // メッセージのテキストを結合 (テキストと絵文字の混在対応)
    const messageText = chatItem.message.map((part: any) => part.text || '').join('');
    if (!messageText) return;

    const messageToSave = {
      sessionId: videoId,
      messageId: chatItem.id,
      timestamp: new Date(chatItem.timestamp),
      authorName: chatItem.author.name,
      message: messageText
    };

    try {
      // 重複は messageId (Unique index) で自動排除される
      await ChatMessage.insertMany([messageToSave], { ordered: false }).catch((err: any) => {
        if (err.code !== 11000) console.error(`❌ DB保存エラー: ${err.message}`);
      });
      
      messageCount++;
      
      // 30件ごとに進捗を表示
      if (messageCount % 30 === 0 || messageCount === 1) {
        console.log(`📡 [${new Date().toLocaleTimeString()}] +${messageCount} 件記録中... (最新: ${messageToSave.authorName})`);
      }
      
      lastMessageTime = Date.now();
    } catch (err: any) {
      console.error(`❌ 保存処理エラー: ${err.message}`);
    }
  });

  // エラー発生 (再試行はライブラリが内部で実施)
  liveChat.on('error', (err: any) => {
    console.warn(`⚠️ 監視警告: ${err.message}`);
  });

  // タイムアウト監視 (Actions の制限時間用)
  const timeoutCheckInterval = setInterval(() => {
    const elapsedTotal = Date.now() - startTime;
    if (elapsedTotal >= maxWaitMs) {
      console.log(`⏰ ワークフローの制限時間 (${timeoutMinutes}分) に達したため、安全に終了処理へ移行します`);
      clearInterval(timeoutCheckInterval);
      liveChat.stop();
      finish('workflow_timeout');
    }

    // アイドルタイムアウト (20分間何もなければ終了とみなす)
    const idleElapsed = Date.now() - lastMessageTime;
    if (idleElapsed > 20 * 60 * 1000) {
      console.log(`💤 20分間チャットの動きがないため、終了と判断します`);
      clearInterval(timeoutCheckInterval);
      liveChat.stop();
      finish('idle_timeout');
    }
  }, 60000); // 1分ごとにチェック

  // 監視開始！
  // start() は監視が停止（終了）するまで解決しません
  try {
    const ok = await liveChat.start();
    clearInterval(timeoutCheckInterval);
    if (!isStopping) {
      console.log('🏁 YouTube 側でチャットの終了が検知されました');
      finish(ok ? 'stream_finished' : 'connection_failed');
    }
  } catch (err: any) {
    if (!isStopping) {
      console.error(`❌ ライブチャット監視中に致命的エラーが発生しました: ${err.message}`);
      finish('api_error');
    }
  }
}

// ---------- 終了・PDF生成 ----------

async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;

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
  console.log('--- YouTube Chat Smart-Archiver (Scraping Mode) ---');
  console.log(`🎯 Target: ${videoId}`);
  console.log(`⏳ Timeout: ${timeoutMinutes} min`);
  console.log(`🛡️  Mode: No API Key Required`);

  try {
    console.log(`🔌 MongoDB に接続中...`);
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 5000,
    });
    console.log('✅ MongoDB 接続成功');
    
    // シグナルハンドリング
    process.on('SIGINT', () => finish('manual_stop'));
    process.on('SIGTERM', () => finish('manual_stop'));

    await startRecording();
  } catch (err: any) {
    console.error(`❌ 起動フェーズで致命的エラーが発生しました: ${err.message}`);
    process.exit(1);
  }
}

main();


