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

  // 1. 配信時間（開始〜終了）の特定
  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  const startMs = new Date(firstMsg.timestamp).getTime();
  const endMs = new Date(lastMsg.timestamp).getTime();
  const totalDurationMs = endMs - startMs;
  const totalMinutes = Math.max(1, Math.ceil(totalDurationMs / (60 * 1000)));

  // 2. 最適な集計単位 (binSize) の決定
  // グラフが 30〜40行程度に収まるように調整
  let binSizeMin = 1;
  if (totalMinutes > 300) binSizeMin = 15;      // 5時間超え
  else if (totalMinutes > 120) binSizeMin = 10; // 2時間〜5時間
  else if (totalMinutes > 40) binSizeMin = 5;   // 40分〜2時間
  
  const binMs = binSizeMin * 60 * 1000;

  // 3. 全スロット（等間隔）の生成
  const minuteStats: MinuteStats[] = [];
  const startOfFirstBin = Math.floor(startMs / binMs) * binMs;
  
  for (let t = startOfFirstBin; t <= endMs; t += binMs) {
    const d = new Date(t);
    const dEnd = new Date(t + binMs - 1);
    const timeLabel = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const endLabel = `${String(dEnd.getHours()).padStart(2, '0')}:${String(dEnd.getMinutes()).padStart(2, '0')}`;
    
    minuteStats.push({
      time: `${timeLabel}-${endLabel}`,
      count: 0
    });
  }

  // 4. メッセージをスロットに振り分け
  for (const msg of messages) {
    const msgTs = new Date(msg.timestamp).getTime();
    const binIndex = Math.floor((msgTs - startOfFirstBin) / binMs);
    if (binIndex >= 0 && binIndex < minuteStats.length) {
      minuteStats[binIndex].count++;
    }
  }

  // ピーク特定
  const peakMinute = minuteStats.reduce(
    (max, cur) => (cur.count > max.count ? cur : max),
    minuteStats[0]
  );

  const avgPerMinute = Math.round(messages.length / totalMinutes);

  return {
    totalMessages: messages.length,
    durationMinutes: totalMinutes,
    minuteStats,
    peakMinute,
    avgPerMinute,
  };
}

// ---------- テキストベースグラフ生成 ----------

function buildTextGraph(
  minuteStats: MinuteStats[],
  maxBarWidth: number = 30
): string[] {
  if (minuteStats.length === 0) return ['データなし'];

  const maxCount = Math.max(...minuteStats.map((s) => s.count));
  const lines: string[] = [];

  for (const stat of minuteStats) {
    const barLen = maxCount > 0 ? Math.round((stat.count / maxCount) * maxBarWidth) : 0;
    const bar = '█'.repeat(barLen);
    // 0件の場合は小さな点、ある場合はブロック
    const displayBar = barLen > 0 ? bar : '·';
    lines.push(
      `${stat.time.padEnd(12)} │${displayBar} ${stat.count}`
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

  // 0件でもエラーにせず、統計計算へ進む（空の統計が生成される）
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
