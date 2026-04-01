/**
 * standalone-recorder.ts (Hybrid v2.3)
 * 
 * 起動時にブラウザ(Puppeteer)で過去ログを回収し、
 * その後 API(v3) で安定録画を継続するハイブリッド構成。
 */

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { generatePdf } from './pdfService';

puppeteer.use(StealthPlugin());

// ---------- 設定 ----------
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60分

// 引数
const args = process.argv.slice(2);
const videoIdArg = args.find(a => a.startsWith('--video-id='))?.split('=')[1];
const timeoutArg = args.find(a => a.startsWith('--timeout='))?.split('=')[1];

if (!videoIdArg) {
  process.exit(1);
}
const videoId = videoIdArg;
const maxWaitMs = parseInt(timeoutArg || '360', 10) * 60 * 1000;

// ---------- 状態管理 ----------
let messages: any[] = [];
let isStopping = false;
let pollTimeout: NodeJS.Timeout | null = null;
let idleTimer: NodeJS.Timeout | null = null;
const startTime = Date.now();
const seenMessageKeys = new Set<string>();

/** メッセージを重複排除して追加 */
function addMessages(newMsgs: any[]) {
  for (const m of newMsgs) {
    const key = `${m.authorName}:${m.message}:${new Date(m.timestamp).getTime()}`;
    if (!seenMessageKeys.has(key)) {
      seenMessageKeys.add(key);
      messages.push(m);
    }
  }
}

/** 1. ブラウザで初期の「過去ログ」を吸い出す */
async function scrapeInitialHistory(vId: string) {
  console.log('🌐 ブラウザを起動して過去ログを回収中...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--lang=ja-JP']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    // チャット画面へ
    const chatUrl = `https://www.youtube.com/live_chat?v=${vId}`;
    await page.goto(chatUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // チャット欄が出るまで少し待つ
    await page.waitForSelector('#items.yt-live-chat-item-list-renderer', { timeout: 10000 }).catch(() => {});
    
    // 過去ログをスクレイピング
    const initialMsgs = await page.evaluate(() => {
        const items = document.querySelectorAll('yt-live-chat-text-message-renderer');
        return Array.from(items).map(item => {
            const authorName = item.querySelector('#author-name')?.textContent?.trim() || '不明';
            const message = item.querySelector('#message')?.textContent?.trim() || '';
            const timestampText = item.querySelector('#timestamp')?.textContent?.trim() || '';
            
            // 時刻の簡易パース (例: "12:34" -> 今日のその時刻)
            let timestamp = new Date();
            if (timestampText.includes(':')) {
                const [hh, mm] = timestampText.split(':').map(Number);
                timestamp.setHours(hh, mm, 0, 0);
            }
            return { authorName, message, timestamp: timestamp.toISOString() };
        }).filter(m => m.message);
    });

    console.log(`✅ ブラウザから ${initialMsgs.length} 件の過去ログを回収しました。`);
    addMessages(initialMsgs);

  } catch (err: any) {
    console.warn(`⚠️ ブラウザ過去ログ取得中にエラー（スキップします）: ${err.message}`);
  } finally {
    await browser.close();
    console.log('🌐 ブラウザを終了しました。API 録画に切り替えます。');
  }
}

/** 2. API 録画ループ (v3) */
async function getLiveChatId(vid: string, key: string): Promise<string> {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${vid}&key=${key}`;
  const res = await axios.get(url);
  const details = res.data.items?.[0]?.liveStreamingDetails;
  if (!details?.activeLiveChatId) throw new Error('LiveChatIdが見つかりません');
  return details.activeLiveChatId;
}

async function pollChat(liveChatId: string, key: string, pageToken?: string) {
  if (isStopping) return;
  if (Date.now() - startTime >= maxWaitMs) return finish('max_duration');

  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=2000&key=${key}`;
  if (pageToken) url += `&pageToken=${pageToken}`;

  try {
    const res = await axios.get(url);
    if (idleTimer) resetIdleTimer();

    const data = res.data;
    if (data.items) {
      const newMsgs = data.items.map((item: any) => ({
        sessionId: videoId,
        messageId: item.id || '',
        authorName: item.authorDetails.displayName || '不明',
        message: item.snippet.displayMessage || '',
        timestamp: item.snippet.publishedAt
      }));
      addMessages(newMsgs);
      console.log(`🎙️ 録画中 (合計: ${messages.length}件)`);
    }

    pollTimeout = setTimeout(() => {
      pollChat(liveChatId, key, data.nextPageToken);
    }, data.pollingIntervalMillis || 10000);

  } catch (err: any) {
    if (err.response?.status === 403 || err.response?.status === 404) return finish('stream_ended');
    pollTimeout = setTimeout(() => pollChat(liveChatId, key, pageToken), 10000);
  }
}

// ---------- 終了 & 共通処理 ----------
function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => finish('idle_timeout'), IDLE_TIMEOUT_MS);
}

async function finish(reason: string) {
  if (isStopping) return;
  isStopping = true;
  if (pollTimeout) clearTimeout(pollTimeout);
  if (idleTimer) clearTimeout(idleTimer);

  console.log(`🏁 録画終了 (${reason}) - ${messages.length}件`);
  if (messages.length > 0) {
    const pdfPath = `public/reports/${videoId}.pdf`;
    const fullPath = path.join(__dirname, '..', pdfPath);
    try {
      const pdfBuffer = await generatePdf(videoId, messages);
      fs.writeFileSync(fullPath, pdfBuffer);
      updateHistory(videoId, messages.length, pdfPath);
      console.log(`✅ 保存: ${pdfPath}`);
    } catch (e) {}
  }
  process.exit(0);
}

function updateHistory(vId: string, count: number, p: string) {
  const hPath = path.join(__dirname, '../public/sessions.json');
  let h = fs.existsSync(hPath) ? JSON.parse(fs.readFileSync(hPath, 'utf8')) : [];
  h = [{ videoId: vId, date: new Date().toISOString(), messageCount: count, pdfPath: p.replace('public/','') }, ...h.filter((s:any) => s.videoId !== vId)];
  fs.writeFileSync(hPath, JSON.stringify(h.slice(0, 50), null, 2));
}

// ---------- メイン ----------
async function start() {
  console.log(`🚀 Hybrid-Recorder v2.3 (Video: ${videoId})`);
  if (!YOUTUBE_API_KEY) process.exit(1);

  // 1. ブラウザで過去分を取得
  await scrapeInitialHistory(videoId);

  // 2. API 録画へリレー
  try {
    const chatId = await getLiveChatId(videoId, YOUTUBE_API_KEY);
    resetIdleTimer();
    pollChat(chatId, YOUTUBE_API_KEY);
  } catch (err: any) {
    console.error('❌ APIリレー失敗:', err.message);
    if (messages.length > 0) await finish('api_failed_but_has_initial');
    else process.exit(1);
  }
}

start();
