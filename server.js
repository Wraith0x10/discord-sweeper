// Discord Sweeper - local server.
// Binds to 127.0.0.1 only. The token lives in memory and is sent only to discord.com.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 4783;
const HOST = '127.0.0.1';
const API = process.env.DISCORD_API || 'https://discord.com/api/v9'; // override only for local testing
// When packaged as a single .exe, the web page is embedded in the executable
// and saved data lives in a "data" folder next to the .exe.
const sea = (() => { try { return require('node:sea'); } catch { return null; } })();
const IS_EXE = !!(sea && sea.isSea());
const APP_DIR = IS_EXE ? path.dirname(process.execPath) : __dirname;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(APP_DIR, 'data', 'kept.json');
const SHOULD_OPEN_BROWSER = (IS_EXE || process.argv.includes('--open')) && !process.argv.includes('--no-open');
const DISCORD_EPOCH = 1420070400000n;

// ---------------------------------------------------------------------------
// Rate-limited Discord client
// ---------------------------------------------------------------------------
// Every request goes through one serial queue, so there are never two requests
// in flight. On top of Discord's own rate-limit headers we add a conservative
// minimum gap between requests (much longer for friend removals) with jitter.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.random() * (max - min);

class AuthError extends Error {}
class CancelledError extends Error {}

class DiscordClient {
  constructor(token) {
    this.token = token;
    this.chain = Promise.resolve();
    this.pending = 0;
    this.lastRequestAt = 0;
    this.globalUntil = 0;
    this.routeToBucket = new Map(); // "METHOD route" -> bucket id
    this.buckets = new Map(); // bucket id -> { remaining, resetAt }
    this.dead = false; // set once the token is rejected; stops all traffic
    this.waitingUntil = 0; // for status display
  }

  // opts: { minGap: [min, max] ms, body: object, isCancelled: () => boolean }
  request(method, route, opts = {}) {
    const o = { minGap: [1100, 1600], ...opts };
    this.pending++;
    const run = () => this._send(method, route, o).finally(() => this.pending--);
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    return p;
  }

  async _waitUntil(ts) {
    const ms = ts - Date.now();
    if (ms > 0) {
      this.waitingUntil = ts;
      await sleep(ms);
    }
  }

  async _send(method, route, opts, attempt = 0) {
    if (this.dead) throw new AuthError('Token is no longer valid.');
    // Skip work the browser no longer wants (e.g. a lookup for a card you already skipped).
    if (opts.isCancelled && opts.isCancelled()) throw new CancelledError('Cancelled');
    const { minGap } = opts;

    // Route key groups IDs so per-route buckets are shared (e.g. all relationship deletes).
    const routeKey = `${method} ${route.replace(/\d{15,}/g, ':id')}`;

    await this._waitUntil(this.globalUntil);
    await this._waitUntil(this.lastRequestAt + jitter(minGap[0], minGap[1]));
    const bucketId = this.routeToBucket.get(routeKey);
    const bucket = bucketId && this.buckets.get(bucketId);
    if (bucket && bucket.remaining <= 0) await this._waitUntil(bucket.resetAt + 250);
    if (opts.isCancelled && opts.isCancelled()) throw new CancelledError('Cancelled');

    this.lastRequestAt = Date.now();
    const res = await fetch(API + route, {
      method,
      headers: { Authorization: this.token, 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    this.waitingUntil = 0;

    // Record bucket info from headers.
    const hBucket = res.headers.get('x-ratelimit-bucket');
    const hRemaining = res.headers.get('x-ratelimit-remaining');
    const hResetAfter = res.headers.get('x-ratelimit-reset-after');
    if (hBucket) {
      this.routeToBucket.set(routeKey, hBucket);
      if (hRemaining !== null && hResetAfter !== null) {
        this.buckets.set(hBucket, {
          remaining: Number(hRemaining),
          resetAt: Date.now() + Number(hResetAfter) * 1000,
        });
      }
    }

    if (res.status === 401) {
      this.dead = true;
      throw new AuthError('Discord rejected the token (401).');
    }

    if (res.status === 429) {
      let body = {};
      try { body = await res.json(); } catch {}
      const retryAfter = Number(body.retry_after ?? res.headers.get('retry-after') ?? 5);
      const until = Date.now() + retryAfter * 1000 + 500;
      if (body.global || res.headers.get('x-ratelimit-global')) this.globalUntil = until;
      else if (hBucket) this.buckets.set(hBucket, { remaining: 0, resetAt: until });
      else this.globalUntil = until;
      console.warn(`[rate limit] 429 on ${routeKey}, waiting ${retryAfter.toFixed(1)}s`);
      if (attempt >= 4) throw new Error('Rate limited repeatedly; giving up on this request.');
      // Back off further on each repeated 429.
      await sleep(attempt * 2000);
      return this._send(method, route, opts, attempt + 1);
    }

    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const msg = (data && data.message) || `HTTP ${res.status}`;
      const err = new Error(`Discord error: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }
}

// ---------------------------------------------------------------------------
// Kept-list persistence. Friends are stored under "<accountId>", servers under "<accountId>:guilds".
// ---------------------------------------------------------------------------

function loadKept() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { return {}; }
}
function saveKept(all) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2));
}
function keptSet(accountId) {
  return new Set(loadKept()[accountId] || []);
}
function setKept(accountId, userId, kept) {
  const all = loadKept();
  const set = new Set(all[accountId] || []);
  if (kept) set.add(userId);
  else set.delete(userId);
  all[accountId] = [...set];
  saveKept(all);
}
const guildKey = (accountId) => `${accountId}:guilds`;
function clearKept(accountId) {
  const all = loadKept();
  delete all[accountId];
  saveKept(all);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const snowflakeTime = (id) => Number((BigInt(id) >> 22n) + DISCORD_EPOCH);

function avatarUrl(user) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`;
  }
  const idx = user.discriminator && user.discriminator !== '0'
    ? Number(user.discriminator) % 5
    : Number((BigInt(user.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
}

function guildIconUrl(g) {
  if (!g.icon) return null;
  const ext = g.icon.startsWith('a_') ? 'gif' : 'png';
  return `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.${ext}?size=256`;
}

// Short text preview of a message for the server card.
function summarize(msg) {
  const text = (msg.content || '').replace(/\s+/g, ' ').trim();
  if (text) return text.length > 90 ? text.slice(0, 89) + '…' : text;
  if (msg.attachments?.length) return '[attachment]';
  if (msg.sticker_items?.length) return '[sticker]';
  if (msg.embeds?.length) return '[embed]';
  return '';
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.discriminator && u.discriminator !== '0' ? `${u.username}#${u.discriminator}` : u.username,
    displayName: u.global_name || u.username,
    avatar: avatarUrl(u),
  };
}

// ---------------------------------------------------------------------------
// Session state (single local user)
// ---------------------------------------------------------------------------

let session = null; // { client, me, activity: Map<guildId, lastMessageResult> }

function requireSession(res) {
  if (!session || session.client.dead) {
    session = null;
    sendJson(res, 401, { error: 'Not logged in.' });
    return null;
  }
  return session;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e5) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); }
    });
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const EMBEDDED_FILES = new Set(['index.html', 'styles.css', 'app.js']);

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');

  if (IS_EXE) {
    if (!EMBEDDED_FILES.has(rel)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(rel)], 'Cache-Control': 'no-store' });
    return res.end(Buffer.from(sea.getAsset(`public/${rel}`)));
  }

  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function handleError(res, err) {
  if (err instanceof CancelledError) {
    if (!res.writableEnded) sendJson(res, 499, { error: 'Cancelled' });
    return;
  }
  if (err instanceof AuthError) {
    session = null;
    return sendJson(res, 401, { error: err.message });
  }
  console.error(err);
  sendJson(res, err.status && err.status < 500 ? err.status : 500, { error: err.message });
}

const validId = (id) => /^\d{15,25}$/.test(String(id));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

const routes = {
  async 'POST /api/login'(req, res) {
    const { token } = await readBody(req);
    const clean = String(token || '').trim().replace(/^"|"$/g, '');
    if (!clean) return sendJson(res, 400, { error: 'Paste a token first.' });
    const client = new DiscordClient(clean);
    try {
      const me = await client.request('GET', '/users/@me', { minGap: [0, 0] });
      session = { client, me, activity: new Map() };
      sendJson(res, 200, { me: publicUser(me) });
    } catch (err) {
      if (err instanceof AuthError) return sendJson(res, 401, { error: 'Discord rejected that token.' });
      handleError(res, err);
    }
  },

  async 'POST /api/logout'(req, res) {
    session = null;
    sendJson(res, 200, { ok: true });
  },

  async 'GET /api/me'(req, res) {
    const s = requireSession(res);
    if (s) sendJson(res, 200, { me: publicUser(s.me) });
  },

  async 'GET /api/friends'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    try {
      const relationships = await s.client.request('GET', '/users/@me/relationships');
      const channels = await s.client.request('GET', '/users/@me/channels');

      // Friend id -> time of the last message in your 1:1 DM, decoded from its snowflake id.
      const lastDm = new Map();
      for (const ch of channels || []) {
        if (ch.type !== 1 || !ch.last_message_id || !ch.recipients?.length) continue;
        const ts = snowflakeTime(ch.last_message_id);
        const rid = ch.recipients[0].id;
        if (!lastDm.has(rid) || lastDm.get(rid) < ts) lastDm.set(rid, ts);
      }

      const kept = keptSet(s.me.id);
      const allFriends = (relationships || []).filter((r) => r.type === 1);
      const friends = allFriends
        .filter((r) => !kept.has(r.id))
        .map((r) => ({
          ...publicUser(r.user),
          nickname: r.nickname || null,
          friendSince: r.since ? Date.parse(r.since) : null,
          lastDm: lastDm.get(r.id) ?? null,
        }))
        .sort((a, b) => (a.friendSince ?? 0) - (b.friendSince ?? 0));

      sendJson(res, 200, { friends, total: allFriends.length, kept: allFriends.length - friends.length });
    } catch (err) { handleError(res, err); }
  },

  async 'POST /api/keep'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    const { id, undo } = await readBody(req);
    if (!validId(id)) return sendJson(res, 400, { error: 'Bad id' });
    setKept(s.me.id, String(id), !undo);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/reset-kept'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    clearKept(s.me.id);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/remove'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    const { id } = await readBody(req);
    if (!validId(id)) return sendJson(res, 400, { error: 'Bad id' });
    try {
      // Removals get a much longer gap than reads: roughly one every 3 to 5 seconds.
      await s.client.request('DELETE', `/users/@me/relationships/${id}`, { minGap: [3000, 5000] });
      sendJson(res, 200, { ok: true });
    } catch (err) { handleError(res, err); }
  },

  // ----------------------------------------------------------------- Servers

  async 'GET /api/guilds'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    try {
      const guilds = await s.client.request('GET', '/users/@me/guilds?with_counts=true&limit=200');
      const kept = keptSet(guildKey(s.me.id));
      const all = guilds || [];
      const list = all
        .filter((g) => !kept.has(g.id))
        .map((g) => ({
          id: g.id,
          name: g.name,
          icon: guildIconUrl(g),
          owner: !!g.owner,
          members: g.approximate_member_count ?? null,
          online: g.approximate_presence_count ?? null,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
      sendJson(res, 200, { guilds: list, total: all.length, kept: all.length - list.length });
    } catch (err) { handleError(res, err); }
  },

  // When you last sent a message in a server, using Discord's message search.
  // Looked up one server at a time as cards come up, cached for the session.
  async 'GET /api/guild-activity'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    if (!validId(id)) return sendJson(res, 400, { error: 'Bad id' });
    if (s.activity.has(id)) return sendJson(res, 200, s.activity.get(id));

    // If the browser gives up on this request (you skipped the card), don't send it to Discord.
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) gone = true; });

    try {
      const route = `/guilds/${id}/messages/search?author_id=${s.me.id}&sort_by=timestamp&sort_order=desc&include_nsfw=true`;
      const data = await s.client.request('GET', route, { minGap: [1500, 2500], isCancelled: () => gone });

      // Discord answers 202 with retry_after while it builds the search index for a server.
      if (data && !data.messages && (data.code === 110000 || data.retry_after)) {
        return sendJson(res, 200, { status: 'indexing', retryAfter: Math.max(5, Number(data.retry_after) || 5) });
      }

      const group = (data && data.messages && data.messages[0]) || null;
      const msg = Array.isArray(group) ? group.find((m) => m.hit) || group[0] : group;
      const result = msg
        ? { status: 'found', at: Date.parse(msg.timestamp), preview: summarize(msg) }
        : { status: 'none' };
      s.activity.set(id, result);
      sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof CancelledError || err instanceof AuthError) return handleError(res, err);
      const result = { status: 'unavailable', reason: err.message };
      if (err.status === 403 || err.status === 404) s.activity.set(id, result);
      sendJson(res, 200, result);
    }
  },

  async 'POST /api/guilds/keep'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    const { id, undo } = await readBody(req);
    if (!validId(id)) return sendJson(res, 400, { error: 'Bad id' });
    setKept(guildKey(s.me.id), String(id), !undo);
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/guilds/reset-kept'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    clearKept(guildKey(s.me.id));
    sendJson(res, 200, { ok: true });
  },

  async 'POST /api/guilds/leave'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    const { id } = await readBody(req);
    if (!validId(id)) return sendJson(res, 400, { error: 'Bad id' });
    try {
      // Same spacing as friend removals: roughly one every 3 to 5 seconds.
      await s.client.request('DELETE', `/users/@me/guilds/${id}`, { minGap: [3000, 5000], body: { lurking: false } });
      s.activity.delete(id);
      sendJson(res, 200, { ok: true });
    } catch (err) { handleError(res, err); }
  },

  async 'GET /api/status'(req, res) {
    const s = requireSession(res);
    if (!s) return;
    const waitMs = Math.max(0, s.client.waitingUntil - Date.now());
    sendJson(res, 200, { queued: s.client.pending, waitMs });
  },
};

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const server = http.createServer(async (req, res) => {
  // Block DNS rebinding: only answer requests addressed to this machine.
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(403); return res.end(); }

  const pathname = new URL(req.url, 'http://x').pathname;
  if (pathname.startsWith('/api/')) {
    // Require JSON on POSTs so other websites can't trigger actions with plain form posts.
    if (req.method === 'POST' && !String(req.headers['content-type']).includes('application/json')) {
      return sendJson(res, 415, { error: 'JSON required' });
    }
    const handler = routes[`${req.method} ${pathname}`];
    if (!handler) return sendJson(res, 404, { error: 'Unknown endpoint' });
    try { await handler(req, res); } catch (err) { handleError(res, err); }
    return;
  }
  if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
  serveStatic(req, res);
});

const APP_URL = `http://${HOST}:${PORT}`;

function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch {}
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Most likely the app is already running: just bring up the page.
    console.log(`Discord Sweeper is already running at ${APP_URL}`);
    if (SHOULD_OPEN_BROWSER) openBrowser(APP_URL);
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Discord Sweeper running at ${APP_URL}`);
  if (IS_EXE) console.log('Keep this window open while you use the app. Close it to quit.');
  if (SHOULD_OPEN_BROWSER) openBrowser(APP_URL);
});
