/**
 * recorderWorker.ts — Worker Thread エントリポイント
 *
 * chat-downloader (Python CLI) を子プロセスとして起動し、
 * stdout の JSON 行をパースして MongoDB に保存する。
 *
 * ハイブリッド終了判定:
 *   A) chat-downloader プロセスが正常終了 → 配信終了
 *   B) 5分間 stdout 無出力 → タイムアウト → 子プロセス kill
 *   C) 親スレッドから 'stop' メッセージ → 子プロセス kill
 */
import { parentPort, workerData } from 'worker_threads';
import { spawn, ChildProcess } from 'child_process';
import mongoose from 'mongoose';
import { ChatMessage } from '../models/ChatMessage';

// ---------- 定数 ----------
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5分

// ---------- ワーカーデータ ----------
interface WorkerInput {
  videoId: string;
  mongoUri: string;
}

const { videoId, mongoUri } = workerData as WorkerInput;
const sessionId = videoId;

let chatProcess: ChildProcess | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let messageCount = 0;

/** 5分アイドルタイマーをリセット */
function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);

  idleTimer = setTimeout(() => {
    sendToParent('log', `⏰ 5分間新規チャットなし — タイムアウト停止`);
    cleanup('timeout');
  }, IDLE_TIMEOUT_MS);
}

/** 親スレッドへメッセージ送信 */
function sendToParent(
  type: string,
  data: string | number | Record<string, unknown>
): void {
  parentPort?.postMessage({ type, data });
}

/** クリーンアップ & 終了 */
async function cleanup(reason: string): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  if (chatProcess && !chatProcess.killed) {
    chatProcess.kill('SIGTERM');
    chatProcess = null;
  }

  sendToParent('finished', {
    reason,
    sessionId,
    messageCount,
  });

  // MongoDB 接続を閉じてワーカーを終了
  try {
    await mongoose.disconnect();
  } catch {
    // 無視
  }

  process.exit(0);
}

/** メイン処理 */
async function main(): Promise<void> {
  // MongoDB 接続
  await mongoose.connect(mongoUri);
  sendToParent('log', `🔌 MongoDB 接続完了`);

  // chat-downloader 子プロセスを起動
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  chatProcess = spawn('python', ['-m', 'chat_downloader', videoUrl, '--output', '-'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  sendToParent('log', `🚀 chat-downloader 起動 (video: ${videoId})`);
  sendToParent('status', 'recording');

  // 5分タイマー開始
  resetIdleTimer();

  // ---------- stdout パース ----------
  let buffer = '';

  chatProcess.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // 未完了行はバッファに残す

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const data = JSON.parse(trimmed);

        // chat-downloader の出力フォーマットに対応
        const timestamp = data.timestamp
          ? new Date(data.timestamp / 1000) // マイクロ秒 → ミリ秒
          : new Date();
        const authorName = data.author?.name || data.author_name || '不明';
        const message = data.message || '';

        if (!message) continue;

        // MongoDB に保存（非同期、エラーは無視しない）
        ChatMessage.create({
          sessionId,
          timestamp,
          authorName,
          message,
        }).catch((err) =>
          sendToParent('log', `⚠️ DB保存エラー: ${err.message}`)
        );

        messageCount++;
        resetIdleTimer(); // 新チャット受信 → 5分タイマーリセット

        // 100件ごとに進捗通知
        if (messageCount % 100 === 0) {
          sendToParent('progress', { messageCount });
        }
      } catch {
        // JSON パース失敗行は無視（ヘッダー行等）
      }
    }
  });

  // ---------- stderr ログ ----------
  chatProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf-8').trim();
    if (text) {
      sendToParent('log', `📝 chat-downloader: ${text}`);
    }
  });

  // ---------- プロセス終了 ----------
  chatProcess.on('close', (code) => {
    sendToParent(
      'log',
      `🛑 chat-downloader 終了 (code: ${code}, 記録数: ${messageCount})`
    );
    cleanup(code === 0 ? 'stream_ended' : 'process_error');
  });

  chatProcess.on('error', (err) => {
    sendToParent('log', `❌ chat-downloader エラー: ${err.message}`);
    cleanup('process_error');
  });
}

// ---------- 親スレッドからの停止メッセージ ----------
parentPort?.on('message', (msg) => {
  if (msg === 'stop') {
    sendToParent('log', `🛑 手動停止リクエスト受信`);
    cleanup('manual_stop');
  }
});

// ---------- 起動 ----------
main().catch((err) => {
  sendToParent('log', `❌ ワーカー致命的エラー: ${err.message}`);
  cleanup('fatal_error');
});
