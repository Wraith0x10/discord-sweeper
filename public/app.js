(() => {
  'use strict';

  const GRACE_MS = 5000; // time to undo a removal or leave before it is sent
  const FALLBACK_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

  const $ = (id) => document.getElementById(id);

  const ICONS = {
    heart: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21.2l7.8-7.8 1-1.1a5.5 5.5 0 0 0 0-7.7z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    users: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  };

  // ------------------------------------------------------------------ Formatting
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function duration(ts) {
    const from = new Date(ts);
    const now = new Date();
    let months = (now.getFullYear() - from.getFullYear()) * 12 + (now.getMonth() - from.getMonth());
    if (now.getDate() < from.getDate()) months--;
    const days = Math.floor((now - from) / 86400000);
    if (months >= 12) {
      const y = Math.floor(months / 12);
      const m = months % 12;
      return `${y} yr${y > 1 ? 's' : ''}${m ? ` ${m} mo` : ''}`;
    }
    if (months >= 1) return `${months} month${months > 1 ? 's' : ''}`;
    if (days >= 1) return `${days} day${days > 1 ? 's' : ''}`;
    return 'Today';
  }

  const ago = (ts) => (duration(ts) === 'Today' ? 'Today' : `${duration(ts)} ago`);
  const fmtNum = (n) => (n == null ? '?' : n.toLocaleString());

  function initials(name) {
    const words = name.replace(/['’]s\b/g, '').split(/\s+/).filter(Boolean);
    return words.map((w) => Array.from(w)[0]).join('').slice(0, 5);
  }

  // ------------------------------------------------------------------ API
  async function api(method, url, body, signal) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  // ------------------------------------------------------------------ Decks
  // Each tab is a "deck" of cards with its own endpoints, wording and renderer.

  const decks = {
    friends: {
      name: 'friends',
      loadUrl: '/api/friends',
      listKey: 'friends',
      keepUrl: '/api/keep',
      removeUrl: '/api/remove',
      resetUrl: '/api/reset-kept',
      loadingText: 'Loading your friends list…',
      keepLabel: 'Keep Friend',
      removeLabel: 'Remove Friend',
      hintKeep: 'keep',
      hintRemove: 'remove',
      pendingVerb: 'Removing',
      doneVerb: 'Removed',
      removedWord: 'removed',
      emptyText: 'Your friends list is empty.',
      resetConfirm: 'Show everyone you previously kept so you can review them again?',
      title: (f) => f.displayName,
      avatar: (f) => f.avatar,
      render(f) {
        setAvatar(f.avatar, f.displayName, false);
        $('c-title').textContent = f.displayName;
        $('c-sub').textContent = `@${f.username}`;
        setBadge(f.nickname ? `Your nickname: ${f.nickname}` : '', false);
        setStat(1, ICONS.heart, 'Friends since',
          f.friendSince ? fmtDate(f.friendSince) : 'Unknown',
          f.friendSince ? duration(f.friendSince) : '');
        setStat(2, ICONS.chat, 'Last DM',
          f.lastDm ? fmtDate(f.lastDm) : 'None found',
          f.lastDm ? ago(f.lastDm) : 'No open DM');
        setQuote('');
        $('remove-btn').disabled = false;
      },
    },

    servers: {
      name: 'servers',
      loadUrl: '/api/guilds',
      listKey: 'guilds',
      keepUrl: '/api/guilds/keep',
      removeUrl: '/api/guilds/leave',
      resetUrl: '/api/guilds/reset-kept',
      loadingText: 'Loading your servers…',
      keepLabel: 'Stay in Server',
      removeLabel: 'Leave Server',
      hintKeep: 'stay',
      hintRemove: 'leave',
      pendingVerb: 'Leaving',
      doneVerb: 'Left',
      removedWord: 'left',
      emptyText: "You aren't in any servers.",
      resetConfirm: 'Show every server you previously chose to stay in so you can review them again?',
      title: (g) => g.name,
      avatar: (g) => g.icon,
      canRemove: (g) => !g.owner,
      render(g) {
        setAvatar(g.icon, g.name, true);
        $('c-title').textContent = g.name;
        $('c-sub').textContent = g.members != null ? `${fmtNum(g.members)} members` : '';
        setBadge(g.owner ? 'You own this server, so you can’t leave it' : '', true);
        setStat(1, ICONS.users, 'Members', fmtNum(g.members),
          g.online != null ? `${fmtNum(g.online)} online` : '');
        renderActivity(g);
        $('remove-btn').disabled = !!g.owner;
        loadActivityWindow();
      },
    },
  };

  for (const d of Object.values(decks)) {
    Object.assign(d, { items: [], idx: 0, total: 0, kept: 0, removed: 0, history: [], loaded: false, loading: false, inFlight: 0 });
  }

  const state = {
    me: null,
    active: 'friends',
    pending: new Map(), // "deck:id" -> { deck, item, timer, toast }
    animating: false,
    statusTimer: null,
  };

  const deck = () => decks[state.active];
  const pkey = (d, id) => `${d.name}:${id}`;

  // ------------------------------------------------------------------ Card helpers
  function setAvatar(url, name, square) {
    $('c-ring').classList.toggle('square', square);
    const img = $('c-avatar');
    const ini = $('c-initials');
    if (url) {
      img.hidden = false;
      ini.hidden = true;
      img.onerror = () => {
        img.onerror = null;
        if (square) { img.hidden = true; ini.hidden = false; ini.textContent = initials(name); }
        else img.src = FALLBACK_AVATAR;
      };
      img.src = url;
      img.alt = `${name} icon`;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
      ini.hidden = false;
      const text = initials(name) || '?';
      ini.textContent = text;
      ini.classList.toggle('long', text.length > 3);
    }
  }

  function setBadge(text, owner) {
    const b = $('c-badge');
    b.hidden = !text;
    b.textContent = text;
    b.classList.toggle('badge-owner', owner && !!text);
  }

  function setStat(n, icon, label, value, sub, loading = false) {
    $(`s${n}-icon`).innerHTML = icon;
    $(`s${n}-label`).textContent = label;
    const v = $(`s${n}-value`);
    v.textContent = value;
    v.classList.toggle('loading', loading);
    $(`s${n}-sub`).textContent = sub;
  }

  function setQuote(text) {
    const q = $('c-quote');
    q.hidden = !text;
    q.textContent = text;
  }

  // ------------------------------------------------------------------ Server activity (last message)
  // Looked up lazily for the card on screen and the next one only, so we never
  // fire a burst of search requests. Lookups for cards you skip are cancelled.

  const activityControllers = new Map(); // guild id -> AbortController

  function renderActivity(g) {
    const a = g.activity;
    const label = 'You last spoke';
    if (!a || a.status === 'loading') return setStat(2, ICONS.chat, label, 'Checking…', 'Searching your messages', true), setQuote('');
    if (a.status === 'indexing') return setStat(2, ICONS.chat, label, 'Searching…', 'Discord is indexing this server', true), setQuote('');
    if (a.status === 'found') {
      setStat(2, ICONS.chat, label, fmtDate(a.at), ago(a.at));
      return setQuote(a.preview || '');
    }
    if (a.status === 'none') return setStat(2, ICONS.chat, label, 'Never', 'No messages from you found'), setQuote('');
    setStat(2, ICONS.chat, label, 'Unavailable', 'Search isn’t available here');
    setQuote('');
  }

  function loadActivityWindow() {
    const d = decks.servers;
    const wanted = [d.items[d.idx], d.items[d.idx + 1]].filter(Boolean);
    const wantedIds = new Set(wanted.map((g) => g.id));

    // Cancel lookups for servers that are no longer on screen or next up.
    for (const [id, ctrl] of activityControllers) {
      if (!wantedIds.has(id)) {
        ctrl.abort();
        activityControllers.delete(id);
        const g = d.items.find((x) => x.id === id);
        if (g && g.activity && g.activity.status === 'loading') g.activity = null;
      }
    }
    for (const g of wanted) fetchActivity(g);
  }

  async function fetchActivity(g) {
    if (g.activity || activityControllers.has(g.id)) return;
    const ctrl = new AbortController();
    activityControllers.set(g.id, ctrl);
    g.activity = { status: 'loading' };
    try {
      const result = await api('GET', `/api/guild-activity?id=${g.id}`, null, ctrl.signal);
      g.activity = result;
      if (result.status === 'indexing') {
        // Try again later if the card is still current or next.
        setTimeout(() => {
          if (g.activity && g.activity.status === 'indexing') g.activity = null;
          if (state.active === 'servers') loadActivityWindow();
        }, result.retryAfter * 1000);
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (err.status === 401) return backToLogin('Discord rejected the token. Paste it again to continue.');
      g.activity = { status: 'unavailable' };
    } finally {
      if (activityControllers.get(g.id) === ctrl) activityControllers.delete(g.id);
    }
    const d = decks.servers;
    if (state.active === 'servers' && d.items[d.idx] === g && !state.animating) renderActivity(g);
  }

  // ------------------------------------------------------------------ Screens
  function showScreen(name) {
    $('screen-login').hidden = name !== 'login';
    $('screen-app').hidden = name !== 'app';
  }

  function showView(name) {
    for (const v of ['loading', 'review', 'done', 'error']) $(`view-${v}`).hidden = v !== name;
  }

  // ------------------------------------------------------------------ Login
  const tokenInput = $('token');

  $('toggle-token').addEventListener('click', () => {
    tokenInput.type = tokenInput.type === 'password' ? 'text' : 'password';
    tokenInput.focus();
  });

  function setLoginLoading(on) {
    const btn = $('login-btn');
    btn.disabled = on;
    btn.querySelector('.btn-label').textContent = on ? 'Checking token…' : 'Continue';
    btn.querySelector('.spinner').hidden = !on;
  }

  function showLoginError(msg) {
    const el = $('login-error');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showLoginError('');
    const token = tokenInput.value.trim();
    if (!token) return showLoginError('Paste your token first.');
    setLoginLoading(true);
    try {
      const { me } = await api('POST', '/api/login', { token });
      tokenInput.value = '';
      enterApp(me);
    } catch (err) {
      showLoginError(err.message);
    } finally {
      setLoginLoading(false);
    }
  });

  function backToLogin(message) {
    for (const p of state.pending.values()) clearTimeout(p.timer);
    state.pending.clear();
    for (const c of activityControllers.values()) c.abort();
    activityControllers.clear();
    for (const d of Object.values(decks)) Object.assign(d, { items: [], idx: 0, history: [], loaded: false, inFlight: 0 });
    stopStatusPolling();
    updateQueuePill();
    $('toasts').replaceChildren();
    showScreen('login');
    showLoginError(message || '');
    tokenInput.focus();
  }

  $('logout-btn').addEventListener('click', async () => {
    if (state.pending.size && !confirm('Some actions have not been sent yet. Log out and cancel them?')) return;
    try { await api('POST', '/api/logout'); } catch {}
    backToLogin('');
  });

  // ------------------------------------------------------------------ App + tabs
  function enterApp(me) {
    state.me = me;
    $('me-avatar').src = me.avatar;
    $('me-name').textContent = me.displayName;
    showScreen('app');
    switchTab(location.hash === '#servers' ? 'servers' : 'friends');
  }

  function switchTab(name) {
    if (state.animating) return;
    state.active = name;
    history.replaceState(null, '', `#${name}`);
    for (const t of document.querySelectorAll('.tab')) {
      const on = t.dataset.deck === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    const d = deck();
    $('keep-label').textContent = d.keepLabel;
    $('remove-label').textContent = d.removeLabel;
    $('hint-keep').textContent = d.hintKeep;
    $('hint-remove').textContent = d.hintRemove;
    if (!d.loaded) loadDeck(d);
    else render();
  }

  for (const t of document.querySelectorAll('.tab')) t.addEventListener('click', () => switchTab(t.dataset.deck));

  async function loadDeck(d) {
    if (d.loading) return;
    d.loading = true;
    if (state.active === d.name) {
      $('loading-text').textContent = d.loadingText;
      showView('loading');
    }
    try {
      const data = await api('GET', d.loadUrl);
      // Don't show anything that still has an undo-able action waiting to be sent.
      const pendingIds = new Set([...state.pending.values()].filter((p) => p.deck === d).map((p) => p.item.id));
      d.items = data[d.listKey].filter((x) => !pendingIds.has(x.id));
      d.total = data.total;
      d.kept = data.kept;
      d.removed = 0;
      d.idx = 0;
      d.history = [];
      d.loaded = true;
      updateTabCounts();
      if (state.active === d.name) render();
    } catch (err) {
      if (err.status === 401) return backToLogin('Your session ended. Paste your token again.');
      if (state.active === d.name) {
        $('error-text').textContent = err.message;
        showView('error');
      }
    } finally {
      d.loading = false;
    }
  }

  $('retry-btn').addEventListener('click', () => loadDeck(deck()));
  $('refresh-btn').addEventListener('click', () => loadDeck(deck()));
  $('reset-kept-btn').addEventListener('click', async () => {
    const d = deck();
    if (!confirm(d.resetConfirm)) return;
    try {
      await api('POST', d.resetUrl);
      loadDeck(d);
    } catch (err) { toast({ text: err.message, error: true, duration: 6000 }); }
  });

  function updateTabCounts() {
    for (const d of Object.values(decks)) {
      const el = document.querySelector(`[data-count="${d.name}"]`);
      el.textContent = d.loaded ? String(Math.max(0, d.items.length - d.idx)) : '';
    }
  }

  function updateProgress() {
    const d = deck();
    const reviewed = d.total - d.items.length + d.idx;
    $('progress-count').textContent = `${reviewed} / ${d.total}`;
    $('progress-fill').style.width = d.total ? `${(reviewed / d.total) * 100}%` : '0%';
  }

  function render() {
    const d = deck();
    updateProgress();
    updateTabCounts();
    const item = d.items[d.idx];
    if (!item) return renderDone();

    showView('review');
    const card = $('card');
    card.classList.remove('exit-left', 'exit-right', 'enter');
    void card.offsetWidth; // restart animation
    card.classList.add('enter');
    d.render(item);

    // Preload the next picture so the rotation feels instant.
    const next = d.items[d.idx + 1];
    if (next && d.avatar(next)) new Image().src = d.avatar(next);
  }

  function renderDone() {
    const d = deck();
    showView('done');
    const parts = [];
    if (d.removed) parts.push(`${d.removed} ${d.removedWord}`);
    if (d.kept) parts.push(`${d.kept} kept`);
    $('done-summary').textContent = d.total === 0
      ? d.emptyText
      : `You've reviewed everything here. ${parts.join(' · ')}`.trim();
    $('reset-kept-btn').hidden = d.kept === 0;
    if (d.name === 'servers') loadActivityWindow(); // cancels any leftover lookups
  }

  // ------------------------------------------------------------------ Actions
  function advance(direction) {
    state.animating = true;
    const card = $('card');
    card.classList.remove('enter');
    card.classList.add(direction === 'left' ? 'exit-left' : 'exit-right');
    const d = deck();
    setTimeout(() => {
      d.idx++;
      state.animating = false;
      render();
    }, 260);
  }

  function keep() {
    const d = deck();
    const item = d.items[d.idx];
    if (!item || state.animating) return;
    d.history.push({ type: 'keep', item });
    d.kept++;
    api('POST', d.keepUrl, { id: item.id }).catch((err) => handleActionError(d, err, `Couldn't save "${d.title(item)}" as kept.`));
    advance('left');
  }

  function remove() {
    const d = deck();
    const item = d.items[d.idx];
    if (!item || state.animating) return;
    if (d.canRemove && !d.canRemove(item)) {
      toast({ text: 'You own this server. Transfer or delete it in Discord instead.', error: true, duration: 4000 });
      return;
    }
    d.history.push({ type: 'remove', item });
    scheduleRemoval(d, item);
    advance('right');
  }

  function scheduleRemoval(d, item) {
    const key = pkey(d, item.id);
    const t = toast({
      text: [`${d.pendingVerb} `, d.title(item)],
      avatar: d.avatar(item),
      actionLabel: 'Undo',
      onAction: () => undo(d, item.id),
      timerMs: GRACE_MS,
    });
    const timer = setTimeout(() => {
      state.pending.delete(key);
      dismiss(t);
      sendRemoval(d, item);
    }, GRACE_MS);
    state.pending.set(key, { deck: d, item, timer, toast: t });
    updateQueuePill();
  }

  async function sendRemoval(d, item) {
    d.inFlight++;
    updateQueuePill();
    startStatusPolling();
    try {
      await api('POST', d.removeUrl, { id: item.id });
      d.removed++;
      toast({ text: [`${d.doneVerb} `, d.title(item)], avatar: d.avatar(item), duration: 2500 });
    } catch (err) {
      handleActionError(d, err, `Couldn't ${d.hintRemove} ${d.title(item)}: ${err.message}`, item);
    } finally {
      d.inFlight--;
      updateQueuePill();
      if (!decks.friends.inFlight && !decks.servers.inFlight) stopStatusPolling();
      if (state.active === d.name && !$('view-done').hidden) renderDone();
    }
  }

  function handleActionError(d, err, message, retryItem) {
    if (err.status === 401) return backToLogin('Discord rejected the token. Paste it again to continue.');
    toast({
      text: message,
      error: true,
      duration: 8000,
      actionLabel: retryItem ? 'Retry' : undefined,
      onAction: retryItem ? () => sendRemoval(d, retryItem) : undefined,
    });
  }

  // Undo the most recent action in a deck, or a specific pending removal from its toast.
  function undo(d = deck(), itemId) {
    if (state.animating) { setTimeout(() => undo(d, itemId), 300); return; }
    const last = d.history[d.history.length - 1];

    if (itemId && (!last || last.item.id !== itemId)) {
      // Undo pressed on an older toast: cancel just that one and show it again now.
      const p = state.pending.get(pkey(d, itemId));
      if (!p) return;
      clearTimeout(p.timer);
      dismiss(p.toast);
      state.pending.delete(pkey(d, itemId));
      const hIdx = d.history.findIndex((h) => h.item.id === itemId);
      if (hIdx !== -1) d.history.splice(hIdx, 1);
      const pos = d.items.findIndex((x) => x.id === itemId);
      if (pos !== -1 && pos < d.idx) {
        const [it] = d.items.splice(pos, 1);
        d.idx--;
        d.items.splice(d.idx, 0, it);
      }
      updateQueuePill();
      if (state.active !== d.name) switchTab(d.name);
      else render();
      return;
    }
    if (!last) return;

    if (last.type === 'remove') {
      const p = state.pending.get(pkey(d, last.item.id));
      if (!p) {
        toast({ text: `${d.title(last.item)} was already sent to Discord and can't be undone.`, error: true, duration: 4000 });
        return;
      }
      clearTimeout(p.timer);
      dismiss(p.toast);
      state.pending.delete(pkey(d, last.item.id));
      updateQueuePill();
    } else {
      d.kept--;
      api('POST', d.keepUrl, { id: last.item.id, undo: true }).catch(() => {});
    }
    d.history.pop();
    d.idx--;
    if (state.active !== d.name) switchTab(d.name);
    else render();
  }

  $('keep-btn').addEventListener('click', keep);
  $('remove-btn').addEventListener('click', remove);

  document.addEventListener('keydown', (e) => {
    if ($('screen-app').hidden || e.target instanceof HTMLInputElement) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
    if ($('view-review').hidden || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (k === 'k' || k === 'arrowleft') { e.preventDefault(); keep(); }
    else if (k === 'r' || k === 'arrowright') { e.preventDefault(); remove(); }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.pending.size || decks.friends.inFlight || decks.servers.inFlight) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ------------------------------------------------------------------ Queue indicator
  function updateQueuePill(waitMs = 0) {
    const parts = [];
    for (const d of Object.values(decks)) {
      if (d.inFlight) parts.push(`${d.pendingVerb} ${d.inFlight}`);
    }
    const waiting = state.pending.size;
    const pill = $('queue-pill');
    if (!parts.length && !waiting) { pill.hidden = true; return; }
    pill.hidden = false;
    let text = parts.length ? parts.join(' · ') + '…' : `${waiting} pending`;
    if (parts.length && waitMs > 1500) text += ` next in ${Math.ceil(waitMs / 1000)}s`;
    $('queue-text').textContent = text;
  }

  function startStatusPolling() {
    if (state.statusTimer) return;
    state.statusTimer = setInterval(async () => {
      try {
        const s = await api('GET', '/api/status');
        updateQueuePill(s.waitMs);
      } catch {}
    }, 1000);
  }

  function stopStatusPolling() {
    clearInterval(state.statusTimer);
    state.statusTimer = null;
  }

  // ------------------------------------------------------------------ Toasts
  // text: string, or [prefix, boldName] for "Removing **name**".
  function toast({ text, avatar, actionLabel, onAction, duration = 0, timerMs = 0, error = false }) {
    const el = document.createElement('div');
    el.className = `toast${error ? ' error' : ''}`;

    if (avatar) {
      const img = document.createElement('img');
      img.src = avatar;
      img.alt = '';
      img.onerror = () => { img.remove(); };
      el.appendChild(img);
    }

    const span = document.createElement('span');
    span.className = 'toast-text';
    if (Array.isArray(text)) {
      span.append(text[0]);
      const b = document.createElement('b');
      b.textContent = text[1];
      span.appendChild(b);
    } else {
      span.textContent = text;
    }
    el.appendChild(span);

    if (actionLabel) {
      const btn = document.createElement('button');
      btn.textContent = actionLabel;
      btn.addEventListener('click', () => { dismiss(el); onAction(); });
      el.appendChild(btn);
    }

    if (timerMs) {
      const bar = document.createElement('div');
      bar.className = 'timer';
      bar.style.animationDuration = `${timerMs}ms`;
      el.appendChild(bar);
    }

    const box = $('toasts');
    box.appendChild(el);
    // Keep at most 4 toasts, but never drop one whose Undo is still live.
    for (const old of [...box.children]) {
      if (box.children.length <= 4) break;
      if (!old.querySelector('.timer')) old.remove();
    }
    if (duration) setTimeout(() => dismiss(el), duration);
    return el;
  }

  function dismiss(el) {
    if (el && el.parentNode) el.remove();
  }

  // ------------------------------------------------------------------ Boot
  (async () => {
    try {
      const { me } = await api('GET', '/api/me');
      enterApp(me);
    } catch {
      showScreen('login');
      tokenInput.focus();
    }
  })();
})();
