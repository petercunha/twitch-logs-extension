// Content script: adds a "Chat logs" button to Twitch's and 7TV's user cards
// that shows the chatter's logs for the current channel in a floating panel.
(() => {
  'use strict';

  if (window.__twitchChatLogsLoaded) return;
  window.__twitchChatLogsLoaded = true;

  const LURKOLOGY_URL = 'https://lurkology.com/logs';
  const RENDER_BATCH = 150;
  const EMOTE_WAIT_MS = 1500;
  const LOGIN_RE = /^[a-z0-9_]{1,25}$/;

  const NATIVE_CARD = '[data-a-target="viewer-card"]';
  const SEVENTV_CARD = '.seventv-usercard';
  const CARD_SELECTOR = `${NATIVE_CARD}, ${SEVENTV_CARD}`;
  const CARD_BUTTON_CLASS = 'twitch-chat-logs-card-button';

  // First path segments on www.twitch.tv that are not channel names.
  const NON_CHANNEL_PATHS = new Set([
    'activate', 'bits', 'broadcast', 'clip', 'clips', 'collections', 'creatorcamp',
    'dashboard', 'directory', 'downloads', 'drops', 'event', 'friends', 'following',
    'inventory', 'jobs', 'login', 'messages', 'p', 'payments', 'prime', 'privacy',
    'products', 'redeem', 'search', 'settings', 'signup', 'store', 'subs',
    'subscriptions', 'team', 'turbo', 'u', 'user', 'videos', 'wallet',
  ]);

  const ICON_EXTERNAL = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M11 3h6v6h-2V6.41l-6.29 6.3-1.42-1.42L13.59 5H11V3ZM5 5h4v2H5v8h8v-4h2v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8.5 10 4 5.5 5.5 4 10 8.5 14.5 4 16 5.5 11.5 10l4.5 4.5-1.5 1.5-4.5-4.5L5.5 16 4 14.5 8.5 10Z"/></svg>';
  const ICON_LOGS = '<svg viewBox="0 0 20 20" aria-hidden="true"><path fill-rule="evenodd" d="M4 3h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9.5L5 18v-3H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 2v8h3v1.25L8.9 13H16V5H4Z"/><path d="M6 7h8v1.5H6V7Zm0 2.75h5v1.5H6v-1.5Z"/></svg>';

  // Static markup only; everything from the logs is inserted with textContent.
  const PANEL_HTML = `
    <div class="panel" role="dialog" aria-label="Chat logs" hidden>
      <header class="head">
        <div class="who">
          <a class="name" target="_blank" rel="noopener noreferrer"></a>
          <span class="in">in</span>
          <span class="hash">#</span><input class="channel" spellcheck="false" autocomplete="off" aria-label="Channel" placeholder="channel">
        </div>
        <a class="icon open" target="_blank" rel="noopener noreferrer" title="Open on Lurkology">${ICON_EXTERNAL}</a>
        <button class="icon close" type="button" title="Close (Esc)">${ICON_CLOSE}</button>
      </header>
      <div class="tools">
        <input class="filter" type="search" spellcheck="false" autocomplete="off" placeholder="Filter (Enter searches all history)">
        <select class="month" aria-label="Month"></select>
      </div>
      <div class="status" aria-live="polite"></div>
      <div class="list"></div>
    </div>`;

  const state = {
    host: null,
    els: null,
    token: 0, // bumped on every (re)load so stale responses are dropped
    channel: null,
    login: null,
    displayName: null,
    color: null,
    months: [], // newest first, as returned by /list
    firstMonth: 0, // index of the newest month currently shown
    nextMonth: 0, // index of the next (older) month to fetch
    messages: [],
    view: [], // messages after the local filter
    rendered: 0,
    lastDay: null,
    loading: false,
    filter: '',
    searchQuery: null, // set while showing server-side search results
    emotes: {},
    emoteRoom: null,
    position: null, // set once the user drags the panel
    anchorRect: null, // the user card the panel was opened from
  };

  // --- Page inspection ------------------------------------------------------

  function validLogin(name) {
    const login = (name || '').trim().toLowerCase();
    return LOGIN_RE.test(login) ? login : null;
  }

  function detectChannel() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (location.hostname === 'dashboard.twitch.tv') {
      return parts[0] === 'u' ? validLogin(parts[1]) : null;
    }
    if (['popout', 'embed', 'moderator'].includes(parts[0])) return validLogin(parts[1]);
    if (parts[0] && !NON_CHANNEL_PATHS.has(parts[0].toLowerCase())) return validLogin(parts[0]);

    // VOD pages (/videos/123): take the channel from the channel info link.
    const link = document.querySelector('.channel-info-content a[href^="/"], [data-a-target="watch-mode-channel-link"]');
    const path = link?.getAttribute('href')?.split('/').filter(Boolean)[0];
    return path ? validLogin(path) : null;
  }

  function loginFromCard(card) {
    // Both cards link the profile as twitch.tv/<login>; prefer the header
    // links, then fall back to any single-segment link in the card.
    const links = [
      ...card.querySelectorAll('.viewer-card-header__display-name a[href], a[title="Open Twitch profile"]'),
      ...card.querySelectorAll('a[href]'),
    ];
    for (const a of links) {
      const parts = new URL(a.href, location.href).pathname.split('/').filter(Boolean);
      const login = parts.length === 1 && validLogin(parts[0]);
      if (login) return login;
    }
    return null;
  }

  function displayNameFromCard(card, login) {
    const nameEl = card.querySelector('.viewer-card-header__display-name a, .seventv-usercard-display-name');
    const shown = nameEl?.textContent.trim() || '';
    return shown.toLowerCase() === login ? shown : login;
  }

  function chatColor(login) {
    // The card doesn't carry the chat color, so borrow it from their last message.
    const names = document.querySelectorAll(
      `.chat-line__message[data-a-user="${login}"] .chat-author__display-name, .seventv-chat-user-username[data-a-user="${login}"]`,
    );
    return names[names.length - 1]?.style.color || null;
  }

  function isLightTheme() {
    return document.documentElement.classList.contains('tw-root--theme-light');
  }

  // --- Messaging -------------------------------------------------------------

  function request(msg) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        reject(new Error('The extension was reloaded. Refresh this page to use it again.'));
        return;
      }
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else if (!res) {
          reject(new Error('No response from the extension.'));
        } else if (res.ok) {
          resolve(res.data);
        } else {
          reject(Object.assign(new Error(res.error), { status: res.status }));
        }
      });
    });
  }

  function describeError(err) {
    const text = err.message || '';
    if (err.status === 404 && /channel does not exist/i.test(text)) {
      return `#${state.channel} isn't logged by Lurkology.`;
    }
    if (err.status === 404) return `No logs for ${state.displayName} in #${state.channel}.`;
    if (err.status) return `Logs server error (${err.status}): ${text}`;
    return text || 'Could not reach the logs server.';
  }

  // --- DOM helpers ------------------------------------------------------------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function monthLabel({ year, month }) {
    return new Date(Number(year), Number(month) - 1, 1)
      .toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }

  function dayLabel(date) {
    return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function timeLabel(date) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }

  // --- Message rendering -------------------------------------------------------

  function twitchEmoteUrls(id) {
    const theme = isLightTheme() ? 'light' : 'dark';
    const base = `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/${theme}`;
    return [`${base}/1.0`, `${base}/2.0`];
  }

  // Splits text into plain/emote segments using the IRC `emotes` tag, whose
  // ranges are code point indices ("25:0-4,12-16/1902:6-10").
  function twitchSegments(text, emotesTag) {
    const chars = Array.from(text);
    const ranges = [];
    for (const part of (emotesTag || '').split('/')) {
      const [id, positions] = part.split(':');
      if (!id || !positions) continue;
      for (const pos of positions.split(',')) {
        const [start, end] = pos.split('-').map(Number);
        if (Number.isInteger(start) && Number.isInteger(end) && end >= start) ranges.push({ id, start, end });
      }
    }
    ranges.sort((a, b) => a.start - b.start);

    const segments = [];
    let i = 0;
    for (const { id, start, end } of ranges) {
      if (start < i || end >= chars.length) continue;
      if (start > i) segments.push({ text: chars.slice(i, start).join('') });
      segments.push({ emote: chars.slice(start, end + 1).join(''), urls: twitchEmoteUrls(id) });
      i = end + 1;
    }
    if (i < chars.length) segments.push({ text: chars.slice(i).join('') });
    return segments;
  }

  function appendHighlighted(parent, text, needle) {
    if (!needle) {
      parent.append(text);
      return;
    }
    const lower = text.toLowerCase();
    let i = 0;
    for (let hit = lower.indexOf(needle, i); hit !== -1; hit = lower.indexOf(needle, i)) {
      if (hit > i) parent.append(text.slice(i, hit));
      parent.append(el('mark', null, text.slice(hit, hit + needle.length)));
      i = hit + needle.length;
    }
    if (i < text.length) parent.append(text.slice(i));
  }

  function appendEmote(parent, name, [url1, url2]) {
    const img = el('img', 'emote');
    img.src = url1;
    img.srcset = `${url1} 1x, ${url2} 2x`;
    img.alt = name;
    img.title = name;
    parent.append(img);
  }

  function appendWords(parent, text, needle) {
    // Plain words are collected into one run so a multi-word filter can
    // still be highlighted; emotes and links break the run.
    let run = '';
    const flush = () => {
      if (run) appendHighlighted(parent, run, needle);
      run = '';
    };
    for (const word of text.split(/(\s+)/)) {
      if (Object.hasOwn(state.emotes, word)) {
        flush();
        appendEmote(parent, word, state.emotes[word]);
      } else if (/^https?:\/\/\S+$/i.test(word)) {
        flush();
        const a = el('a', 'link');
        a.href = word;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        appendHighlighted(a, word, needle);
        parent.append(a);
      } else {
        run += word;
      }
    }
    flush();
  }

  function renderText(parent, text, emotesTag, needle) {
    for (const seg of twitchSegments(text, emotesTag)) {
      if (seg.emote) appendEmote(parent, seg.emote, seg.urls);
      else appendWords(parent, seg.text, needle);
    }
  }

  function unescapeTag(value) {
    return (value || '').replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
  }

  function renderMessage(m, needle) {
    const tags = m.tags || {};
    const date = new Date(m.timestamp);
    const row = el('div', 'msg');

    const time = el('time', 'ts', timeLabel(date));
    time.dateTime = m.timestamp;
    time.title = date.toLocaleString();
    row.append(time);

    const body = el('span', 'body');
    let text = m.text || '';

    if (tags['target-user-id']) {
      // CLEARCHAT: timeout or ban of this user. (The log aggregator also
      // fills in user-id here, so target-user-id is the only reliable sign.)
      row.classList.add('mod');
      const secs = Number(tags['ban-duration']);
      body.textContent = text || (secs ? `Timed out for ${secs}s` : 'Banned');
    } else {
      if (tags['msg-id'] && tags['system-msg']) {
        // USERNOTICE: subs, resubs, gifts, raids, announcements...
        row.classList.add('system');
        body.append(el('span', 'sysmsg', unescapeTag(tags['system-msg'])));
        if (text) body.append(' ');
      }
      const action = text.match(/^\u0001ACTION (.*)\u0001?$/);
      if (action) {
        text = action[1].replace(/\u0001$/, '');
        body.classList.add('action');
        if (state.color) body.style.color = state.color;
      }
      renderText(body, text, tags.emotes, needle);
    }

    row.append(body);
    return row;
  }

  // --- Panel -----------------------------------------------------------------

  function ensurePanel() {
    if (state.host?.isConnected) return;

    const host = document.createElement('div');
    host.id = 'twitch-chat-logs-host';
    host.style.visibility = 'hidden';
    const root = host.attachShadow({ mode: 'open' });

    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = chrome.runtime.getURL('src/panel.css');
    css.addEventListener('load', () => {
      // Sizes are only known once styled, so place again now.
      if (state.anchorRect && !state.els.panel.hidden) placePanel(state.anchorRect);
      host.style.visibility = '';
    });
    root.append(css);

    const wrap = document.createElement('div');
    wrap.innerHTML = PANEL_HTML;
    root.append(...wrap.childNodes);

    const q = (sel) => root.querySelector(sel);
    const els = {
      root,
      panel: q('.panel'),
      head: q('.head'),
      name: q('.name'),
      channel: q('.channel'),
      open: q('.open'),
      close: q('.close'),
      filter: q('.filter'),
      month: q('.month'),
      status: q('.status'),
      list: q('.list'),
    };

    // Keep keystrokes typed into the panel away from Twitch's hotkeys.
    for (const type of ['keydown', 'keyup', 'keypress']) {
      root.addEventListener(type, (e) => {
        if (type === 'keydown' && e.key === 'Escape') {
          e.preventDefault();
          closePanel();
        }
        e.stopPropagation();
      });
    }

    els.close.addEventListener('click', closePanel);

    els.channel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const channel = validLogin(els.channel.value.replace(/^#/, ''));
      if (channel) {
        state.channel = channel;
        load();
      } else {
        els.channel.value = state.channel || '';
      }
    });

    let filterTimer = 0;
    els.filter.addEventListener('input', () => {
      clearTimeout(filterTimer);
      filterTimer = setTimeout(() => {
        state.filter = els.filter.value.trim().toLowerCase();
        if (state.searchQuery !== null && !state.filter) {
          exitSearch();
        } else if (state.searchQuery === null) {
          applyFilter();
        }
      }, 120);
    });
    els.filter.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const query = els.filter.value.trim();
      if (query) searchHistory(query);
    });

    els.month.addEventListener('change', () => {
      const index = Number(els.month.value);
      if (Number.isInteger(index)) jumpToMonth(index);
    });

    els.list.addEventListener('scroll', () => {
      const { list } = els;
      if (list.scrollTop + list.clientHeight >= list.scrollHeight - 200) loadMore();
    }, { passive: true });

    els.list.addEventListener('click', (e) => {
      const button = e.target.closest('.more');
      if (button) loadMore(true);
    });

    enableDragging(els);

    document.body.append(host);
    state.host = host;
    state.els = els;
  }

  function enableDragging({ head, panel }) {
    head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input, button, a, select')) return;
      e.preventDefault();
      const rect = panel.getBoundingClientRect();
      const dx = e.clientX - rect.left;
      const dy = e.clientY - rect.top;
      head.setPointerCapture(e.pointerId);

      const move = (ev) => {
        const left = Math.min(Math.max(0, ev.clientX - dx), innerWidth - 40);
        const top = Math.min(Math.max(0, ev.clientY - dy), innerHeight - 40);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        state.position = { left, top };
      };
      const up = () => {
        head.removeEventListener('pointermove', move);
        head.removeEventListener('pointerup', up);
        head.removeEventListener('pointercancel', up);
      };
      head.addEventListener('pointermove', move);
      head.addEventListener('pointerup', up);
      head.addEventListener('pointercancel', up);
    });
  }

  function placePanel(rect) {
    const { panel } = state.els;
    const margin = 8;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;

    let left;
    let top;
    if (state.position) {
      ({ left, top } = state.position);
    } else {
      if (rect.left - width - margin >= margin) {
        left = rect.left - width - margin; // beside the user card
      } else if (rect.right + width + margin <= innerWidth - margin) {
        left = rect.right + margin;
      } else {
        left = (innerWidth - width) / 2; // popout chat: overlay
      }
      top = rect.top;
    }

    panel.style.left = `${Math.min(Math.max(margin, left), innerWidth - width - margin)}px`;
    panel.style.top = `${Math.min(Math.max(margin, top), innerHeight - height - margin)}px`;
  }

  function closePanel() {
    if (!state.els) return;
    state.token++;
    state.els.panel.hidden = true;
  }

  function openPanel({ login, channel, color, displayName, anchorRect }) {
    ensurePanel();
    const { els } = state;

    state.login = login;
    state.channel = channel;
    state.color = color;
    state.displayName = displayName || login;

    els.panel.classList.toggle('light', isLightTheme());
    els.name.textContent = state.displayName;
    els.name.href = `https://www.twitch.tv/${login}`;
    els.name.style.color = color || '';
    els.filter.value = '';
    state.filter = '';

    els.panel.hidden = false;
    state.anchorRect = anchorRect;
    placePanel(anchorRect);

    if (channel) {
      load();
    } else {
      els.channel.value = '';
      resetResults();
      setStatus('Type the channel name above and press Enter.');
      els.channel.focus();
    }
  }

  function setStatus(text, isError = false) {
    const { status } = state.els;
    status.textContent = text;
    status.classList.toggle('error', isError);
  }

  function resetResults() {
    state.months = [];
    state.firstMonth = 0;
    state.nextMonth = 0;
    state.messages = [];
    state.view = [];
    state.rendered = 0;
    state.lastDay = null;
    state.loading = false;
    state.searchQuery = null;
    state.els.list.replaceChildren();
    state.els.month.replaceChildren();
    state.els.month.disabled = true;
  }

  function updateLinks() {
    const { els } = state;
    els.channel.value = state.channel || '';
    const params = new URLSearchParams({ c: state.channel || '', u: state.login });
    els.open.href = `${LURKOLOGY_URL}?${params}`;
  }

  // --- Loading -----------------------------------------------------------------

  async function load() {
    const token = ++state.token;
    resetResults();
    updateLinks();
    setStatus('Loading…');
    state.loading = true;

    try {
      const months = await request({ type: 'list', channel: state.channel, user: state.login });
      if (token !== state.token) return;
      state.months = months;
      state.loading = false;

      if (!months.length) {
        setStatus(`No logs for ${state.displayName} in #${state.channel}.`);
        return;
      }
      fillMonthSelect();
      await loadMonth(0, token);
    } catch (err) {
      if (token !== state.token) return;
      state.loading = false;
      setStatus(describeError(err), true);
    }
  }

  function fillMonthSelect() {
    const { month } = state.els;
    month.replaceChildren(...state.months.map((m, i) => {
      const option = el('option', null, monthLabel(m));
      option.value = String(i);
      return option;
    }));
    month.disabled = false;
  }

  async function loadMonth(index, token = state.token) {
    const target = state.months[index];
    if (!target || state.loading) return;
    state.loading = true;
    renderFooter();

    try {
      const messages = await request({
        type: 'month', channel: state.channel, user: state.login, year: target.year, month: target.month,
      });
      if (token !== state.token) return;

      await ensureEmotes(messages, token);
      if (token !== state.token) return;

      // Pick up the display name casing from the logs.
      const named = messages.find((m) => m.displayName);
      if (named && named.displayName.toLowerCase() === state.login) {
        state.displayName = named.displayName;
        state.els.name.textContent = named.displayName;
      }

      // Months arrive newest first, so each one extends the list downward.
      state.nextMonth = index + 1;
      state.messages = state.messages.concat(messages);
      state.view = state.view.concat(messages.filter(matchesFilter));
      state.loading = false;
      renderBatch();
      updateStatus();
    } catch (err) {
      if (token !== state.token) return;
      state.loading = false;
      setStatus(describeError(err), true);
      renderFooter();
    }
  }

  async function ensureEmotes(messages, token) {
    const roomId = messages.find((m) => m.tags?.['room-id'])?.tags['room-id'] || '';
    if (state.emoteRoom === roomId) return;

    const pending = request({ type: 'emotes', roomId })
      .then((emotes) => {
        if (token !== state.token) return;
        state.emotes = emotes;
        state.emoteRoom = roomId;
      })
      .catch(() => {});
    // Don't hold the logs back for slow emote providers.
    await Promise.race([pending, new Promise((r) => setTimeout(r, EMOTE_WAIT_MS))]);
  }

  function jumpToMonth(index) {
    const token = ++state.token;
    state.loading = false;
    state.messages = [];
    state.view = [];
    state.rendered = 0;
    state.lastDay = null;
    state.firstMonth = index;
    state.nextMonth = index;
    state.els.list.replaceChildren();
    state.els.list.scrollTop = 0;
    setStatus('Loading…');
    loadMonth(index, token);
  }

  function loadMore(explicit = false) {
    if (state.loading || state.searchQuery !== null) return;
    if (state.rendered < state.view.length) {
      renderBatch();
    } else if (state.nextMonth < state.months.length && (explicit || !state.filter)) {
      // While filtering, older months only load on request so an empty
      // filter result doesn't walk the whole history.
      loadMonth(state.nextMonth);
    }
  }

  async function searchHistory(query) {
    const token = ++state.token;
    state.loading = true;
    state.searchQuery = query;
    state.filter = query.toLowerCase();
    state.els.month.disabled = true;
    state.els.list.replaceChildren();
    setStatus(`Searching all of ${state.displayName}'s logs in #${state.channel}…`);

    try {
      const messages = await request({ type: 'search', channel: state.channel, user: state.login, query });
      if (token !== state.token) return;
      await ensureEmotes(messages, token);
      if (token !== state.token) return;
      state.loading = false;
      state.view = messages;
      state.rendered = 0;
      state.lastDay = null;
      renderBatch();
      const count = messages.length;
      setStatus(`${count.toLocaleString()} result${count === 1 ? '' : 's'} for “${query}” across all months · clear the filter to go back`);
    } catch (err) {
      if (token !== state.token) return;
      state.loading = false;
      setStatus(describeError(err), true);
    }
  }

  function exitSearch() {
    state.searchQuery = null;
    state.token++;
    state.loading = false;
    if (state.months.length) state.els.month.disabled = false;
    applyFilter();
  }

  // --- List rendering -------------------------------------------------------------

  function matchesFilter(m) {
    return !state.filter || (m.text || '').toLowerCase().includes(state.filter);
  }

  function applyFilter() {
    state.view = state.messages.filter(matchesFilter);
    state.els.list.replaceChildren();
    state.els.list.scrollTop = 0;
    state.rendered = 0;
    state.lastDay = null;
    renderBatch();
    updateStatus();
  }

  function updateStatus() {
    const { months, firstMonth, nextMonth, view } = state;
    const newest = months[firstMonth];
    const oldest = months[nextMonth - 1];
    const span = oldest && oldest !== newest
      ? `${monthLabel(oldest)} – ${monthLabel(newest)}`
      : newest ? monthLabel(newest) : '';
    const count = view.length.toLocaleString();
    const noun = state.filter ? 'matching' : `message${view.length === 1 ? '' : 's'}`;
    setStatus(`${count} ${noun} · ${span} · ${months.length} month${months.length === 1 ? '' : 's'} logged`);
    state.els.month.value = String(Math.max(0, nextMonth - 1));
  }

  function renderBatch() {
    const { list } = state.els;
    list.querySelector('.more')?.remove();
    list.querySelector('.end')?.remove();

    const frag = document.createDocumentFragment();
    const end = Math.min(state.rendered + RENDER_BATCH, state.view.length);
    for (let i = state.rendered; i < end; i++) {
      const m = state.view[i];
      const date = new Date(m.timestamp);
      const day = date.toDateString();
      if (day !== state.lastDay) {
        frag.append(el('div', 'day', dayLabel(date)));
        state.lastDay = day;
      }
      frag.append(renderMessage(m, state.filter));
    }
    list.append(frag);
    state.rendered = end;
    renderFooter();
  }

  function renderFooter() {
    const { list } = state.els;
    list.querySelector('.more')?.remove();
    list.querySelector('.end')?.remove();

    if (state.loading) {
      list.append(el('div', 'end', 'Loading…'));
      return;
    }
    if (state.rendered < state.view.length) return; // more on scroll
    if (state.searchQuery === null && state.nextMonth < state.months.length) {
      const button = el('button', 'more', `Load ${monthLabel(state.months[state.nextMonth])}`);
      button.type = 'button';
      list.append(button);
    } else if (state.view.length) {
      list.append(el('div', 'end', state.searchQuery === null ? 'Start of logs' : 'End of results'));
    } else if (state.searchQuery !== null || state.filter) {
      list.append(el('div', 'end', 'No matches'));
    }
  }

  // --- User card button -----------------------------------------------------------

  function onCardButtonClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const card = e.currentTarget.closest(CARD_SELECTOR);
    // Read the login at click time: the same card is reused for other users.
    const login = card && loginFromCard(card);
    if (!login) return;
    openPanel({
      login,
      channel: detectChannel(),
      color: chatColor(login),
      displayName: displayNameFromCard(card, login),
      anchorRect: card.getBoundingClientRect(),
    });
  }

  function makeCardButton(className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `${className} ${CARD_BUTTON_CLASS}`;
    button.title = 'Chat logs';
    button.setAttribute('aria-label', 'Chat logs');
    button.innerHTML = ICON_LOGS;
    button.addEventListener('click', onCardButtonClick);
    return button;
  }

  function decorateCards() {
    for (const card of document.querySelectorAll(NATIVE_CARD)) {
      // The close button is absolutely positioned in this overlay; ours sits
      // just left of it. viewer-card-drag-cancel keeps the card from dragging.
      const overlay = card.querySelector('.viewer-card-header__overlay');
      if (!overlay || overlay.querySelector(`.${CARD_BUTTON_CLASS}`)) continue;
      overlay.append(makeCardButton('twitch-chat-logs-native viewer-card-drag-cancel'));
    }

    for (const card of document.querySelectorAll(SEVENTV_CARD)) {
      const actions = card.querySelector('.seventv-usercard-actions');
      if (!actions || actions.querySelector(`.${CARD_BUTTON_CLASS}`)) continue;
      // Reuse 7TV's own button class (including its Svelte scope class) so
      // the button picks up their styling.
      const sample = actions.querySelector('.seventv-usercard-icon-button');
      const classes = [...(sample?.classList || [])]
        .filter((c) => c === 'seventv-usercard-icon-button' || c.startsWith('svelte-'));
      const close = actions.querySelector('[title="Close"]');
      actions.insertBefore(makeCardButton(classes.join(' ') || 'seventv-usercard-icon-button'), close);
    }
  }

  // Cards mount and remount as names are clicked; batch checks per frame
  // since chat mutates constantly.
  let scanQueued = false;
  new MutationObserver(() => {
    if (scanQueued) return;
    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      decorateCards();
    });
  }).observe(document.body, { childList: true, subtree: true });
  decorateCards();
})();
