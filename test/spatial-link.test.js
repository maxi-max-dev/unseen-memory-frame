'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseShare, inspect } = require('../server/public/spatial-link');
const { shareURL } = require('../server/spatial-network');
const link = 'https://app.insta360.com/3dspace/detail/GS3DC' + 'a'.repeat(32);

test('shared link grammar agrees across UI eligibility and backend including URL normalization traps', () => {
  const cases = [link, link + '/?source=PHONE', link + '#view', ' ' + link, link + '\n',
    link.replace('https://', 'https:\\\\'), link.replace('app.', 'evil.'), link.replace('app.insta360.com', 'app.insta360.com.evil.test'),
    link.replace('app.insta360.com', 'name@app.insta360.com'), link.replace('app.insta360.com', 'app.insta360.com:444'),
    'https://127.0.0.1/model.sog', 'https://[::1]/model.sog', link + '?q=' + 'x'.repeat(2000)];
  for (const input of cases) {
    const parsed = parseShare(input);
    if (parsed) assert.deepEqual(shareURL(input), parsed);
    else assert.throws(() => shareURL(input), { code: 'unsupported_link' });
  }
});

test('one complete supported link is extracted from copied share text without guessing or broadening hosts', () => {
  for (const input of [link, '  ' + link + '\n', '我分享了一个时光舱，打开看看：' + link + '?source=PHONE。', '作品\n' + link + '\n来自影石']) {
    assert.equal(inspect(input).kind, 'share');
    assert.equal(inspect(input).url, link);
  }
  for (const input of ['看 ' + link + ' 和 ' + link, '看 ' + link + '.evil.test', '看 ' + link + '#x', '看 ' + link.replace('app.', 'other.'), 'GS3DC' + 'a'.repeat(32), link.replace('https://', 'https:\\\\')]) {
    assert.notEqual(inspect(input).kind, 'share');
  }
});

test('video, raw models and unsupported share routes give distinct recovery instructions', () => {
  assert.equal(inspect('https://example.com/a.mp4?signature=fixture').kind, 'video');
  for (const ext of ['sog', 'zip', 'ply', 'splat', 'spz']) assert.equal(inspect('https://example.com/a.' + ext).kind, 'model');
  assert.equal(inspect('https://app.insta360.com/short/example').kind, 'source');
  assert.equal(inspect(link + '#x').kind, 'source');
  assert.equal(inspect('https://user:password@example.com/').kind, 'invalid');
  assert.equal(inspect('https://example.com/a b').kind, 'invalid');
});
