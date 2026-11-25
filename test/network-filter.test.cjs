const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createNetworkFilter, sources } = require('../network-filter.cjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'simplecloud-filter-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let handler;
  let fail = false;
  const requests = [];
  const session = { webRequest: { onBeforeRequest: value => { handler = value; } } };
  const open = () => createNetworkFilter(session, directory, async url => {
    requests.push(url);
    return fail ? new Response('unavailable', { status: 503 }) : new Response(
      '[Adblock Plus 2.0]\n||ads.example^$third-party\n@@||ads.example/allowed^'
    );
  });
  const ask = (url, resourceType = 'script') => {
    let result;
    handler?.({ url, resourceType }, value => { result = value.cancel; });
    return result;
  };
  return { open, ask, requests, fail: () => { fail = true; } };
}

test('starts off, installs only on request, respects exceptions and leaves top-level navigation alone', async t => {
  const { open, ask, requests } = fixture(t);
  const filter = open();
  assert.equal(filter.status().enabled, false);
  assert.deepEqual(requests, []);
  assert.equal(ask('https://ads.example/banner.js'), undefined);
  await filter.download();
  assert.deepEqual(requests, sources);
  assert.equal(filter.status().enabled, true);
  assert.equal(ask('https://ads.example/banner.js'), true);
  assert.equal(ask('https://ads.example/allowed'), false);
  assert.equal(ask('https://ads.example/banner.js', 'mainFrame'), false);
  assert.equal(ask('https://soundcloud.com/audio'), false);
  assert.equal(filter.status().blocked, 1);
});

test('keeps the last good lists on a failed update; disable, update and remove persist', async t => {
  const { open, ask, fail } = fixture(t);
  const filter = open();
  await filter.download();
  filter.setEnabled(false);
  await filter.download();
  assert.equal(open().status().enabled, false);
  filter.setEnabled(true);
  fail();
  await assert.rejects(filter.download(), /503/);
  assert.equal(filter.status().busy, false);
  assert.equal(ask('https://ads.example/banner.js'), true);
  filter.remove();
  assert.equal(ask('https://ads.example/banner.js'), undefined);
  assert.equal(open().status().installed, false);
});
