import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import { claimSocialMessage, cleanSocialUrls, targetVideoBitrateKbps, transcodeDiscordVideo } from '../src/social-media.js';

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve(stderr) : reject(new Error(stderr)));
  });
}

test('deduplicates repeated X and TikTok URLs', () => {
  const x = 'https://x.com/example/status/1234567890123456789';
  const tiktok = 'https://www.tiktok.com/@example/video/7654321098765432109';
  assert.deepEqual(cleanSocialUrls(`${x}\n${x}\n${tiktok}\n${tiktok}`), [x, tiktok]);
});

test('allows only one worker to claim a Discord message', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'amane-claim-test-'));
  try {
    const results = await Promise.all([claimSocialMessage('1548856006241689701', root), claimSocialMessage('1548856006241689701', root)]);
    assert.deepEqual(results.sort(), [false, true]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uses the highest practical bitrate below the upload cap', () => {
  assert.equal(targetVideoBitrateKbps(1), 5000);
  assert.ok(targetVideoBitrateKbps(32) >= 2000);
  assert.equal(targetVideoBitrateKbps(3600), 350);
});

test('normalizes HEVC video to Discord H.264/AAC', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'amane-video-test-'));
  const input = path.join(root, 'hevc.mp4'); const output = path.join(root, 'discord.mp4');
  try {
    await runFfmpeg(['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=720x1280:rate=24:duration=1', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le', '-c:a', 'aac', input]);
    const normalized = await transcodeDiscordVideo(await readFile(input), 1);
    await writeFile(output, normalized);
    const details = await runFfmpeg(['-hide_banner', '-i', output, '-f', 'null', '-']);
    assert.match(details, /Video: h264/); assert.match(details, /yuv420p/); assert.match(details, /Audio: aac/); assert.ok(normalized.length < 9_500_000);
  } finally { await rm(root, { recursive: true, force: true }); }
});
