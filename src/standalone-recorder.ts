/**
 * standalone-recorder.ts — スタンドアロン録画スクリプト (Puppeteer版)
 *
 * 使い方:
 *   npx ts-node src/standalone-recorder.ts --video-id [VIDEO_ID] --timeout [MINUTES]
 */
import 'dotenv/config';
import mongoose from 'mongoose';
import { ChatMessage } from './models/ChatMessage';
import { generatePdf } from './pdfService';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

// ---------- 引数解析 ----------
const args = process.argv.slice(2);
const videoId = getArgValue('--video-id') || '';
const timeoutMinutes = parseInt(getArgValue('--timeout') || '360', 10);
const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/chat-archiver';

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
const startTime = Date.now();
const maxWaitMs = timeoutMinutes * 60 * 1000;

// ---------- メイン録画ロジック (ブラウザ方式) ----------

async function startRecording() {
  console.log(`🚀 ライブチャット監視を開始します (Browser Mode / Puppeteer)`);
  console.log(`🎥 Video ID: ${videoId}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true, // Actions では true (安定)
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
    
    // 不要なリソースをブロックして軽量化
    await page.setRequestInterception(true);
    page.on('request', (req: any) => {
      if (['image', 'font', 'stylesheet', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // チャット専用ページへ移動
    const chatUrl = `https://www.youtube.com/live_chat?v=${videoId}`;
    await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('✅ チャットページを読み込みました。監視を開始します。');

    // ブラウザ内からのメッセージを受け取る関数を公開
    await page.exposeFunction('onNewMessage', async (msg: any) => {
      if (isStopping) return;
      
      try {
        await ChatMessage.insertMany([{
          sessionId: videoId,
          messageId: msg.id,
          timestamp: new Date(msg.timestampUsec / 1000), // 微秒 -> ミリ秒
          authorName: msg.author,
          message: msg.text
        }], { ordered: false }).catch(err => {
            // 重複エラー(11000)は無視
            if (err.code !== 11000) console.error(`❌ DB保存エラー: ${err.message}`);
        });

        messageCount++;
        if (messageCount % 20 === 0 || messageCount === 1) {
          console.log(`📡 [${new Date().toLocaleTimeString()}] +${messageCount} 件記録中... (最新: ${msg.author})`);
        }
      } catch (e: any) {
        console.error('❌ メッセージ処理エラー:', e.message);
      }
    });

    // ブラウザ内でチャットDOMを監視するスクリプトを実行
    await page.evaluate(() => {
      // 初期バッファの回収
      const collectExisting = () => {
        const items = document.querySelectorAll('yt-live-chat-text-message-renderer');
        items.forEach((item: any) => processElement(item));
      };

      const processElement = (el: any) => {
        const id = el.getAttribute('id');
        const author = el.querySelector('#author-name')?.textContent || 'Unknown';
        const text = el.querySelector('#message')?.textContent || '';
        const timestampUsec = el.data?.timestampUsec || Date.now() * 1000;
        
        if (id && text) {
          (window as any).onNewMessage({ id, author, text, timestampUsec });
        }
      };

      // 1. まず初期表示分を拾う
      collectExisting();

      // 2. 以降、新着を監視
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
      } else {
        console.error('❌ チャットコンテナが見つかりません');
      }
    });

    // 終了判定ループ
    while (!isStopping) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= maxWaitMs) {
        console.log(`⏰ 設定されたタイムアウト (${timeoutMinutes}分) に達しました。終了します。`);
        await finish('timeout');
        break;
      }

      // 接続が切れていないかチェック
      if (page.isClosed()) {
        console.error('❌ ブラウザが閉じられました');
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

  try {
    console.log('📄 PDFレポートを作成中...');
    const pdfPath = await generatePdf(videoId);
    console.log(`✅ PDF作成完了: ${pdfPath}`);
  } catch (err: any) {
    console.error(`❌ PDF生成エラー: ${err.message}`);
  }

  // DB切断
  await mongoose.disconnect();
  console.log('👋 終了しました。');
  process.exit(0);
}

// ---------- 接続と開始 ----------
mongoose.connect(mongoUri)
  .then(() => {
    console.log('✅ MongoDB 接続成功');
    startRecording();
  })
  .catch(err => {
    console.error('❌ MongoDB 接続失敗:', err.message);
    process.exit(1);
  });
