/**
 * recorder.ts — チャット監視エンジン
 *
 * Worker Thread を起動・管理し、複数セッションの同時録画に対応する。
 */
import { Worker } from 'worker_threads';
import path from 'path';

export interface RecordingSession {
  videoId: string;
  worker: Worker;
  status: 'recording' | 'stopping' | 'finished';
  messageCount: number;
  startedAt: Date;
  finishedAt?: Date;
  finishReason?: string;
}

// アクティブセッション管理マップ
const sessions = new Map<string, RecordingSession>();

/**
 * 録画を開始する
 */
export function startRecording(
  videoId: string,
  mongoUri: string
): RecordingSession {
  if (sessions.has(videoId)) {
    const existing = sessions.get(videoId)!;
    if (existing.status === 'recording') {
      throw new Error(`セッション ${videoId} は既に録画中です`);
    }
    // 終了済みなら上書き可能
    sessions.delete(videoId);
  }

  const workerPath = path.resolve(__dirname, 'worker/recorderWorker.ts');
  // ts-node 環境用: .ts ファイルを直接実行
  // 本番環境では dist/worker/recorderWorker.js を参照
  const actualWorkerPath = workerPath.endsWith('.ts')
    ? workerPath
    : workerPath.replace(/\.ts$/, '.js');

  const worker = new Worker(actualWorkerPath, {
    workerData: { videoId, mongoUri },
    // ts-node 環境で .ts ファイルの Worker を動かすための設定
    execArgv: workerPath.endsWith('.ts')
      ? ['--require', 'ts-node/register']
      : [],
  });

  const session: RecordingSession = {
    videoId,
    worker,
    status: 'recording',
    messageCount: 0,
    startedAt: new Date(),
  };

  // Worker からのメッセージを処理
  worker.on('message', (msg: { type: string; data: unknown }) => {
    switch (msg.type) {
      case 'progress': {
        const progress = msg.data as { messageCount: number };
        session.messageCount = progress.messageCount;
        break;
      }
      case 'status':
        session.status = msg.data as 'recording';
        break;
      case 'finished': {
        const result = msg.data as {
          reason: string;
          messageCount: number;
        };
        session.status = 'finished';
        session.messageCount = result.messageCount;
        session.finishedAt = new Date();
        session.finishReason = result.reason;
        console.log(
          `✅ セッション終了 [${videoId}]: ${result.reason} (${result.messageCount}件)`
        );
        break;
      }
      case 'log':
        console.log(`[${videoId}] ${msg.data}`);
        break;
    }
  });

  worker.on('error', (err) => {
    console.error(`❌ Worker エラー [${videoId}]:`, err);
    session.status = 'finished';
    session.finishedAt = new Date();
    session.finishReason = 'worker_error';
  });

  worker.on('exit', (code) => {
    if (session.status !== 'finished') {
      session.status = 'finished';
      session.finishedAt = new Date();
      session.finishReason = `worker_exit_${code}`;
    }
  });

  sessions.set(videoId, session);
  console.log(`🎬 録画開始: ${videoId}`);

  return session;
}

/**
 * 録画を停止する
 */
export function stopRecording(videoId: string): void {
  const session = sessions.get(videoId);
  if (!session) {
    throw new Error(`セッション ${videoId} が見つかりません`);
  }
  if (session.status !== 'recording') {
    throw new Error(`セッション ${videoId} は既に停止済みです`);
  }

  session.status = 'stopping';
  session.worker.postMessage('stop');
  console.log(`⏹️ 停止リクエスト送信: ${videoId}`);
}

/**
 * セッション情報を取得
 */
export function getSession(videoId: string): RecordingSession | undefined {
  return sessions.get(videoId);
}

/**
 * 全アクティブセッション一覧
 */
export function getAllSessions(): RecordingSession[] {
  return Array.from(sessions.values());
}

/**
 * セッション情報をシリアライズ可能な形式で返す
 */
export function serializeSession(
  session: RecordingSession
): Record<string, unknown> {
  return {
    videoId: session.videoId,
    status: session.status,
    messageCount: session.messageCount,
    startedAt: session.startedAt.toISOString(),
    finishedAt: session.finishedAt?.toISOString() || null,
    finishReason: session.finishReason || null,
  };
}
