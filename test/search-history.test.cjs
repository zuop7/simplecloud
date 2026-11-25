const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  limit, queryEntry, trackEntry, addEntry, removeEntry, sanitise
} = require('../search-history.cjs');

const track = (trackUrl, title = 'Track', artist = 'Artist', artworkUrl = null) => ({ trackUrl, title, artist, artworkUrl });

test('records a query, collapsing whitespace and deduplicating case-insensitively', () => {
  assert.deepEqual(queryEntry('  Daft   Punk '), { type: 'query', key: 'q:daft punk', query: 'Daft Punk' });
  assert.equal(queryEntry('   '), null);
  assert.equal(queryEntry(42), null);
});

test('records a track by its path and drops playlist context and non-track links', () => {
  assert.deepEqual(trackEntry(track('https://soundcloud.com/artist/track?in=artist%2Fsets%2Fmix',
    'Get Lucky', 'Daft Punk', 'https://i1.sndcdn.com/artworks-abc-t200x200.jpg')), {
    type: 'track', key: 't:/artist/track', trackId: '/artist/track',
    trackUrl: 'https://soundcloud.com/artist/track', title: 'Get Lucky', artist: 'Daft Punk',
    artworkUrl: 'https://i1.sndcdn.com/artworks-abc-t200x200.jpg'
  });
  assert.equal(trackEntry(track('https://soundcloud.com/artist/sets/mix', 'Mix')), null);
  assert.equal(trackEntry(track('https://example.com/artist/track', 'Off site')), null);
  assert.equal(trackEntry(track('https://soundcloud.com/artist/track', '')), null);
  assert.equal(trackEntry(track('https://soundcloud.com/artist/track', 'T', 'A',
    'https://evil.example/art.jpg')).artworkUrl, null);
  assert.equal(trackEntry(null), null);
});

test('keeps one MRU list of ten, bumping repeats to the top', () => {
  let list = [];
  for (let index = 0; index < 12; index++) list = addEntry(list, queryEntry(`query ${index}`));
  assert.equal(list.length, limit);
  assert.equal(list[0].query, 'query 11');
  assert.equal(list.at(-1).query, 'query 2');

  list = addEntry(list, queryEntry('QUERY 5'));
  assert.equal(list.length, limit);
  assert.equal(list[0].query, 'QUERY 5');
  assert.equal(list.filter(entry => entry.key === 'q:query 5').length, 1);

  const first = trackEntry(track('https://soundcloud.com/a/one', 'One'));
  const second = trackEntry(track('https://soundcloud.com/a/two', 'Two'));
  list = addEntry(addEntry(list, first), second);
  assert.deepEqual([list[0].trackId, list[1].trackId], ['/a/two', '/a/one']);
  list = addEntry(list, trackEntry(track('https://soundcloud.com/a/one?in=a%2Fsets%2Fx', 'One again')));
  assert.equal(list[0].title, 'One again');
  assert.equal(list.filter(entry => entry.key === 't:/a/one').length, 1);
});

test('removes single entries and ignores unknown keys', () => {
  const list = [queryEntry('one'), queryEntry('two')];
  assert.deepEqual(removeEntry(list, 'q:one').map(entry => entry.key), ['q:two']);
  assert.equal(removeEntry(list, 'q:missing').length, 2);
});

test('sanitises stored files: drops bad rows, deduplicates and caps the list', () => {
  const stored = [
    { type: 'query', query: 'keep me' },
    { type: 'track', trackUrl: 'https://soundcloud.com/a/one', title: 'One', artist: 'A' },
    { type: 'track', trackUrl: 'https://soundcloud.com/a/one', title: 'Duplicate' },
    { type: 'track', trackUrl: 'javascript:alert(1)', title: 'Bad' },
    { type: 'query', query: 'keep me' },
    null,
    'nope'
  ];
  assert.deepEqual(sanitise(stored).map(entry => entry.key), ['q:keep me', 't:/a/one']);
  assert.deepEqual(sanitise(null), []);
  assert.deepEqual(sanitise({}), []);
  assert.equal(sanitise(Array.from({ length: 20 }, (_, index) => ({ type: 'query', query: `q${index}` }))).length, limit);
});
