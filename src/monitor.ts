import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

interface Channel {
  id: string;
  name: string;
}

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPOSITORY; // "owner/repo"
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const CHANNELS_FILE = path.join(__dirname, '../channels.json');

async function checkChannel(channel: Channel) {
  console.log(`🔍 監視中: ${channel.name} (${channel.id})`);
  
  try {
    // 1. RSS フィードを取得 (0 クレジット)
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
    const rssRes = await axios.get(rssUrl);
    const parser = new XMLParser();
    const jsonObj = parser.parse(rssRes.data);

    const entries = jsonObj.feed?.entry;
    if (!entries) {
      console.log(`  ℹ️ 動画が見つかりません。`);
      return;
    }

    // 複数ある場合は配列、1つの場合はオブジェクトになるため配列に統一
    const entryList = Array.isArray(entries) ? entries : [entries];
    const latestVideo = entryList[0];
    const videoId = latestVideo['yt:videoId'];

    if (!videoId) return;

    console.log(`  🎬 最新動画を発見: ${videoId} (${latestVideo.title})`);

    // 2. YouTube API でライブ中か確認 (1 クレジット)
    if (!YOUTUBE_API_KEY) {
      console.warn('  ⚠️ APIキーがないため、詳細なライブ判定をスキップします。');
      return;
    }

    const videoApiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
    const videoRes = await axios.get(videoApiUrl);
    const videoData = videoRes.data.items?.[0];

    if (!videoData) return;

    const isLive = videoData.snippet.liveBroadcastContent === 'live';
    const isUpcoming = videoData.snippet.liveBroadcastContent === 'upcoming';
    
    if (isLive || isUpcoming) {
      console.log(`  🔴 ${isLive ? 'ライブ放送' : '待機所'}を確認！ 録画を開始します...`);
      await triggerRecording(videoId, channel.name);
    } else {
      console.log(`  💤 ライブ中ではありません。`);
    }

  } catch (err: any) {
    console.error(`  ❌ 監視エラー (${channel.name}): ${err.message}`);
  }
}

/** GitHub Actions の録画ワークフローを起動 */
async function triggerRecording(videoId: string, channelName: string) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.error('  ❌ GITHUB_TOKEN または GITHUB_REPOSITORY が設定されていないため、起動できません。');
    return;
  }

  const [owner, repo] = GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${owner}/${repo}/dispatches`;

  try {
    await axios.post(url, {
      event_type: 'youtube-stream-started',
      client_payload: {
        video_id: videoId,
        channel_name: channelName
      }
    }, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });
    console.log(`  🚀 GitHub Actions 起動命令を送信しました (VideoID: ${videoId})`);
  } catch (err: any) {
    console.error(`  ❌ Actions 起動失敗: ${err.response?.data?.message || err.message}`);
  }
}

async function main() {
  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error('❌ channels.json が見つかりません。');
    return;
  }

  const channels: Channel[] = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
  
  for (const channel of channels) {
    await checkChannel(channel);
    // レート制限回避のため少し待つ
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

main();
