import { copyFileSync, cpSync, mkdirSync } from 'fs';
import path from 'path';

const rootDir = path.resolve(import.meta.dirname, '..');
const targetDir = path.resolve(rootDir, process.argv[2] || 'dist');
const assetsDir = path.resolve(targetDir, 'assets');

function copyIntoDist(source, destination = path.basename(source)) {
  cpSync(path.resolve(rootDir, source), path.resolve(targetDir, destination), {
    recursive: true,
    force: true,
  });
}

function copyPublicRootFile(fileName) {
  copyFileSync(
    path.resolve(rootDir, 'public', fileName),
    path.resolve(targetDir, fileName),
  );
}

function copyPublicAsset(fileName) {
  copyFileSync(
    path.resolve(rootDir, 'public', fileName),
    path.resolve(assetsDir, fileName),
  );
}

mkdirSync(targetDir, { recursive: true });
mkdirSync(assetsDir, { recursive: true });

// 入口类文件保留在根目录，其余运行资源统一放入 assets，减少线上根目录散落文件。
[
  'browserconfig.xml',
  'compatTest.js',
  'electronVersion.txt',
  'google7077b308900504fb.html',
  'redirect.js',
  'site.webmanifest',
  'site_apple.webmanifest',
  'site_apple_dev.webmanifest',
  'site_dev.webmanifest',
  'version.txt',
].forEach(copyPublicRootFile);

copyIntoDist('public/get');
copyIntoDist('public/share');
copyFileSync(
  path.resolve(rootDir, 'src/lib/rlottie/rlottie-wasm.wasm'),
  path.resolve(assetsDir, 'rlottie-wasm.wasm'),
);
copyFileSync(
  path.resolve(rootDir, 'node_modules/opus-recorder/dist/decoderWorker.min.wasm'),
  path.resolve(assetsDir, 'decoderWorker.min.wasm'),
);
copyIntoDist('node_modules/emoji-data-ios/img-apple-64', 'assets/img-apple-64');
copyIntoDist('node_modules/emoji-data-ios/img-apple-160', 'assets/img-apple-160');

[
  'notification.mp3',
  'voicechat_join.mp3',
  'voicechat_connecting.mp3',
  'voicechat_leave.mp3',
  'voicechat_onallowtalk.mp3',
  'voicechat_recordstart.mp3',
  'call_busy.mp3',
  'call_connect.mp3',
  'call_end.mp3',
  'call_incoming.mp3',
  'call_ringing.mp3',
  'apple-touch-icon.png',
  'apple-touch-icon-dev.png',
  'favicon.ico',
  'favicon.svg',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'favicon-unread.svg',
  'icon-192x192.png',
  'icon-384x384.png',
  'icon-512x512.png',
  'icon-dev-192x192.png',
  'icon-dev-384x384.png',
  'icon-dev-512x512.png',
  'icon-electron-macos.png',
  'icon-square-192x192.png',
  'icon-square-384x384.png',
  'icon-square-512x512.png',
  'icon-square-dev-192x192.png',
  'icon-square-dev-384x384.png',
  'icon-square-dev-512x512.png',
  'mstile-150x150.png',
  'nojs.mp4',
  'screenshot.jpg',
  'unsupported.png',
].forEach(copyPublicAsset);
