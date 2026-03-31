/**
 * standalone-recorder.ts — スタンドアロン録画スクリプト (Puppeteer + Database-less版)
 *
 * 使い方:
 *   npx ts-node src/standalone-recorder.ts --video-id [VIDEO_ID] --timeout [MINUTES]
 */
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { generatePdf, IChatMessage } from './pdfService';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// ---------- 引数解析 ----------
const args = process.argv.slice(2);
const videoId = getArgValue('--video-id') || '';
const timeoutMinutes = parseInt(getArgValue('--timeout') || '360', 10);

function getArgValue(name: string): string | undefined {
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
const messages: IChatMessage[] = [];
const startTime = Date.now();
const maxWaitMs = timeoutMinutes * 60 * 1000;

// ---------- メイン録画ロジック (ブラウザ方式) ----------

async function startRecording() {
  console.log(`🚀 ライブチャット監視を開始します (Zero-DB Mode / Puppeteer)`);
  console.log(`🎥 Video ID: ${videoId}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const chatUrl = `https://www.youtube.com/live_chat?v=${videoId}`;
    await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('✅ チャットページを読み込みました。監視を開始します。');

    await page.exposeFunction('onNewMessage', async (msg: any) => {
      if (isStopping) return;
      
      const newMessage: IChatMessage = {
        sessionId: videoId,
        messageId: msg.id,
        timestamp: new Date(msg.timestampUsec / 1000),
        authorName: msg.author,
        message: msg.text
      };

      // 重複チェック (ID)
      if (!messages.find(m => m.messageId === msg.id)) {
        messages.push(newMessage);
        messageCount++;
        
        if (messageCount % 20 === 0 || messageCount === 1) {
          console.log(`📡 [${new Date().toLocaleTimeString()}] +${messageCount} 件記録中... (最新: ${msg.author})`);
        }
      }
    });

    await page.evaluate(() => {
      const processElement = (el: any) => {
        const id = el.getAttribute('id');
        const author = el.querySelector('#author-name')?.textContent || 'Unknown';
        const text = el.querySelector('#message')?.textContent || '';
        const timestampUsec = el.data?.timestampUsec || Date.now() * 1000;
        
        if (id && text) {
          (window as any).onNewMessage({ id, author, text, timestampUsec });
        }
      };

      const collectExisting = () => {
        const items = document.querySelectorAll('yt-live-chat-text-message-renderer');
        items.forEach((item: any) => processElement(item));
      };

      collectExisting();

      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          mutation.addedNodes.forEach((node: any) => {
            if (node.nodeName === 'YT-LIVE-CHAT-TEXT-MESSAGE-RENDERER') {
              processElement(node);
            }
          });
        }
      });

      const container = document.querySelector('#items.yt-live-chat-item-list-renderer');
      if (container) {
        observer.observe(container, { childList: true });
      }
    });

    while (!isStopping) {
      if (Date.now() - startTime >= maxWaitMs) {
        await finish('timeout');
        break;
      }
      if (page.isClosed()) {
        await finish('browser_closed');
        break;
      }
      await new Promise(r => setTimeout(r, 10000));
    }

  } catch (err: any) {
    console.error(`❌ 致命的なエラー: ${err.message}`);
    await finish('fatal_error');
  } finally {
    if (browser) await browser.close();
  }
}

async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;
  console.log(`🏁 録画を終了します。原因: ${reason}`);
  console.log(`📊 合計メッセージ数: ${messageCount}`);

  if (messages.length === 0) {
    console.warn('⚠️ メッセージが記録されなかったため、終了します。');
    process.exit(0);
  }

  // 時系列順にソート（初期バッファ対策）
  messages.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  try {
    console.log('📄 PDFレポートを作成中...');
    const pdfBuffer = await generatePdf(videoId, messages);
    
    // 保存先の確保
    const reportsDir = path.join(__dirname, '../public/reports');
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
    
    const pdfFileName = `${videoId}_${Date.now()}.pdf`;
    const pdfPath = path.join(reportsDir, pdfFileName);
    fs.writeFileSync(pdfPath, pdfBuffer);
    console.log(`✅ PDF保存完了: ${pdfPath}`);

    // 履歴 (sessions.json) の更新
    updateSessionsJson(videoId, pdfFileName, messages.length);

  } catch (err: any) {
    console.error(`❌ PDF生成エラー: ${err.message}`);
  }

  console.log('👋 全工程が終了しました。');
  process.exit(0);
}

function updateSessionsJson(vid: string, fileName: string, count: number) {
  const sessionsPath = path.join(__dirname, '../public/sessions.json');
  let sessions = [];
  
  if (fs.existsSync(sessionsPath)) {
    try {
      sessions = JSON.parse(fs.readFileSync(sessionsPath, 'utf-8'));
    } catch (e) {
      sessions = [];
    }
  }

  const newSession = {
    videoId: vid,
    pdfPath: `reports/${fileName}`,
    date: new Date().toISOString(),
    messageCount: count
  };

  sessions.unshift(newSession);
  // 直近 50 件程度を保持
  sessions = sessions.slice(0, 50);

  fs.writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2));
  console.log('✅ sessions.json を更新しました。');
}

// ---------- 開始 ----------
startRecording();
