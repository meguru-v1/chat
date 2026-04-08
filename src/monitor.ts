/**
 * monitor.ts — チャンネル自動監視エンジン v3.1
 *
 * ✅ 安定性向上:
 *   - axios タイムアウト (10秒)
 *   - videoId / channelId のバリデーション
 *   - getActiveRecordingIds() の判定精度向上 (video_id 直接照合)
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

// ✅ セキュリティ: 正規表現によるバリデーション
const CHANNEL_ID_REGEX = /^UC[a-zA-Z0-9_-]{22}$/;
const VIDEO_ID_REGEX = /^[a-zA-Z0-9_-]{11}$/;

// axios インスタンス (タイムアウト設定)
const ghAxios = axios.create({
  timeout: 10_000,
  headers: {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
  },
});
const ytAxios = axios.create({ timeout: 10_000 });

// 既にトリガー済みの video_id を追跡（同一巡回内での重複防止）
const triggeredIds = new Set<string>();

/** 現在録画中の video_id 一覧を GitHub API から取得 */
async function getActiveRecordingIds(): Promise<Set<string>> {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return new Set();

  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/actions/runs?status=in_progress&per_page=20`;
    const res = await ghAxios.get(url);

    const activeIds = new Set<string>();
    for (const run of res.data.workflow_runs || []) {
      // run-name が「🎙️ 録画中: VIDEO_ID_channel_name」形式 → VIDEO_ID を抽出
      // record.yml の run-name: "🎙️ 録画中: VIDEO_ID — CHANNEL_NAME"
      const runName: string = run.name ?? '';
      const displayTitle: string = run.display_title ?? '';

      // VIDEO_ID_REGEX に一致する11文字の文字列を run-name / display_title から探す
      for (const text of [runName, displayTitle]) {
        const match = text.match(/[a-zA-Z0-9_-]{11}/g);
        if (match) {
          for (const m of match) {
            if (VIDEO_ID_REGEX.test(m)) activeIds.add(m);
          }
        }
      }
    }
    return activeIds;
  } catch (err: any) {
    console.warn(`  ⚠️ 実行中ジョブの確認に失敗: ${err.message}`);
    return new Set();
  }
}

async function checkChannel(channel: Channel, activeRecordings: Set<string>) {
  // ✅ セキュリティ: チャンネルIDのバリデーション
  if (!CHANNEL_ID_REGEX.test(channel.id)) {
    console.warn(`  ⚠️ 不正なチャンネルID: "${channel.id}" — スキップします`);
    return;
  }

  console.log(`🔍 監視中: ${channel.name} (${channel.id})`);

  try {
    // 1. RSS フィードを取得 (0 クレジット)
    const rssUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channel.id)}`;
    const rssRes = await ytAxios.get(rssUrl);
    const parser = new XMLParser();
    const jsonObj = parser.parse(rssRes.data);

    const entries = jsonObj.feed?.entry;
    if (!entries) {
      console.log(`  ℹ️ 動画が見つかりません。`);
      return;
    }

    const entryList: any[] = Array.isArray(entries) ? entries : [entries];

    // ① 最新3件をチェック（ライブ見落とし防止）
    const checkTargets = entryList.slice(0, 3);

    for (const entry of checkTargets) {
      const videoId: string = entry['yt:videoId'] ?? '';

      // ✅ セキュリティ: 動画IDのバリデーション
      if (!VIDEO_ID_REGEX.test(videoId)) {
        console.warn(`  ⚠️ 不正な videoId: "${videoId}" — スキップ`);
        continue;
      }

      console.log(`  🎬 動画を確認: ${videoId} (${entry.title})`);

      // 既にこの巡回でトリガー済みならスキップ
      if (triggeredIds.has(videoId)) {
        console.log(`  ⏭️ 今回の巡回で既にトリガー済み。スキップ。`);
        continue;
      }

      if (!YOUTUBE_API_KEY) {
        console.warn('  ⚠️ YOUTUBE_API_KEY がないためスキップします。');
        return;
      }

      // 2. YouTube API でライブ中か確認 (1 クレジット)
      const videoApiUrl =
        `https://www.googleapis.com/youtube/v3/videos` +
        `?part=snippet,liveStreamingDetails` +
        `&id=${encodeURIComponent(videoId)}` +
        `&key=${encodeURIComponent(YOUTUBE_API_KEY)}`;
      const videoRes = await ytAxios.get(videoApiUrl);
      const videoData = videoRes.data.items?.[0];
      if (!videoData) continue;

      const broadcastContent: string = videoData.snippet?.liveBroadcastContent ?? 'none';
      const isLive = broadcastContent === 'live';
      const isUpcoming = broadcastContent === 'upcoming';

      if (isLive) {
        // ② 二重トリガー防止: video_id 直接比較（精度向上）
        if (activeRecordings.has(videoId)) {
          console.log(`  ⏭️ 既に録画中のためスキップ: ${videoId}`);
          continue;
        }

        // ✅ RSSではなく YouTube API から取得した最新タイトルを使用（毎日変わる配信タイトルに対応）
        const apiTitle = videoData.snippet?.title ?? entry.title;
        console.log(`  🔴 ライブ放送を確認！ タイトル: ${apiTitle} — 録画を開始します...`);
        await triggerRecording(videoId, channel.name, apiTitle);
        triggeredIds.add(videoId);

      } else if (isUpcoming) {
        // ⑧ 待機所（upcoming）の開始前録画
        const scheduledStart: string | undefined = videoData.liveStreamingDetails?.scheduledStartTime;
        if (scheduledStart) {
          const startTime = new Date(scheduledStart).getTime();
          const now = Date.now();
          const minutesUntilStart = (startTime - now) / (60 * 1000);

          if (minutesUntilStart <= 5 && minutesUntilStart > -5) {
            if (activeRecordings.has(videoId)) {
              console.log(`  ⏭️ 既に録画中のためスキップ: ${videoId}`);
              continue;
            }
            const apiTitle = videoData.snippet?.title ?? entry.title;
            console.log(`  🟡 待機所を確認！ タイトル: ${apiTitle} — 開始まであと${Math.round(minutesUntilStart)}分。先行録画を開始します...`);
            await triggerRecording(videoId, channel.name, apiTitle);
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

      // レート制限回避 (YouTube API)
      await new Promise(resolve => setTimeout(resolve, 500));
    }

  } catch (err: any) {
    console.error(`  ❌ 監視エラー (${channel.name}): ${err.message}`);
  }
}

/** GitHub Actions の録画ワークフローを起動 */
async function triggerRecording(videoId: string, channelName: string, videoTitle: string) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    console.error('  ❌ GITHUB_TOKEN または GITHUB_REPOSITORY が未設定です。');
    return;
  }

  // ✅ セキュリティ: dispatcher 前にも再バリデーション
  if (!VIDEO_ID_REGEX.test(videoId)) {
    console.error(`  ❌ 不正な videoId のためトリガーをスキップ: "${videoId}"`);
    return;
  }

  const [owner, repo] = GITHUB_REPO.split('/');
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`;

  try {
    await ghAxios.post(url, {
      event_type: 'youtube-stream-started',
      client_payload: {
        video_id: videoId,
        channel_name: channelName,
        video_title: videoTitle,
      },
    });
    console.log(`  🚀 GitHub Actions 起動命令を送信しました (VideoID: ${videoId})`);
  } catch (err: any) {
    console.error(`  ❌ Actions 起動失敗: ${err.response?.data?.message ?? err.message}`);
  }
}

async function main() {
  console.log('🛰️ Smart-Archiver Monitor v3.1 起動');

  if (!fs.existsSync(CHANNELS_FILE)) {
    console.error('❌ channels.json が見つかりません。');
    return;
  }

  let channels: Channel[];
  try {
    channels = JSON.parse(fs.readFileSync(CHANNELS_FILE, 'utf-8'));
  } catch (err) {
    console.error('❌ channels.json のパースに失敗しました。');
    return;
  }

  if (!Array.isArray(channels) || channels.length === 0) {
    console.log('ℹ️ 監視対象チャンネルが設定されていません。');
    return;
  }

  console.log(`📡 監視対象: ${channels.length} チャンネル`);

  // ② 現在録画中のジョブ一覧を事前取得（video_id 直接照合）
  const activeRecordings = await getActiveRecordingIds();
  if (activeRecordings.size > 0) {
    console.log(`📌 現在録画中の video_id: ${[...activeRecordings].join(', ')}`);
  }

  for (const channel of channels) {
    await checkChannel(channel, activeRecordings);
    // チャンネル間の API 呼び出し間隔（2秒）
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('✅ 巡回完了');
}

main();
