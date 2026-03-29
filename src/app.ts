/**
 * app.ts — Express API サーバー
 *
 * フロントエンドと連携するRESTful API。
 * チャット録画の開始/停止、セッション管理、PDF生成を提供。
 */
import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'path';
import {
  startRecording,
  stopRecording,
  getAllSessions,
  getSession,
  serializeSession,
} from './recorder';
import { generatePdf } from './pdfService';
import { ChatMessage } from './models/ChatMessage';
import { ensureFont } from './utils/fontDownloader';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGODB_URI =
  process.env.MONGODB_URI || 'mongodb://localhost:27017/chat-archiver';

// ミドルウェア
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ======== ヘルスチェック ========
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    mongoState: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
  });
});

// ======== 録画開始 ========
app.post('/api/record/start', (req: Request, res: Response) => {
  const { videoId } = req.body;

  if (!videoId || typeof videoId !== 'string') {
    res.status(400).json({ error: 'videoId は必須です' });
    return;
  }

  // videoId の簡易バリデーション（YouTube動画IDは通常11文字）
  const cleanId = videoId.trim();
  if (!/^[a-zA-Z0-9_-]{8,15}$/.test(cleanId)) {
    res.status(400).json({ error: '不正な videoId 形式です' });
    return;
  }

  try {
    const session = startRecording(cleanId, MONGODB_URI);
    res.json({
      message: `録画を開始しました: ${cleanId}`,
      session: serializeSession(session),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(409).json({ error: message });
  }
});

// ======== 録画停止 ========
app.post('/api/record/stop', (req: Request, res: Response) => {
  const { videoId } = req.body;

  if (!videoId || typeof videoId !== 'string') {
    res.status(400).json({ error: 'videoId は必須です' });
    return;
  }

  try {
    stopRecording(videoId.trim());
    res.json({ message: `停止リクエストを送信しました: ${videoId}` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});

// ======== アクティブセッション状態 ========
app.get('/api/record/status', (_req: Request, res: Response) => {
  const sessions = getAllSessions().map(serializeSession);
  res.json({ sessions });
});

// ======== 保存済みセッション一覧 ========
app.get('/api/sessions', async (_req: Request, res: Response) => {
  try {
    const sessions = await ChatMessage.aggregate([
      {
        $group: {
          _id: '$sessionId',
          messageCount: { $sum: 1 },
          firstMessage: { $min: '$timestamp' },
          lastMessage: { $max: '$timestamp' },
        },
      },
      { $sort: { firstMessage: -1 } },
    ]);

    const result = sessions.map((s) => ({
      sessionId: s._id,
      messageCount: s.messageCount,
      firstMessage: s.firstMessage,
      lastMessage: s.lastMessage,
    }));

    res.json({ sessions: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// ======== PDF生成 & ダウンロード ========
app.get('/api/sessions/:id/pdf', async (req: Request, res: Response) => {
  const sessionId = req.params.id as string;

  try {
    const pdfBuffer = await generatePdf(sessionId);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="chat-archive-${sessionId}.pdf"`,
      'Content-Length': String(pdfBuffer.length),
    });

    res.send(pdfBuffer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});

// ======== サーバー起動 ========
async function bootstrap(): Promise<void> {
  console.log('🔌 MongoDB に接続中...');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ MongoDB 接続完了');

  // フォントを事前にダウンロード
  await ensureFont();

  app.listen(PORT, () => {
    console.log(`🚀 Chat Archiver API サーバー起動: http://localhost:${PORT}`);
    console.log(`   ヘルスチェック: http://localhost:${PORT}/health`);
    console.log('');
    console.log('📖 使い方:');
    console.log(
      `   録画開始: POST /api/record/start { "videoId": "VIDEO_ID" }`
    );
    console.log(
      `   録画停止: POST /api/record/stop  { "videoId": "VIDEO_ID" }`
    );
    console.log(`   状態確認: GET  /api/record/status`);
    console.log(`   セッション一覧: GET  /api/sessions`);
    console.log(`   PDF取得:  GET  /api/sessions/:id/pdf`);
  });
}

bootstrap().catch((err) => {
  console.error('❌ 起動エラー:', err);
  process.exit(1);
});
