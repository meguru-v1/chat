/**
 * pdfService.ts — 統計計算 & 日本語PDF生成エンジン v3.0
 *
 * - 総コメント数 & 配信タイトル表示
 * - 毎分チャット流速の計算 & ピーク時間帯特定
 * - 発言者ランキング TOP10
 * - テキストベース簡易グラフ（█ ブロック文字）
 * - カラー帯セクション区切り
 * - ページ番号フッター
 * - A4サイズ最適化レイアウト
 * - NotoSansJP フォント埋め込みで文字化け完全回避
 */
import PDFDocument from 'pdfkit';
import path from 'path';
import { ensureFont } from './utils/fontDownloader';

// ---------- 型定義 ----------
export interface IChatMessage {
  sessionId: string;
  messageId: string;
  timestamp: Date | string;
  authorName: string;
  message: string;
}

interface MinuteStats {
  /** "HH:MM" 形式 */
  time: string;
  count: number;
}

interface AuthorStats {
  name: string;
  count: number;
}

interface SessionStats {
  totalMessages: number;
  durationMinutes: number;
  minuteStats: MinuteStats[];
  peakMinute: MinuteStats;
  avgPerMinute: number;
  topAuthors: AuthorStats[];
}

// ---------- 統計計算 ----------

/** 日本時間 (JST) の Date オブジェクトまたは文字列を生成するヘルパー */
function toJST(date: Date | string | number): Date {
  const d = new Date(date);
  return new Date(d.getTime() + 9 * 60 * 60 * 1000);
}

/** HH:MM 形式の文字列を生成 (JST) */
function formatTimeJST(date: Date): string {
  const d = new Date(date.getTime());
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

function computeStats(messages: IChatMessage[]): SessionStats {
  if (messages.length === 0) {
    return {
      totalMessages: 0,
      durationMinutes: 0,
      minuteStats: [],
      peakMinute: { time: '--:--', count: 0 },
      avgPerMinute: 0,
      topAuthors: [],
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
  let binSizeMin = 1;
  if (totalMinutes > 300) binSizeMin = 15;
  else if (totalMinutes > 120) binSizeMin = 10;
  else if (totalMinutes > 40) binSizeMin = 5;
  
  const binMs = binSizeMin * 60 * 1000;

  // 3. 全スロット（等間隔）の生成 (JST基準)
  const minuteStats: MinuteStats[] = [];
  const startOfFirstBin = Math.floor(startMs / binMs) * binMs;
  
  for (let t = startOfFirstBin; t <= endMs; t += binMs) {
    const dStart = toJST(new Date(t));
    const dEnd = toJST(new Date(t + binMs - 1));
    
    minuteStats.push({
      time: `${formatTimeJST(dStart)}-${formatTimeJST(dEnd)}`,
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

  // 5. 発言者ランキング
  const authorCounts = new Map<string, number>();
  for (const msg of messages) {
    const name = msg.authorName || '不明';
    authorCounts.set(name, (authorCounts.get(name) || 0) + 1);
  }
  const topAuthors: AuthorStats[] = Array.from(authorCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    totalMessages: messages.length,
    durationMinutes: totalMinutes,
    minuteStats,
    peakMinute,
    avgPerMinute,
    topAuthors,
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
    const displayBar = barLen > 0 ? bar : '·';
    lines.push(
      `${stat.time.padEnd(12)} │${displayBar} ${stat.count}`
    );
  }

  return lines;
}

// ---------- PDF ヘルパー ----------

/** カラー帯セクション見出しを描画 */
function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, color: string = '#2563EB') {
  const y = doc.y;
  // 色付き帯を描画
  doc.save();
  doc.rect(50, y, doc.page.width - 100, 24).fill(color);
  doc.fillColor('#FFFFFF').fontSize(13).text(title, 58, y + 5, { width: doc.page.width - 116 });
  doc.restore();
  doc.fillColor('#000000');
  doc.y = y + 32;
}

// ---------- PDF 生成 ----------

export async function generatePdf(
  sessionId: string, 
  messages: IChatMessage[], 
  videoTitle: string = '不明なタイトル'
): Promise<Buffer> {
  // フォント準備
  const fontPath = await ensureFont();

  const stats = computeStats(messages);
  const graphLines = buildTextGraph(stats.minuteStats);

  // PDF 生成
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let pageNumber = 0;

    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: {
        Title: `チャットアーカイブ — ${videoTitle}`,
        Author: 'YouTube Chat Smart-Archiver v3.0',
      },
      bufferPages: true,
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // フォント登録
    doc.registerFont('NotoSansJP', fontPath);
    doc.font('NotoSansJP');

    // ======== ヘッダー ========
    // タイトル帯
    doc.save();
    doc.rect(0, 0, doc.page.width, 80).fill('#1E293B');
    doc.fillColor('#FFFFFF').fontSize(20)
      .text('📊 YouTube チャットアーカイブ レポート', 50, 18, { align: 'center' });
    doc.fontSize(11).fillColor('#94A3B8')
      .text(videoTitle, 50, 45, { align: 'center' });
    doc.restore();
    doc.fillColor('#000000');
    doc.y = 95;

    doc.fontSize(10).fillColor('#64748B')
      .text(`セッションID: ${sessionId}`, { align: 'center' });
    doc.text(
      `生成日時 (JST): ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
      { align: 'center' }
    );
    doc.fillColor('#000000');
    doc.moveDown(1);

    // ======== 統計セクション ========
    drawSectionHeader(doc, '📈 統計サマリー', '#2563EB');
    doc.moveDown(0.3);

    doc.fontSize(11);
    doc.text(`総コメント数:     ${stats.totalMessages.toLocaleString()} 件`);
    doc.text(`記録時間:         ${stats.durationMinutes} 分`);
    doc.text(`平均流速:         ${stats.avgPerMinute} 件/分`);
    doc.text(
      `🔥 ピーク時間帯:   ${stats.peakMinute.time} (${stats.peakMinute.count} 件)`
    );

    doc.moveDown(1);

    // ======== 発言者ランキング ========
    if (stats.topAuthors.length > 0) {
      drawSectionHeader(doc, '🏆 発言者ランキング TOP10', '#7C3AED');
      doc.moveDown(0.3);
      doc.fontSize(10);

      stats.topAuthors.forEach((author, i) => {
        const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`;
        const barLen = Math.round((author.count / stats.topAuthors[0].count) * 20);
        const bar = '█'.repeat(barLen);
        doc.text(`${medal} ${author.name.padEnd(20)} ${bar} ${author.count}件`);
      });

      doc.moveDown(1);
    }

    // ======== 流速グラフ ========
    drawSectionHeader(doc, '📊 タイムライン チャット密度', '#059669');
    doc.moveDown(0.3);

    doc.fontSize(8);
    for (const line of graphLines) {
      if (doc.y > doc.page.height - 80) {
        doc.addPage();
      }
      doc.text(line);
    }

    doc.moveDown(1);

    // ======== チャットログ ========
    doc.addPage();
    drawSectionHeader(doc, '💬 チャットログ', '#DC2626');
    doc.moveDown(0.3);

    doc.fontSize(9);

    for (const msg of messages) {
      const d = toJST(new Date(msg.timestamp));
      const h = String(d.getUTCHours()).padStart(2, '0');
      const m = String(d.getUTCMinutes()).padStart(2, '0');
      const s = String(d.getUTCSeconds()).padStart(2, '0');
      const timeStr = `${h}:${m}:${s}`;

      const line = `[${timeStr}] ${msg.authorName}: ${msg.message}`;

      if (doc.y > doc.page.height - 80) {
        doc.addPage();
      }

      doc.text(line, {
        width: doc.page.width - 100,
        lineGap: 2,
      });
    }

    // ======== ページ番号フッター ========
    const totalPages = doc.bufferedPageRange().count;
    for (let i = 0; i < totalPages; i++) {
      doc.switchToPage(i);
      doc.save();
      doc.fontSize(8).fillColor('#94A3B8')
        .text(
          `${i + 1} / ${totalPages}`,
          50, doc.page.height - 40,
          { align: 'center', width: doc.page.width - 100 }
        );
      doc.restore();
    }

    doc.end();
  });
}
