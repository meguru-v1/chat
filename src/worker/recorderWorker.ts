/**
 * recorderWorker.ts — Worker Thread エントリポイント (公式API版)
 *
 * YouTube Data API v3 を使用してライブチャットを定期的(ポーリング)に取得し、
 * MongoDB に保存する。Python(chat-downloader)依存から脱却。
 *
 * ハイブリッド終了判定:
 *   A) YouTube APIが403/404(配信終了)を返す → 配信終了
 *   B) 5分間新規チャットなし → タイムアウト終了
 *   C) 親スレッドから 'stop' メッセージ → 強制終了
 */
import { parentPort, workerData } from 'worker_threads';
import mongoose from 'mongoose';
import { ChatMessage } from '../models/ChatMessage';

// ---------- 定数 ----------
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5分

// ---------- ワーカーデータ ----------
interface WorkerInput {
  videoId: string;
  mongoUri: string;
  apiKey?: string;
}

const { videoId, mongoUri, apiKey } = workerData as WorkerInput;
const sessionId = videoId;

let isStopping = false;
let messageCount = 0;
let idleTimer: NodeJS.Timeout | null = null;
let pollTimeout: NodeJS.Timeout | null = null;

/** 5分アイドルタイマーをリセット */
function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    sendToParent('log', `⏰ 5分間新規チャットなし — タイムアウト停止`);
    cleanup('timeout');
  }, IDLE_TIMEOUT_MS);
}

/** 親スレッドへメッセージ送信 */
function sendToParent(type: string, data: any): void {
  parentPort?.postMessage({ type, data });
}

/** クリーンアップ & 終了 */
async function cleanup(reason: string): Promise<void> {
  if (isStopping) return;
  isStopping = true;

  if (idleTimer) clearTimeout(idleTimer);
  if (pollTimeout) clearTimeout(pollTimeout);

  sendToParent('finished', { reason, sessionId, messageCount });

  try {
    await mongoose.disconnect();
  } catch {
    // 無視
  }

  process.exit(0);
}

// ==========================================
// YouTube Data API 関連機能
// ==========================================

/** 1. 対象ビデオの liveChatId を取得する */
async function getActiveLiveChatId(vid: string, key: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${vid}&key=${key}`;
  const res = await fetch(url);
  
  if (!res.ok) {
    const errObj = (await res.json().catch(() => ({}))) as any;
    throw new Error(`APIエラー: ${res.status} ${errObj.error?.message || ''}`);
  }

  const data = (await res.json()) as any;
  if (!data.items || data.items.length === 0) {
    throw new Error('動画が存在しないか、非公開です');
  }

  const details = data.items[0].liveStreamingDetails;
  if (!details || !details.activeLiveChatId) {
    throw new Error('この動画には有効なライブチャットが存在しません');
  }

  return details.activeLiveChatId;
}

/** 2. チャットをループ取得 (ポーリング) */
async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (isStopping) return;

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000&key=${key}`;
  if (pageToken) url += `&pageToken=${pageToken}`;

  try {
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 403 || res.status === 404) {
        // 配信終了やアーカイブ化に伴いチャットが閉じられた
        sendToParent('log', `🛑 ライブチャットが終了しました (status: ${res.status})`);
        return cleanup('stream_ended');
      }
      const errObj = (await res.json().catch(() => ({}))) as any;
      throw new Error(`Chat API通信エラー: ${res.status} ${errObj.error?.message || ''}`);
    }

    const data = (await res.json()) as any;

    // 取得したメッセージをパースして保存
    if (data.items && data.items.length > 0) {
      const messagesToSave = data.items.map((item: any) => ({
        sessionId,
        timestamp: new Date(item.snippet.publishedAt),
        authorName: item.authorDetails.displayName || '不明',
        message: item.snippet.displayMessage || ''
      })).filter((m: any) => m.message);

      if (messagesToSave.length > 0) {
        for (const m of messagesToSave) {
          await ChatMessage.create(m).catch(() => {});
        }

        messageCount += messagesToSave.length;
        resetIdleTimer();

        // ある程度の単位で進捗を親に送る
        sendToParent('progress', { messageCount });
      }
    }

    const nextToken = data.nextPageToken;
    // APIが要求する待機時間 (短すぎるとBANされるため必ず守る)
    const interval = data.pollingIntervalMillis || 10000;

    if (isStopping) return;

    pollTimeout = setTimeout(() => {
      pollChat(liveChatId, key, nextToken);
    }, interval);

  } catch (err: any) {
    sendToParent('log', `⚠️ チャット取得警告: ${err.message}`);
    // 一時的なネットワークエラーの可能性もあるため、10秒後にリトライする
    if (!isStopping) {
      pollTimeout = setTimeout(() => {
        pollChat(liveChatId, key, pageToken);
      }, 10000);
    }
  }
}

// ==========================================
// メイン処理
// ==========================================
async function main(): Promise<void> {
  if (!apiKey || apiKey === 'your_api_key_here') {
    throw new Error('YOUTUBE_API_KEY が正しく設定されていません。');
  }

  // MongoDB 接続
  await mongoose.connect(mongoUri);
  sendToParent('log', `🔌 MongoDB 接続完了`);

  // chatId 取得
  sendToParent('log', `🔍 YouTube Data APIに接続中 (video: ${videoId})...`);
  const liveChatId = await getActiveLiveChatId(videoId, apiKey);

  sendToParent('log', `🚀 公式APIで録画開始 (liveChatId: ${liveChatId})`);
  sendToParent('status', 'recording');

  // タイマーとポーリング開始
  resetIdleTimer();
  pollChat(liveChatId, apiKey);
}

// 親スレッドからのメッセージ待ち受け
parentPort?.on('message', (msg) => {
  if (msg === 'stop') {
    sendToParent('log', `🛑 手動停止リクエスト受信`);
    cleanup('manual_stop');
  }
});

// 起動
main().catch((err) => {
  sendToParent('log', `❌ ワーカーエラー: ${err.message}`);
  cleanup('process_error');
});
