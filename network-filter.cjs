const fs = require('node:fs');
const path = require('node:path');

const sources = [
  'https://easylist.to/easylist/easylist.txt',
  'https://easylist.to/easylist/easyprivacy.txt'
];
const maxListBytes = 5 * 1024 * 1024;
const site = 'https://soundcloud.com/';

function compile(lists) {
  if (!Array.isArray(lists) || lists.length !== sources.length
      || lists.some(text => typeof text !== 'string' || Buffer.byteLength(text) > maxListBytes
        || !/^\[Adblock Plus[^\r\n]*\]/i.test(text.trimStart()))) {
    throw new Error('The downloaded data was not a supported EasyList filter pack.');
  }
  const { FiltersEngine, Request } = require('@ghostery/adblocker');
  const engine = FiltersEngine.parse(lists.join('\n'), { loadCosmeticFilters: false, loadCSPFilters: false });
  return details => {
    if (details.resourceType === 'mainFrame' || !/^https?:\/\//i.test(details.url)) return false;
    const request = Request.fromRawDetails({
      url: details.url,
      sourceUrl: /^https?:\/\//i.test(details.referrer ?? '') ? details.referrer : site,
      type: details.resourceType
    });
    return engine.match(request).match;
  };
}

async function fetchList(fetcher, url) {
  const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(20_000) });
  if (!response.ok || !response.body) throw new Error(`List download failed (HTTP ${response.status}).`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxListBytes) {
        await reader.cancel();
        throw new Error('The filter list exceeded the download size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

function createNetworkFilter(session, directory, fetcher = fetch) {
  const file = path.join(directory, 'network-filter.json');
  let pack, match, busy = false, blocked = 0;
  const handler = (details, callback) => {
    let cancel = false;
    try { cancel = match?.(details) ?? false; } catch { /* Never interrupt site requests on matcher errors. */ }
    if (cancel) blocked++;
    callback({ cancel });
  };
  const apply = () => session.webRequest.onBeforeRequest(pack?.enabled ? handler : null);
  const save = next => {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(next));
      fs.renameSync(temporary, file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  };
  try {
    if (fs.statSync(file).size > 4 * maxListBytes) throw new Error('Stored filter pack is too large.');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    match = compile(stored.lists);
    pack = { ...stored, enabled: stored.enabled === true };
    if (pack.enabled) apply();
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[filter] Could not load saved filters:', error.message);
  }
  return {
    status: () => ({ installed: Boolean(pack), enabled: pack?.enabled === true, busy, blocked, updatedAt: pack?.updatedAt }),
    async download() {
      if (busy) return;
      busy = true;
      try {
        const lists = await Promise.all(sources.map(url => fetchList(fetcher, url)));
        const candidate = compile(lists);
        const next = { lists, enabled: pack?.enabled ?? true, updatedAt: new Date().toISOString() };
        save(next);
        pack = next;
        match = candidate;
        apply();
      } finally {
        busy = false;
      }
    },
    setEnabled(enabled) {
      if (!pack || busy) return;
      const next = { ...pack, enabled: enabled === true };
      save(next);
      pack = next;
      apply();
    },
    remove() {
      if (!pack || busy) return;
      fs.rmSync(file, { force: true });
      pack = match = undefined;
      blocked = 0;
      apply();
    }
  };
}

module.exports = { createNetworkFilter, sources };
