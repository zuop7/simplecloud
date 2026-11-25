const fs = require('node:fs');
const path = require('node:path');

// One mixed MRU list: submitted queries and results the listener opened from a
// results page. Kept in the app's user data, never sent anywhere.
const limit = 10;
const artworkHost = /^https:\/\/[a-z0-9-]+\.sndcdn\.com\//i;
const trackPath = /^\/[^/]+\/[^/]+$/;

function text(value, max = 200) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
}

function queryEntry(query) {
  const value = text(query);
  return value ? { type: 'query', key: `q:${value.toLowerCase()}`, query: value } : null;
}

function trackEntry(value) {
  try {
    const url = new URL(value?.trackUrl);
    if (url.protocol !== 'https:' || !/(^|\.)soundcloud\.com$/.test(url.hostname)) return null;
    if (!trackPath.test(url.pathname)) return null;
    const title = text(value?.title);
    if (!title) return null;
    const artworkUrl = artworkHost.test(value?.artworkUrl ?? '') ? value.artworkUrl : null;
    return {
      type: 'track',
      key: `t:${url.pathname}`,
      trackId: url.pathname,
      trackUrl: `${url.origin}${url.pathname}`,
      title,
      artist: text(value?.artist),
      artworkUrl
    };
  } catch {
    return null;
  }
}

function addEntry(list, entry) {
  if (!entry) return list;
  return [entry, ...list.filter(item => item.key !== entry.key)].slice(0, limit);
}

function removeEntry(list, key) {
  return list.filter(item => item.key !== key);
}

function cleanEntry(value) {
  if (value?.type === 'query') return queryEntry(value.query);
  if (value?.type === 'track') return trackEntry(value);
  return null;
}

function sanitise(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).flatMap(value => {
    const entry = cleanEntry(value);
    if (!entry || seen.has(entry.key)) return [];
    seen.add(entry.key);
    return [entry];
  }).slice(0, limit);
}

function load(file) {
  try {
    return sanitise(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return [];
  }
}

function save(file, list) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2));
  } catch (error) {
    console.warn('[search] Could not save search history:', error.message);
  }
}

module.exports = { limit, queryEntry, trackEntry, addEntry, removeEntry, sanitise, load, save };
