import fs from 'fs';
import path from 'path';
import https from 'https';

const FONT_DIR = path.resolve(__dirname, '../../fonts');
const FONT_FILE = path.join(FONT_DIR, 'NotoSansJP-Regular.ttf');

// Google Fonts の静的 URL（Noto Sans JP Regular, TTF）
const FONT_URL =
  'https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf';

/**
 * fonts/ ディレクトリに NotoSansJP が無ければダウンロードする
 */
export async function ensureFont(): Promise<string> {
  if (fs.existsSync(FONT_FILE)) {
    // ✅ バグ修正: サイズ0の壊れたファイルが残っている場合も再ダウンロードする
    const stat = fs.statSync(FONT_FILE);
    if (stat.size > 0) {
      console.log('✅ フォント既存: ' + FONT_FILE);
      return FONT_FILE;
    }
    console.warn('⚠️ フォントファイルが壊れています(サイズ0)。再ダウンロードします...');
    fs.unlinkSync(FONT_FILE);
  }

  console.log('⬇️  日本語フォントをダウンロード中...');
  if (!fs.existsSync(FONT_DIR)) {
    fs.mkdirSync(FONT_DIR, { recursive: true });
  }

  return new Promise<string>((resolve, reject) => {
    // ✅ バグ修正: リダイレクトの上限回数を設ける（無限ループ防止）
    const download = (url: string, redirectCount = 0) => {
      if (redirectCount > 5) {
        reject(new Error('リダイレクトが多すぎます（5回以上）'));
        return;
      }
      https
        .get(url, (res) => {
          // リダイレクト対応
          if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
            download(res.headers.location, redirectCount + 1);
            return;
          }

          if (res.statusCode !== 200) {
            reject(new Error(`フォントDL失敗: HTTP ${res.statusCode}`));
            return;
          }

          const fileStream = fs.createWriteStream(FONT_FILE);
          res.pipe(fileStream);

          fileStream.on('finish', () => {
            fileStream.close();
            console.log('✅ フォントDL完了: ' + FONT_FILE);
            resolve(FONT_FILE);
          });

          // ✅ バグ修正: ファイルストリームエラー時に壊れたファイルを削除する
          fileStream.on('error', (err) => {
            fs.unlink(FONT_FILE, () => {}); // 壊れたファイルを必ず削除
            reject(err);
          });
        })
        .on('error', (err) => {
          fs.unlink(FONT_FILE, () => {}); // ネットワークエラー時も削除
          reject(err);
        });
    };

    download(FONT_URL);
  });
}

// 直接実行時はフォントダウンロードを実行
if (require.main === module) {
  ensureFont().catch((err) => {
    console.error('❌ フォントDLエラー:', err);
    process.exit(1);
  });
}
