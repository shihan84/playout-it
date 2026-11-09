import test from 'node:test';
import assert from 'node:assert/strict';
import { vodFileUrl } from '../src/utils/vodPath';

const S = 'https://cdn.itassist.one';

test('synced filenames that already include the VOD prefix are not doubled', () => {
  assert.equal(vodFileUrl(S, 'devin-test_vod', 'devin-test_vod/IMG_1777.MP4', 'index.m3u8'),
    'https://cdn.itassist.one/devin-test_vod/IMG_1777.MP4/index.m3u8');
});

test('bare filenames get the VOD prefix', () => {
  assert.equal(vodFileUrl(S + '/', 'devin-test_vod', 'IMG_1777.MP4', 'embed.html'),
    'https://cdn.itassist.one/devin-test_vod/IMG_1777.MP4/embed.html');
});

test('path segments are URL-encoded', () => {
  assert.equal(vodFileUrl(S, 'news_vod', 'news_vod/my clip#1.mp4', 'index.m3u8'),
    'https://cdn.itassist.one/news_vod/my%20clip%231.mp4/index.m3u8');
});
