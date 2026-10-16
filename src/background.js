// Service worker: every network request goes through here so the content
// script never depends on Twitch's CSP or on CORS headers staying permissive.

const LOGS_API = 'https://bestlogs.lurkology.com';
const LOG_TTL = 60 * 1000;
const EMOTE_TTL = 15 * 60 * 1000;
const MAX_CACHE_ENTRIES = 200;

const cache = new Map();

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function fetchJSON(url, ttl) {
  const hit = cache.get(url);
  if (hit && hit.expires > Date.now()) return hit.value;

  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) {
    // The logs API answers errors with a short plain-text reason,
    // e.g. "The user does not exist: foo".
    const reason = (await res.text().catch(() => '')).trim().slice(0, 200);
    throw new HttpError(res.status, reason || `HTTP ${res.status}`);
  }
  const value = await res.json();

  cache.set(url, { value, expires: Date.now() + ttl });
  if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
  return value;
}

function userPath(channel, user) {
  return `${LOGS_API}/channel/${encodeURIComponent(channel)}/user/${encodeURIComponent(user)}`;
}

// Emote maps are { name: [url1x, url2x] }.

function sevenTvEmotes(list) {
  const out = {};
  for (const e of list || []) {
    const base = `https://cdn.7tv.app/emote/${e.id}`;
    out[e.name] = [`${base}/1x.webp`, `${base}/2x.webp`];
  }
  return out;
}

function bttvEmotes(list) {
  const out = {};
  for (const e of list || []) {
    const base = `https://cdn.betterttv.net/emote/${e.id}`;
    out[e.code] = [`${base}/1x`, `${base}/2x`];
  }
  return out;
}

function ffzEmotes(sets) {
  const out = {};
  for (const set of sets || []) {
    for (const e of set?.emoticons || []) {
      const urls = e.animated || e.urls || {};
      if (urls[1]) out[e.name] = [urls[1], urls[2] || urls[1]];
    }
  }
  return out;
}

async function loadEmotes(roomId) {
  // Globals first so channel emotes with the same name win.
  const jobs = [
    fetchJSON('https://7tv.io/v3/emote-sets/global', EMOTE_TTL)
      .then((d) => sevenTvEmotes(d.emotes)),
    fetchJSON('https://api.betterttv.net/3/cached/emotes/global', EMOTE_TTL)
      .then(bttvEmotes),
    fetchJSON('https://api.frankerfacez.com/v1/set/global', EMOTE_TTL)
      .then((d) => ffzEmotes((d.default_sets || []).map((id) => d.sets[id]))),
  ];
  if (roomId && /^\d+$/.test(roomId)) {
    jobs.push(
      fetchJSON(`https://7tv.io/v3/users/twitch/${roomId}`, EMOTE_TTL)
        .then((d) => sevenTvEmotes(d.emote_set?.emotes)),
      fetchJSON(`https://api.betterttv.net/3/cached/users/twitch/${roomId}`, EMOTE_TTL)
        .then((d) => bttvEmotes([...(d.channelEmotes || []), ...(d.sharedEmotes || [])])),
      fetchJSON(`https://api.frankerfacez.com/v1/room/id/${roomId}`, EMOTE_TTL)
        .then((d) => ffzEmotes(Object.values(d.sets || {}))),
    );
  }

  const map = {};
  for (const result of await Promise.allSettled(jobs)) {
    if (result.status === 'fulfilled') Object.assign(map, result.value);
  }
  return map;
}

async function handle(msg) {
  const { channel, user } = msg;
  switch (msg.type) {
    case 'list': {
      const url = `${LOGS_API}/list?channel=${encodeURIComponent(channel)}&user=${encodeURIComponent(user)}`;
      return (await fetchJSON(url, LOG_TTL)).availableLogs || [];
    }
    case 'month': {
      const url = `${userPath(channel, user)}/${msg.year}/${msg.month}?jsonBasic=1&reverse=1`;
      return (await fetchJSON(url, LOG_TTL)).messages || [];
    }
    case 'search': {
      const url = `${userPath(channel, user)}/search?q=${encodeURIComponent(msg.query)}&jsonBasic=1&reverse=1`;
      try {
        return (await fetchJSON(url, LOG_TTL)).messages || [];
      } catch (err) {
        // A search with no hits is answered with 404 "Not found".
        if (err.status === 404) return [];
        throw err;
      }
    }
    case 'emotes':
      return loadEmotes(msg.roomId);
    default:
      throw new Error(`Unknown request: ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    (data) => sendResponse({ ok: true, data }),
    (err) => sendResponse({ ok: false, error: err.message || String(err), status: err.status || 0 }),
  );
  return true; // keep the channel open for the async response
});
