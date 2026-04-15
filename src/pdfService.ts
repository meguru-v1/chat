/**
 * pdfService.ts — 統計計算 & 日本語PDF生成エンジン v3.2
 *
 * - 総コメント数 & 配信タイトル表示
 * - 毎分チャット流速の計算 & ピーク時間帯特定
 * - 発言者ランキング TOP10
 * - スパチャ (SuperChat) の記録と一覧表示
 * - ベクター描画による美しいタイムライン折れ線グラフ
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
  superChatAmount?: string; // スパチャ金額
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

interface SuperChatLog {
  timeStr: string;
  authorName: string;
  amount: string;
  message: string;
}

interface SessionStats {
  totalMessages: number;
  durationMinutes: number;
  minuteStats: MinuteStats[];
  peakMinute: MinuteStats;
  avgPerMinute: number;
  topAuthors: AuthorStats[];
  superChats: SuperChatLog[];
}

// ---------- 共通ヘルパー ---------- //

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

/** HH:MM:SS 形式の文字列を生成 (JST) */
function formatTimeFullJST(date: Date): string {
  const d = new Date(date.getTime());
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}:${m}:${s}`;
}

/** PDFで文字化け（豆腐）になる絵文字や特殊文字を削除するヘルパー */
function cleanTextForPdf(str: string): string {
  if (!str) return '';
  return str
    .replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '') // サロゲートペア（大半の絵文字等）
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, '')       // 制御文字
    .replace(/[\u200B-\u200D\uFEFF]/g, '');         // ゼロ幅文字
}

// ---------- 統計計算 ---------- //

function computeStats(messages: IChatMessage[]): SessionStats {
  if (messages.length === 0) {
    return {
      totalMessages: 0,
      durationMinutes: 0,
      minuteStats: [],
      peakMinute: { time: '--:--', count: 0 },
      avgPerMinute: 0,
      topAuthors: [],
      superChats: [],
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

  // 4. メッセージをスロットに振り分け & スパチャ抽出
  const superChats: SuperChatLog[] = [];
  const authorCounts = new Map<string, number>();

  for (const msg of messages) {
    const msgTs = new Date(msg.timestamp).getTime();
    const binIndex = Math.floor((msgTs - startOfFirstBin) / binMs);
    if (binIndex >= 0 && binIndex < minuteStats.length) {
      minuteStats[binIndex].count++;
    }

    // 発言者集計
    const name = msg.authorName || '不明';
    authorCounts.set(name, (authorCounts.get(name) || 0) + 1);

    // スパチャ抽出
    if (msg.superChatAmount) {
      superChats.push({
        timeStr: formatTimeFullJST(toJST(msg.timestamp)),
        authorName: name,
        amount: String(msg.superChatAmount),
        message: msg.message || ''
      });
    }
  }

  // ✅ バグ修正: minuteStats が空の場合 reduce が undefined を返すクラッシュを暲止
  const peakMinute: MinuteStats = minuteStats.length > 0
    ? minuteStats.reduce((max, cur) => (cur.count > max.count ? cur : max), minuteStats[0])
    : { time: '--:--', count: 0 };
  
  // ✅ バグ修正: totalMinutes が 0 の場合、avgPerMinute が Infinity になる
  const avgPerMinute = totalMinutes > 0 ? Math.round(messages.length / totalMinutes) : 0;

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
    superChats,
  };
}


// ---------- PDF お絵描きヘルパー ---------- //

/** カラー帯セクション見出しを描画 */
function drawSectionHeader(doc: PDFKit.PDFDocument, title: string, color: string = '#2563EB') {
  // 自動改ページを一時オフにして高さ不足時の描画崩れを防ぐ
  if (doc.y > doc.page.height - 100) {
    doc.addPage();
  }
  const y = doc.y;
  doc.save();
  doc.rect(50, y, doc.page.width - 100, 24).fill(color);
  doc.fillColor('#FFFFFF').fontSize(13).text(title, 58, y + 5, { width: doc.page.width - 116 });
  doc.restore();
  doc.fillColor('#000000');
  doc.y = y + 36;
}

/** ベクターの折れ線グラフを描画 */
function drawVectorGraph(doc: PDFKit.PDFDocument, minuteStats: MinuteStats[]) {
  if (minuteStats.length < 2) {
    doc.fontSize(10).fillColor('#334155')
       .text('録画時間が短いため、グラフを描画できません。');
    return;
  }

  const startY = doc.y;
  const width = doc.page.width - 100;
  const height = 150;
  const maxCount = Math.max(...minuteStats.map(s => s.count), 1);
  const xStep = width / (minuteStats.length - 1);
  
  // 背景の横グラデーション線
  doc.lineWidth(0.5).strokeColor('#E2E8F0');
  for (let i = 0; i <= 4; i++) {
    const ly = startY + height - (height * (i / 4));
    doc.moveTo(50, ly).lineTo(50 + width, ly).stroke();
    // y軸ラベル (左側)
    doc.fontSize(8).fillColor('#94A3B8').text(String(Math.round(maxCount * (i / 4))), 25, ly - 3, { width: 20, align: 'right' });
  }

  // X軸のラベル (最初、真ん中、最後)
  doc.fontSize(8).fillColor('#94A3B8');
  doc.text(minuteStats[0].time.split('-')[0], 50, startY + height + 5);
  doc.text(minuteStats[Math.floor(minuteStats.length/2)].time.split('-')[0], 50 + width/2 - 15, startY + height + 5, {width: 30, align: 'center'});
  doc.text(minuteStats[minuteStats.length-1].time.split('-')[1], 50 + width - 30, startY + height + 5, {width: 30, align: 'right'});

  // 折れ線描画用のパスを作成
  let points: {x: number, y: number}[] = [];
  minuteStats.forEach((stat, i) => {
    const px = 50 + i * xStep;
    const py = startY + height - (stat.count / maxCount) * height;
    points.push({x: px, y: py});
  });

  // グラデーション風の塗りつぶし (線のしたを薄い色で塗る)
  doc.save();
  doc.moveTo(points[0].x, startY + height);
  points.forEach(p => doc.lineTo(p.x, p.y));
  doc.lineTo(points[points.length - 1].x, startY + height);
  doc.fillColor('#10B981').fillOpacity(0.15).fill();
  doc.restore();

  // 実線
  doc.save();
  doc.lineWidth(2).strokeColor('#10B981');
  doc.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    doc.lineTo(points[i].x, points[i].y);
    doc.circle(points[i].x, points[i].y, 1).fillAndStroke('#10B981', '#10B981'); // 点を少し強調
  }
  doc.circle(points[0].x, points[0].y, 1).fillAndStroke('#10B981', '#10B981');
  doc.stroke();
  doc.restore();

  doc.y = startY + height + 25;
}


// ---------- PDF 生成 ルート ---------- //

export async function generatePdf(
  sessionId: string, 
  rawMessages: IChatMessage[], 
  rawVideoTitle: string = '不明なタイトル'
): Promise<Buffer> {
  // PDFの文字化けを防ぐため、事前に絵文字等の非対応文字をすべて削除
  const videoTitle = cleanTextForPdf(rawVideoTitle);
  const messages = rawMessages.map(m => ({
    ...m,
    authorName: cleanTextForPdf(m.authorName),
    message: cleanTextForPdf(m.message)
  }));

  const fontPath = await ensureFont();
  const stats = computeStats(messages);

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 50, bottom: 60, left: 50, right: 50 },
      info: {
        Title: `チャットアーカイブ — ${videoTitle}`,
        Author: 'YouTube Chat Smart-Archiver',
      },
      bufferPages: true,
    });

    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('NotoSansJP', fontPath);
    doc.font('NotoSansJP');

    // ======== ヘッダー ========
    doc.save();
    doc.rect(0, 0, doc.page.width, 80).fill('#1E293B');
    doc.fillColor('#FFFFFF').fontSize(20)
      .text('[ YouTube チャットアーカイブ レポート ]', 50, 18, { align: 'center' });
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
    drawSectionHeader(doc, '[ 統計サマリー ]', '#2563EB');
    doc.fontSize(11).fillColor('#334155');
    doc.text(`総コメント数:     ${stats.totalMessages.toLocaleString()} 件`);
    doc.text(`記録時間:         ${stats.durationMinutes} 分`);
    doc.text(`平均流速:         ${stats.avgPerMinute} 件/分`);
    doc.text(`ピーク時間帯:     ${stats.peakMinute.time} (${stats.peakMinute.count} 件)`);
    doc.moveDown(1);

    // ======== 流速グラフ (ベクター) ========
    if (stats.minuteStats.length > 0) {
      drawSectionHeader(doc, '[ タイムライン チャット密度 ]', '#059669');
      drawVectorGraph(doc, stats.minuteStats);
      doc.moveDown(1);
    }

    // ======== スパチャ一覧 ========
    if (stats.superChats.length > 0) {
      drawSectionHeader(doc, '[ スーパーチャット一覧 ]', '#D97706');
      doc.fontSize(9).fillColor('#334155');
      
      const colX1 = 50;
      const colX2 = 110;
      const colX3 = 210;
      const colX4 = 280;
      
      // Header
      doc.font('NotoSansJP').fontSize(9).fillColor('#94A3B8');
      doc.text('時間', colX1, doc.y, { continued: false });
      doc.text('発言者', colX2, doc.y - doc.currentLineHeight(), { continued: false });
      doc.text('金額', colX3, doc.y - doc.currentLineHeight(), { continued: false });
      doc.text('メッセージ', colX4, doc.y - doc.currentLineHeight(), { continued: false });
      doc.moveTo(50, doc.y).lineTo(doc.page.width - 50, doc.y).strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.y += 5;

      doc.fillColor('#334155');
      for (const sc of stats.superChats) {
        if (doc.y > doc.page.height - 80) doc.addPage();
        const startY = doc.y;
        
        doc.text(sc.timeStr, colX1, startY, { width: 50 });
        doc.text(sc.authorName, colX2, startY, { width: 90 });
        doc.fillColor('#D97706').text(sc.amount, colX3, startY, { width: 60 }).fillColor('#334155');
        
        // メッセージが長い場合は折り返すが、次の行との間隔を計算する
        doc.text(sc.message, colX4, startY, { width: doc.page.width - colX4 - 50 });
        doc.y += 5; // spacing
      }
      doc.moveDown(1);
    }

    // ======== 発言者ランキング ========
    if (stats.topAuthors.length > 0) {
      drawSectionHeader(doc, '[ 発言者ランキング TOP10 ]', '#7C3AED');
      doc.fontSize(10).fillColor('#334155');

      stats.topAuthors.forEach((author, i) => {
        const medal = i === 0 ? '[1]' : i === 1 ? '[2]' : i === 2 ? '[3]' : ` ${i + 1}.`;
        // ✅ バグ修正: topAuthors[0].count が 0 の時のゼロ除算を防止
        const maxCount = stats.topAuthors[0].count || 1;
        const barLen = Math.round((author.count / maxCount) * 20);
        const bar = '█'.repeat(Math.max(0, barLen));
        doc.text(`${medal} ${author.name.padEnd(20)} ${bar} ${author.count}件`);
      });
      doc.moveDown(1);
    }

    // ======== チャットログ ========
    doc.addPage();
    drawSectionHeader(doc, '[ チャットログ ]', '#DC2626');
    doc.fontSize(9).fillColor('#475569');

    for (const msg of messages) {
      if (doc.y > doc.page.height - 60) doc.addPage();
      const timeStr = formatTimeFullJST(toJST(msg.timestamp));
      
      // スパチャ行は色を変える
      if (msg.superChatAmount) {
        doc.fillColor('#B45309').text(`[${timeStr}] ${msg.authorName} (${msg.superChatAmount}): ${msg.message}`);
        doc.fillColor('#475569'); // 戻す
      } else {
        doc.text(`[${timeStr}] ${msg.authorName}: ${msg.message}`);
      }
    }

    // ======== ページ番号フッター ========
    doc.flushPages();
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
