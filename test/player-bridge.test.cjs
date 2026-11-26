const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  trackLink, readTime, readPlayer, readQueue, createPublisher, isAllowedHomeModule, forYouCardKind, isRejectAll, toggleState, repeatState
} = require('../player-bridge.cjs');

const base = 'https://soundcloud.com/discover';

function element({ textContent = '', title = '', classes = [], attrs = {}, children = [], style = {} } = {}) {
  return {
    textContent, title, children, style,
    getAttribute: name => attrs[name] ?? null,
    matches: selector => selector.split(',').some(token => classes.includes(token.trim().slice(1)))
  };
}

function queueRoot(rows) {
  return {
    querySelectorAll: selector => selector.includes('queueItemView') ? rows : [],
    querySelector: () => null
  };
}

function queueRow(href, artist, title, duration) {
  const fields = {
    '.queueItemView__title a[href]': element({ textContent: title, attrs: { href } }),
    '.queueItemView__username': element({ textContent: artist }),
    '.queueItemView__duration': element({ textContent: duration })
  };
  return { querySelector: selector => fields[selector] ?? null };
}

test('uses the track path as identity and preserves playlist context for navigation', () => {
  assert.deepEqual(trackLink('/artist/track/?in=artist%2Fsets%2Fmix&ignored=1', base), {
    trackId: '/artist/track',
    trackUrl: 'https://soundcloud.com/artist/track?in=artist%2Fsets%2Fmix'
  });
  for (const href of ['/artist/sets/mix', '//example.com/artist/track', 'javascript:alert(1)', null]) {
    assert.equal(trackLink(href, base), null);
  }
});

test('reads visible time and ignores the screen-reader label', () => {
  const children = [
    element({ classes: ['sc-visuallyhidden'], textContent: 'Tempo trascorso: 3 secondi' }),
    element({ textContent: '0:03' })
  ];
  assert.equal(readTime(element({ children })), 3);
  assert.equal(readTime(element({ textContent: '1:02:03' })), 3723);
  assert.equal(readTime(element({ textContent: '0:99' })), null);
  assert.equal(readTime(null), null);
});

test('reads the queue as artist, title and duration and skips unusable rows', () => {
  const rows = [
    queueRow('/a/one?in=a/sets/mix', 'uluv4melia', 'Da float at the function', '2:22'),
    queueRow(null, 'ignored', 'no link', '1:00')
  ];
  assert.deepEqual(readQueue(queueRoot(rows), base), [{
    trackId: '/a/one', trackUrl: 'https://soundcloud.com/a/one?in=a%2Fsets%2Fmix',
    title: 'Da float at the function', artist: 'uluv4melia', duration: 142
  }]);
  assert.deepEqual(readQueue(null, base), []);
});

test('reads a scoped, signed-in player snapshot without requiring a track route', () => {
  const root = {
    querySelectorAll: selector => selector.includes('queueItemView')
      ? [queueRow('/artist/next', 'Other', 'Next track', '1:00')] : [],
    querySelector: selector => ({
      '.playbackSoundBadge__titleLink': element({ title: 'Track', attrs: { href: '/artist/track' } }),
      '.playbackSoundBadge__lightLink': element({ textContent: 'Artist' }),
      '.playbackSoundBadge__avatar .sc-artwork[style]': element({ style: { backgroundImage: 'url("https://example.com/art.jpg")' } }),
      '.playbackTimeline__duration': element({ textContent: '1:58' }),
      '.playbackTimeline__timePassed': element({ textContent: '0:03' }),
      'button.playControls__play': element({ attrs: { 'aria-label': 'Metti in pausa' } }),
      'button.shuffleControl': element({ classes: ['disabled'], attrs: { 'aria-pressed': 'false' } }),
      'button.repeatControl': element({ attrs: { 'aria-pressed': 'true' } }),
      'button.playbackSoundBadge__like': element({ classes: ['sc-button-selected'] }),
      '.playbackTimeline__progressBar': element()
    })[selector]
  };
  assert.deepEqual(readPlayer(root, base), {
    status: 'track', trackId: '/artist/track', trackUrl: 'https://soundcloud.com/artist/track',
    title: 'Track', artist: 'Artist', artworkUrl: 'https://example.com/art.jpg',
    duration: 118, position: 3, isPlaying: true, shuffle: false, repeat: 'all', liked: true,
    queue: [{
      trackId: '/artist/next', trackUrl: 'https://soundcloud.com/artist/next',
      title: 'Next track', artist: 'Other', duration: 60
    }],
    controls: { previous: false, play: true, next: false, shuffle: false, repeat: true, like: true, seek: true }
  });
  assert.deepEqual(readPlayer({ querySelector: () => null, querySelectorAll: () => [] }, base),
    { status: 'idle', queue: [] });
});

test('publishes coherent track changes, queue edits and deduplicates snapshots', () => {
  const seen = [];
  const poll = createPublisher(state => seen.push(state));
  const queue = [{ trackId: '/artist/next', title: 'Next', artist: 'A' }];
  const first = { status: 'track', trackId: '/artist/one', title: 'One', artist: 'Artist', duration: 60, position: 4, queue };
  const second = { ...first, trackId: '/artist/two', title: 'Two', duration: 140, position: 0 };
  poll(first);
  poll(first);
  poll(first);
  poll({ ...first, position: 5 });
  poll({ ...first, trackId: second.trackId });
  poll(second);
  poll(null);
  poll(second);
  assert.equal(seen.length, 2);
  poll({ ...second, position: 1 });
  poll({ ...second, position: 1, queue: [] });
  poll({ status: 'idle', queue: [] });
  poll({ status: 'idle', queue: [] });
  assert.deepEqual(seen.map(s => [s.trackId, s.position, s.queue.length]), [
    ['/artist/one', 4, 1], ['/artist/one', 5, 1], ['/artist/two', 1, 1], ['/artist/two', 1, 0], [undefined, undefined, 0]
  ]);
});

test('keeps only the three chosen Discover blocks, by normalised heading', () => {
  for (const heading of ['Per te', 'For You', 'Altro di cio che ti piace', 'Altro di ciò che ti piace',
    'More of what you like', 'Mixato per zep', 'Mixed for zep']) {
    assert.equal(isAllowedHomeModule(heading), true, heading);
  }
  for (const heading of ['Eventi vicini a te', 'Tracce trendy per genere', 'I tuoi preferiti', 'Your likes',
    'Grab the keys and crank the radio', 'Altro di SoundCloud', 'For you this week',
    'Piace alle persone che segui', 'Le tue scoperte', 'I preferiti di', 'Album per te',
    'Nuova crew, consigliata per te', 'Scopri nuove tracce con le stazioni',
    'Realizzato da SoundCloud', "Artisti da tenere d'occhio", '']) {
    assert.equal(isAllowedHomeModule(heading), false, heading);
  }
});

test('recognizes For You cards without relying on the shelf heading or language', () => {
  assert.equal(forYouCardKind('/discover/sets/new-for-you::listener?c=1', 'Nuove uscite'), 1);
  assert.equal(forYouCardKind('/n/discover/sets/weekly%3A%3Alistener', 'Apri'), 2);
  assert.equal(forYouCardKind(null, '  Daily Drops playlist '), 1);
  assert.equal(forYouCardKind(null, 'Weekly Wave'), 2);
  assert.equal(forYouCardKind('https://example.com/discover/sets/weekly::listener', 'Apri'), 0);
  assert.equal(forYouCardKind('/listener/weekly-wave', 'A different track'), 0);
});

test('reads shuffle and repeat from their state classes', () => {
  assert.equal(toggleState(element({ classes: ['m-shuffling'] })), true);
  assert.equal(toggleState(element({ classes: ['m-one'] })), true);
  assert.equal(toggleState(element({ classes: ['m-all'] })), true);
  assert.equal(toggleState(element({ classes: ['m-none'] })), false);
  assert.equal(toggleState(element({ classes: ['sc-button-selected'] })), true);
  assert.equal(toggleState(element({ attrs: { 'aria-pressed': 'true' }, classes: ['m-none'] })), true);
  assert.equal(toggleState(element({ attrs: { 'aria-pressed': 'false' }, classes: ['m-active'] })), false);
  assert.equal(toggleState(null), null);
  assert.equal(repeatState(element({ classes: ['m-one'], attrs: { 'aria-pressed': 'false' } })), 'one');
  assert.equal(repeatState(element({ classes: ['m-all'] })), 'all');
  assert.equal(repeatState(element({ classes: ['m-none'] })), 'off');
  assert.equal(repeatState(null), null);
});

test('only rejects consent from an explicit reject-all label', () => {
  for (const label of ['Reject all', 'reject all', 'Reject', 'Reject all cookies',
    'Rifiuta tutto', 'Rifiuta', 'Rifiuta tutti i cookie', 'Rifiuta i cookie']) {
    assert.equal(isRejectAll(label), true, label);
  }
  for (const label of ['I accept', 'Accept all', 'Manage preferences', 'Accetta tutto', 'Allow All', '']) {
    assert.equal(isRejectAll(label), false, label);
  }
});
