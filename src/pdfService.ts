/**
 * pdfService.ts — 統計計算 & 日本語PDF生成エンジン
 *
 * - 総コメント数
 * - 毎分チャット流速の計算 & ピーク時間帯特定
 * - テキストベース簡易グラフ（█ ブロック文字）
 * - A4サイズ最適化レイアウト
 * - NotoSansJP フォント埋め込みで文字化け完全回避
 */
import PDFDocument from 'pdfkit';
import path from 'path';
import { ChatMessage, IChatMessage } from './models/ChatMessage';
import { ensureFont } from './utils/fontDownloader';

// ---------- 型定義 ----------
interface MinuteStats {
  /** "HH:MM" 形式 */
  time: string;
  count: number;
}

interface SessionStats {
  totalMessages: number;
  durationMinutes: number;
  minuteStats: MinuteStats[];
  peakMinute: MinuteStats;
  avgPerMinute: number;
}

// ---------- 統計計算 ----------

function computeStats(messages: IChatMessage[]): SessionStats {
  if (messages.length === 0) {
    return {
      totalMessages: 0,
      durationMinutes: 0,
      minuteStats: [],
      peakMinute: { time: '--:--', count: 0 },
      avgPerMinute: 0,
    };
  }

  // 毎分ごとのカウント集計
  const minuteMap = new Map<string, number>();

  for (const msg of messages) {
    const d = new Date(msg.timestamp);
    const key = `${String(d.getHours()).padStart(2, '0')}:${String(
      d.getMinutes()
    ).padStart(2, '0')}`;
    minuteMap.set(key, (minuteMap.get(key) || 0) + 1);
  }

  // 時系列ソート
  const minuteStats: MinuteStats[] = Array.from(minuteMap.entries())
    .map(([time, count]) => ({ time, count }))
    .sort((a, b) => a.time.localeCompare(b.time));

  // ピーク特定
  const peakMinute = minuteStats.reduce(
    (max, cur) => (cur.count > max.count ? cur : max),
    minuteStats[0]
  );

  const durationMinutes = minuteStats.length;
  const avgPerMinute =
    durationMinutes > 0
      ? Math.round(messages.length / durationMinutes)
      : 0;

  return {
    totalMessages: messages.length,
    durationMinutes,
    minuteStats,
    peakMinute,
    avgPerMinute,
  };
}

// ---------- テキストベースグラフ生成 ----------

function buildTextGraph(
  minuteStats: MinuteStats[],
  maxBarWidth: number = 40
): string[] {
  if (minuteStats.length === 0) return ['データなし'];

  const maxCount = Math.max(...minuteStats.map((s) => s.count));
  const lines: string[] = [];

  for (const stat of minuteStats) {
    const barLen =
      maxCount > 0 ? Math.round((stat.count / maxCount) * maxBarWidth) : 0;
    const bar = '█'.repeat(barLen);
    lines.push(
      `${stat.time} │${bar} ${stat.count}`
    );
  }

  return lines;
}

// ---------- PDF 生成 ----------

export async function generatePdf(sessionId: string): Promise<Buffer> {
  // フォント準備
  const fontPath = await ensureFont();

  // メッセージ取得（時系列順）
  const messages = await ChatMessage.find({ sessionId })
    .sort({ timestamp: 1 })
    .lean<IChatMessage[]>();

  if (messages.length === 0) {
    throw new Error(`セッション ${sessionId} のメッセージが見つかりません`);
  }

  // 統計計算
  const stats = computeStats(messages as IChatMessage[]);
  const graphLines = buildTextGraph(stats.minuteStats);

  // PDF 生成
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 50, left: 50, right: 50 },
      info: {
        Title: `チャットアーカイブ — ${sessionId}`,
        Author: 'YouTube Chat Smart-Archiver',
      },
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // フォント登録
    doc.registerFont('NotoSansJP', fontPath);
    doc.font('NotoSansJP');

    // ======== ヘッダー ========
    doc
      .fontSize(22)
      .text('📊 YouTube チャットアーカイブ レポート', { align: 'center' });

    doc.moveDown(0.5);
    doc.fontSize(12).text(`セッションID: ${sessionId}`, { align: 'center' });
    doc.text(
      `生成日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
      { align: 'center' }
    );

    doc.moveDown(1);

    // ======== 統計セクション ========
    doc
      .fontSize(16)
      .text('── 統計サマリー ──', { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(11);
    doc.text(`総コメント数:     ${stats.totalMessages.toLocaleString()} 件`);
    doc.text(`記録時間:         ${stats.durationMinutes} 分`);
    doc.text(`平均流速:         ${stats.avgPerMinute} 件/分`);
    doc.text(
      `🔥 ピーク時間:     ${stats.peakMinute.time} (${stats.peakMinute.count} 件/分)`
    );

    doc.moveDown(1);

    // ======== 流速グラフ ========
    doc
      .fontSize(16)
      .text('── 毎分チャット流速グラフ ──', { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(8);
    for (const line of graphLines) {
      doc.text(line);
    }

    doc.moveDown(1);

    // ======== チャットログ ========
    doc.addPage();
    doc
      .fontSize(16)
      .text('── チャットログ ──', { underline: true });
    doc.moveDown(0.5);

    doc.fontSize(9);

    for (const msg of messages) {
      const d = new Date(msg.timestamp);
      const timeStr = d.toLocaleTimeString('ja-JP', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZone: 'Asia/Tokyo',
      });

      const line = `[${timeStr}] ${msg.authorName}: ${msg.message}`;

      // ページ下端チェック（余白50pt + フッター用30pt）
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
      }

      doc.text(line, {
        width: doc.page.width - 100,
        lineGap: 2,
      });
    }

    doc.end();
  });
}
