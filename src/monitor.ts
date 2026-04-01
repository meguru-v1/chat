/**
 * monitor.ts — チャンネル自動監視エンジン v3.0
 *
 * - RSS フィードで最新3件をチェック（ライブ見落とし防止）
 * - 二重トリガー防止（既に録画中の動画はスキップ）
 * - 待機所（upcoming）の開始5分前に先行録画開始
 */

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

// 既にトリガー済みの video_id を追跡（同一巡回内での重複防止）
const triggeredIds = new Set<string>();

/** 現在録画中の video_id 一覧を GitHub API から取得 */
async function getActiveRecordingIds(): Promise<Set<string>> {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return new Set();

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?status=in_progress&per_page=20`;
    const res = await axios.get(url, {
      headers: {
        'Authorization': `token ${GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    const activeIds = new Set<string>();
    for (const run of res.data.workflow_runs || []) {
      // run-name から video_id を抽出（"🎙️ 録画中: VIDEO_ID" or チャンネル名）
      // client_payload の video_id は直接取れないので、display_title から推測
      // もしくは concurrency group 名 "record-VIDEO_ID" から
      const displayTitle = run.display_title || '';
      
      // workflow_dispatch の場合は inputs.video_id が display_title に入る
      // repository_dispatch の場合は channel_name が入る
      // → 確実なのは、同じワークフロー名かつ in_progress であること自体を確認
      
      // run の jobs を見て video_id を特定するのはコストが高いので、
      // シンプルに「録画ワークフローが走っている」ことだけチェックする
      if (run.name === '📺 YouTube チャット録画 & PDFレポート生成') {
        // display_title に video_id が含まれているか確認
        activeIds.add(displayTitle);
      }
    }
    return activeIds;
  } catch (err: any) {
    console.warn(`  ⚠️ 実行中ジョブの確認に失敗: ${err.message}`);
    return new Set();
  }
}

async function checkChannel(channel: Channel, activeRecordings: Set<string>) {
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
    
    // ① 最新3件をチェック（ライブ見落とし防止）
    const checkTargets = entryList.slice(0, 3);

    for (const entry of checkTargets) {
      const videoId = entry['yt:videoId'];
      if (!videoId) continue;

      console.log(`  🎬 動画を確認: ${videoId} (${entry.title})`);

      // 既にこの巡回でトリガー済みならスキップ
      if (triggeredIds.has(videoId)) {
        console.log(`  ⏭️ 今回の巡回で既にトリガー済み。スキップ。`);
        continue;
      }

      // 2. YouTube API でライブ中か確認 (1 クレジット)
      if (!YOUTUBE_API_KEY) {
        console.warn('  ⚠️ APIキーがないため、詳細なライブ判定をスキップします。');
        return;
      }

      const videoApiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,liveStreamingDetails&id=${videoId}&key=${YOUTUBE_API_KEY}`;
      const videoRes = await axios.get(videoApiUrl);
      const videoData = videoRes.data.items?.[0];

      if (!videoData) continue;

      const broadcastContent = videoData.snippet.liveBroadcastContent;
      const isLive = broadcastContent === 'live';
      const isUpcoming = broadcastContent === 'upcoming';
      
      if (isLive) {
        // ② 二重トリガー防止：既に録画中かチェック
        const alreadyRecording = Array.from(activeRecordings).some(title => 
          title.includes(videoId) || title.includes(channel.name)
        );

        if (alreadyRecording) {
          console.log(`  ⏭️ 既に録画中のためスキップ: ${videoId}`);
          continue;
        }

        console.log(`  🔴 ライブ放送を確認！ 録画を開始します...`);
        await triggerRecording(videoId, channel.name);
        triggeredIds.add(videoId);

      } else if (isUpcoming) {
        // ⑧ 待機所（upcoming）の開始前録画
        const scheduledStart = videoData.liveStreamingDetails?.scheduledStartTime;
        if (scheduledStart) {
          const startTime = new Date(scheduledStart).getTime();
          const now = Date.now();
          const minutesUntilStart = (startTime - now) / (60 * 1000);

          if (minutesUntilStart <= 5 && minutesUntilStart > -5) {
            // 開始5分前以内 → 先行録画開始
            const alreadyRecording = Array.from(activeRecordings).some(title => 
              title.includes(videoId) || title.includes(channel.name)
            );

            if (alreadyRecording) {
              console.log(`  ⏭️ 既に録画中のためスキップ: ${videoId}`);
              continue;
            }

            console.log(`  🟡 待機所を確認！ 開始まであと${Math.round(minutesUntilStart)}分。先行録画を開始します...`);
            await triggerRecording(videoId, channel.name);
            triggeredIds.add(videoId);
          } else if (minutesUntilStart > 5) {
            console.log(`  ⏳ 待機所を確認。配信まであと ${Math.round(minutesUntilStart)} 分。次の巡回を待ちます。`);
          } else {
            console.log(`  ⏳ 待機所あり（開始予定を過ぎています）。次の巡回を待ちます。`);
          }
        } else {
          console.log(`  ⏳ 待機所あり（開始時刻未定）。次の巡回を待ちます。`);
        }
      } else {
        console.log(`  💤 ライブ中ではありません。`);
      }

      // レート制限回避
      await new Promise(resolve => setTimeout(resolve, 500));
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
  console.log('🛰️ Smart-Archiver Monitor v3.0 起動');

  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error('❌ channels.json が見つかりません。');
    return;
  }

  const channels: Channel[] = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
  console.log(`📡 監視対象: ${channels.length} チャンネル`);

  // ② 現在録画中のジョブ一覧を事前取得
  const activeRecordings = await getActiveRecordingIds();
  if (activeRecordings.size > 0) {
    console.log(`📌 現在録画中のタスク: ${activeRecordings.size} 件`);
  }
  
  for (const channel of channels) {
    await checkChannel(channel, activeRecordings);
    // レート制限回避のため少し待つ
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('✅ 巡回完了');
}

main();
