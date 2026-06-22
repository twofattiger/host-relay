// host-relay — Cloudflare Worker 主机管理面板(M1+M2:状态上报 + 网页面板)
// 单文件部署。首次用 wrangler(声明 DO migration),之后可在 Dashboard 粘贴本文件。
// 网页 SSH(M3)将在 Host DO 与面板中接入 ticket / xterm.js / channel 复用。

import { DurableObject } from 'cloudflare:workers';

// ============================ 配置 ============================
// 各平台客户端下载地址(自行替换为你发布的二进制地址)。
const CLIENT_URL = {
  linux: 'https://github.com/twofattiger/host-relay/releases/latest/download/agent-linux-amd64',
  mac:   'https://github.com/twofattiger/host-relay/releases/latest/download/agent-darwin-arm64',
  win:   'https://github.com/twofattiger/host-relay/releases/latest/download/agent-windows-amd64.exe',
};

const SESSION_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 会话有效期 7 天
const LOGIN_MAX_FAILS  = 8;                        // 连续失败次数上限
const LOGIN_LOCK_MS    = 15 * 60 * 1000;           // 锁定时长
const PENDING_TTL_MS   = 24 * 60 * 60 * 1000;      // pending 主机未上线清理阈值
const CLEANUP_EVERY_MS = 6 * 60 * 60 * 1000;       // 清理任务间隔
const TICKET_TTL_MS    = 30 * 1000;                // SSH ticket 有效期
const HUB_NAME = '_hub';

// ============================ 工具函数 ============================
const enc = new TextEncoder();
const b64url = {
  enc(buf) {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return toHex(d);
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
}

async function signSession(secret, payloadObj) {
  const payload = b64url.enc(enc.encode(JSON.stringify(payloadObj)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return payload + '.' + b64url.enc(sig);
}

async function verifySession(secret, token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const key = await hmacKey(secret);
  const expected = b64url.enc(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
  if (!timingSafeEqual(sig, expected)) return null;
  try {
    const obj = JSON.parse(new TextDecoder().decode(b64url.dec(payload)));
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

function randomToken(bytes = 24) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return b64url.enc(a);
}

function randomHostId() {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return 'h_' + toHex(a);
}

function randomCid() {
  const a = new Uint8Array(2);
  crypto.getRandomValues(a);
  return ((a[0] << 8) | a[1]) || 1;
}

async function aesKeyFrom(secret) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function aesEncrypt(secret, plaintext) {
  const key = await aesKeyFrom(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  return b64url.enc(iv) + '.' + b64url.enc(ct);
}
async function aesDecrypt(secret, blob) {
  const [ivb, ctb] = blob.split('.');
  const key = await aesKeyFrom(secret);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64url.dec(ivb) }, key, b64url.dec(ctb));
  return new TextDecoder().decode(pt);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

function clientIp(req) {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
}

async function isAuthed(req, env) {
  if (!env.SESSION_SECRET) return false;
  const c = parseCookies(req);
  return !!(await verifySession(env.SESSION_SECRET, c.session));
}

function hub(env) {
  return env.HUB.getByName(HUB_NAME);
}

function agentCommand(host, hostId, token) {
  return `agent --server wss://${host} --id ${hostId} --token ${token} --ssh-target 127.0.0.1:22`;
}

// ============================ Worker 入口 ============================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const upgrade = (request.headers.get('Upgrade') || '').toLowerCase() === 'websocket';

    try {
      // ---- agent 长连接(无需会话,DO 内用 token 校验) ----
      if (path === '/ws/agent') {
        if (!upgrade) return new Response('expected websocket', { status: 426 });
        const id = url.searchParams.get('id');
        if (!id) return new Response('missing id', { status: 400 });
        return env.HOST.getByName(id).fetch(request);
      }

      // ---- 浏览器状态订阅(需会话) ----
      if (path === '/ws/status') {
        if (!upgrade) return new Response('expected websocket', { status: 426 });
        if (!(await isAuthed(request, env))) return new Response('unauthorized', { status: 401 });
        return hub(env).fetch(request);
      }

      // ---- 网页 SSH(用 ticket 鉴权,DO 内再次校验 nonce/归属) ----
      if (path === '/ws/ssh') {
        if (!upgrade) return new Response('expected websocket', { status: 426 });
        if (!env.TICKET_KEY) return new Response('ticket key not configured', { status: 500 });
        const ticket = url.searchParams.get('ticket');
        const obj = await verifySession(env.TICKET_KEY, ticket);
        if (!obj || !obj.h) return new Response('bad ticket', { status: 401 });
        return env.HOST.getByName(obj.h).fetch(request);
      }

      // ---- 页面 ----
      if (path === '/' && request.method === 'GET') {
        return new Response(PAGE_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      if (path === '/term' && request.method === 'GET') {
        if (!(await isAuthed(request, env))) return new Response('unauthorized', { status: 401 });
        return new Response(TERM_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      // ---- API ----
      if (path === '/api/ip' && request.method === 'GET') {
        return new Response(clientIp(request), { headers: { 'Content-Type': 'text/plain' } });
      }

      if (path === '/api/me' && request.method === 'GET') {
        return json({ authed: await isAuthed(request, env) });
      }

      if (path === '/api/login' && request.method === 'POST') {
        const ip = clientIp(request);
        const locked = await hub(env).loginLocked(ip);
        if (locked) return json({ ok: false, error: '尝试过于频繁,请稍后再试' }, { status: 429 });
        const body = await request.json().catch(() => ({}));
        if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
          return json({ ok: false, error: '服务端未配置 ADMIN_PASSWORD / SESSION_SECRET' }, { status: 500 });
        }
        if (typeof body.password === 'string' && timingSafeEqual(body.password, env.ADMIN_PASSWORD)) {
          await hub(env).loginReset(ip);
          const token = await signSession(env.SESSION_SECRET, { exp: Date.now() + SESSION_TTL_MS });
          return json({ ok: true }, {
            headers: {
              'Set-Cookie': `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`,
            },
          });
        }
        await hub(env).loginFail(ip);
        return json({ ok: false, error: '密码错误' }, { status: 401 });
      }

      if (path === '/api/logout' && request.method === 'POST') {
        return json({ ok: true }, {
          headers: { 'Set-Cookie': 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' },
        });
      }

      // 以下接口均需会话
      if (path.startsWith('/api/')) {
        if (!(await isAuthed(request, env))) return json({ error: 'unauthorized' }, { status: 401 });

        if (path === '/api/hosts' && request.method === 'GET') {
          return json({ hosts: await hub(env).listHosts() });
        }

        if (path === '/api/enroll' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const name = (body.displayName || '').toString().slice(0, 64) || '未命名主机';
          const { hostId, token } = await hub(env).enroll(name);
          return json({ hostId, token, command: agentCommand(url.host, hostId, token), clients: CLIENT_URL });
        }

        if (path === '/api/regenerate' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const r = await hub(env).regenerate((body.hostId || '').toString());
          if (!r) return json({ error: '主机不存在' }, { status: 404 });
          return json({ token: r.token, command: agentCommand(url.host, r.hostId, r.token), clients: CLIENT_URL });
        }

        if (path === '/api/delete' && request.method === 'POST') {
          const body = await request.json().catch(() => ({}));
          await hub(env).deleteHost((body.hostId || '').toString());
          return json({ ok: true });
        }

        if (path === '/api/ticket' && request.method === 'POST') {
          if (!env.TICKET_KEY) return json({ error: '服务端未配置 TICKET_KEY' }, { status: 500 });
          const body = await request.json().catch(() => ({}));
          const hostId = (body.hostId || '').toString();
          const ticket = await signSession(env.TICKET_KEY, {
            exp: Date.now() + TICKET_TTL_MS, h: hostId, n: randomToken(8),
          });
          return json({ ticket });
        }
      }

      return new Response('not found', { status: 404 });
    } catch (e) {
      return json({ error: 'internal', detail: String(e && e.message || e) }, { status: 500 });
    }
  },
};

// ============================ Hub DO(单例) ============================
// 主机注册表 + 状态快照 + 浏览器订阅广播 + 登录防爆破 + pending 清理。
export class Hub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS hosts(
      hostId TEXT PRIMARY KEY,
      displayName TEXT,
      os TEXT,
      tokenHash TEXT,
      state TEXT,
      lastSeen INTEGER,
      statusJson TEXT,
      createdAt INTEGER
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS login_attempts(
      ip TEXT PRIMARY KEY, fails INTEGER, lockUntil INTEGER
    )`);
  }

  // ---------- 浏览器订阅 WS ----------
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['sub']);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // 连接即推送全量快照
    server.send(JSON.stringify({ type: 'snapshot', hosts: this._hostList() }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    // 浏览器侧目前仅需接收;预留处理(忽略)。
  }
  async webSocketClose(ws) {}
  async webSocketError(ws) {}

  _broadcastHost(hostId) {
    const h = this._getHost(hostId);
    if (!h) return;
    const data = JSON.stringify({ type: 'host', host: this._view(h) });
    for (const ws of this.ctx.getWebSockets('sub')) {
      try { ws.send(data); } catch {}
    }
  }
  _broadcastRemove(hostId) {
    const data = JSON.stringify({ type: 'remove', hostId });
    for (const ws of this.ctx.getWebSockets('sub')) {
      try { ws.send(data); } catch {}
    }
  }

  // ---------- 视图(对外不暴露 tokenHash) ----------
  _view(h) {
    let status = null;
    try { status = h.statusJson ? JSON.parse(h.statusJson) : null; } catch {}
    return {
      hostId: h.hostId, displayName: h.displayName, os: h.os,
      state: h.state, lastSeen: h.lastSeen, status,
    };
  }
  _getHost(hostId) {
    const c = this.sql.exec('SELECT * FROM hosts WHERE hostId = ?', hostId).toArray();
    return c[0] || null;
  }
  _hostList() {
    // 面板只显示 active / offline(pending 不显示)
    return this.sql.exec(
      "SELECT * FROM hosts WHERE state IN ('active','offline') ORDER BY displayName"
    ).toArray().map((h) => this._view(h));
  }

  // ---------- 注册 / 令牌 ----------
  async enroll(displayName) {
    const hostId = randomHostId();
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    this.sql.exec(
      'INSERT INTO hosts(hostId, displayName, os, tokenHash, state, lastSeen, statusJson, createdAt) VALUES(?,?,?,?,?,?,?,?)',
      hostId, displayName, '', tokenHash, 'pending', 0, null, now,
    );
    await this.env.HOST.getByName(hostId).provision(hostId, tokenHash);
    await this._ensureAlarm();
    return { hostId, token };
  }

  async regenerate(hostId) {
    const h = this._getHost(hostId);
    if (!h) return null;
    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    this.sql.exec('UPDATE hosts SET tokenHash = ? WHERE hostId = ?', tokenHash, hostId);
    // 作废旧 token:更新 Host DO 并踢掉当前 agent(若在线),迫使用新 token 重连
    await this.env.HOST.getByName(hostId).resetToken(tokenHash);
    return { hostId, token };
  }

  async deleteHost(hostId) {
    this.sql.exec('DELETE FROM hosts WHERE hostId = ?', hostId);
    try { await this.env.HOST.getByName(hostId).deprovision(); } catch {}
    this._broadcastRemove(hostId);
  }

  async listHosts() { return this._hostList(); }

  // ---------- 由 Host DO 回调 ----------
  async activate(hostId, os) {
    const h = this._getHost(hostId);
    if (!h) return;
    this.sql.exec('UPDATE hosts SET state = ?, os = ?, lastSeen = ? WHERE hostId = ?',
      'active', os || h.os || '', Date.now(), hostId);
    this._broadcastHost(hostId);
  }

  async updateStatus(hostId, statusJson) {
    const h = this._getHost(hostId);
    if (!h) return;
    const os = (() => { try { return JSON.parse(statusJson).platform || h.os; } catch { return h.os; } })();
    this.sql.exec('UPDATE hosts SET state = ?, statusJson = ?, lastSeen = ?, os = ? WHERE hostId = ?',
      'active', statusJson, Date.now(), os, hostId);
    this._broadcastHost(hostId);
  }

  async markOffline(hostId) {
    const h = this._getHost(hostId);
    if (!h || h.state === 'pending') return;
    this.sql.exec('UPDATE hosts SET state = ?, lastSeen = ? WHERE hostId = ?', 'offline', Date.now(), hostId);
    this._broadcastHost(hostId);
  }

  // ---------- 登录防爆破 ----------
  async loginLocked(ip) {
    const r = this.sql.exec('SELECT lockUntil FROM login_attempts WHERE ip = ?', ip).toArray()[0];
    return !!(r && r.lockUntil && r.lockUntil > Date.now());
  }
  async loginFail(ip) {
    const r = this.sql.exec('SELECT fails FROM login_attempts WHERE ip = ?', ip).toArray()[0];
    const fails = (r ? r.fails : 0) + 1;
    const lockUntil = fails >= LOGIN_MAX_FAILS ? Date.now() + LOGIN_LOCK_MS : 0;
    this.sql.exec('INSERT INTO login_attempts(ip, fails, lockUntil) VALUES(?,?,?) ' +
      'ON CONFLICT(ip) DO UPDATE SET fails = ?, lockUntil = ?', ip, fails, lockUntil, fails, lockUntil);
  }
  async loginReset(ip) { this.sql.exec('DELETE FROM login_attempts WHERE ip = ?', ip); }

  // ---------- pending 清理 ----------
  async _ensureAlarm() {
    const cur = await this.ctx.storage.getAlarm();
    if (cur === null) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }
  async alarm() {
    const cutoff = Date.now() - PENDING_TTL_MS;
    const stale = this.sql.exec(
      "SELECT hostId FROM hosts WHERE state = 'pending' AND createdAt < ?", cutoff
    ).toArray();
    for (const row of stale) {
      this.sql.exec('DELETE FROM hosts WHERE hostId = ?', row.hostId);
      try { await this.env.HOST.getByName(row.hostId).deprovision(); } catch {}
    }
    const remain = this.sql.exec('SELECT COUNT(*) AS n FROM hosts').toArray()[0];
    if (remain && remain.n > 0) await this.ctx.storage.setAlarm(Date.now() + CLEANUP_EVERY_MS);
  }
}

// ============================ Host DO(每主机一个) ============================
// 持有该主机 agent 长连接;令牌校验;状态转发 Hub;首次上线激活。
// 网页 SSH(M3)将在此 DO 内复用 channelId 转发终端字节。
export class Host extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  // 由 Hub 在 enroll 时种入身份
  async provision(hostId, tokenHash) {
    await this.ctx.storage.put('hostId', hostId);
    await this.ctx.storage.put('tokenHash', tokenHash);
  }
  async resetToken(tokenHash) {
    await this.ctx.storage.put('tokenHash', tokenHash);
    // 踢掉当前 agent(旧 token 已失效)
    for (const ws of this.ctx.getWebSockets('agent')) {
      try { ws.close(4001, 'token rotated'); } catch {}
    }
  }
  async deprovision() {
    for (const ws of this.ctx.getWebSockets('agent')) {
      try { ws.close(4002, 'host removed'); } catch {}
    }
    await this.ctx.storage.deleteAll();
  }

  // WS 接入:agent(/ws/agent)或 网页终端(/ws/ssh)
  async fetch(request) {
    const url = new URL(request.url);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    if (url.pathname === '/ws/ssh') {
      if (!this.env.TICKET_KEY) return new Response('ticket key not configured', { status: 500 });
      const ticket = url.searchParams.get('ticket');
      const obj = await verifySession(this.env.TICKET_KEY, ticket);
      const myId = await this.ctx.storage.get('hostId');
      if (!obj || obj.h !== myId) return new Response('bad ticket', { status: 401 });
      const nkey = 'nonce:' + obj.n;
      if (await this.ctx.storage.get(nkey)) return new Response('ticket replay', { status: 401 });
      await this.ctx.storage.put(nkey, obj.exp); // 一次性
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ role: 'browser', cid: randomCid() });
      this.ctx.acceptWebSocket(server, ['browser']);
      return new Response(null, { status: 101, webSocket: client });
    }

    // 默认:agent 长连接
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, ['agent']);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'browser') return this._fromBrowser(ws, att, raw);
    return this._fromAgent(ws, att, raw);
  }

  // ---------- agent 侧 ----------
  async _fromAgent(ws, att, raw) {
    if (typeof raw !== 'string') {
      // [0x01][cid:2][stdout] → 转发对应 browser
      const u = new Uint8Array(raw);
      if (u[0] !== 1 || u.length < 3) return;
      const cid = (u[1] << 8) | u[2];
      const b = this._browserByCid(cid);
      if (b) { try { b.send(u.subarray(3)); } catch {} }
      return;
    }
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'register') {
      const storedHash = await this.ctx.storage.get('tokenHash');
      const hostId = await this.ctx.storage.get('hostId');
      const ok = storedHash && hostId && typeof msg.token === 'string'
        && timingSafeEqual(await sha256Hex(msg.token), storedHash);
      if (!ok) {
        try { ws.send(JSON.stringify({ type: 'error', msg: '令牌无效' })); } catch {}
        try { ws.close(4003, 'invalid token'); } catch {}
        return;
      }
      ws.serializeAttachment({ authed: true, hostId });
      const os = msg.os ? (msg.os + (msg.arch ? '/' + msg.arch : '')) : '';
      await this.env.HUB.getByName(HUB_NAME).activate(hostId, os);
      try { ws.send(JSON.stringify({ type: 'registered' })); } catch {}
      return;
    }

    if (!att.authed) { try { ws.close(4003, 'not registered'); } catch {} return; }

    if (msg.type === 'status') {
      await this.env.HUB.getByName(HUB_NAME).updateStatus(att.hostId, JSON.stringify(msg));
      return;
    }
    if (msg.type === 'ssh_opened' || msg.type === 'ssh_error' || msg.type === 'ssh_close') {
      const b = this._browserByCid(msg.channelId);
      if (b) {
        try { b.send(JSON.stringify({ type: msg.type, msg: msg.msg })); } catch {}
        if (msg.type !== 'ssh_opened') { try { b.close(1000, 'session ended'); } catch {} }
      }
      return;
    }
  }

  // ---------- browser 侧 ----------
  async _fromBrowser(ws, att, raw) {
    const agent = this._agentWs();
    if (typeof raw !== 'string') {
      // stdin 字节 → [0x01][cid][payload] → agent
      if (!agent) return;
      const payload = new Uint8Array(raw);
      const f = new Uint8Array(3 + payload.length);
      f[0] = 1; f[1] = (att.cid >> 8) & 255; f[2] = att.cid & 255; f.set(payload, 3);
      try { agent.send(f); } catch {}
      return;
    }
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'auth') {
      if (!agent) { this._sendBrowser(ws, { type: 'ssh_error', msg: '主机离线,无法连接' }); try { ws.close(); } catch {} return; }
      let credential = '';
      if ((msg.authType || 'password') === 'password') {
        credential = msg.password || '';
        const ckey = 'cred:' + (msg.username || '');
        if (!credential) {
          const saved = await this.ctx.storage.get(ckey);
          if (saved && this.env.ENC_KEY) { try { credential = await aesDecrypt(this.env.ENC_KEY, saved); } catch {} }
          if (!credential) { this._sendBrowser(ws, { type: 'ssh_error', msg: '需要密码(无已保存密码)' }); return; }
        } else if (msg.save && this.env.ENC_KEY) {
          try { await this.ctx.storage.put(ckey, await aesEncrypt(this.env.ENC_KEY, credential)); } catch {}
        }
      }
      try {
        agent.send(JSON.stringify({
          type: 'ssh_open', channelId: att.cid, username: msg.username || 'root',
          authType: msg.authType || 'password', credential, cols: msg.cols || 80, rows: msg.rows || 24,
        }));
      } catch {}
      return;
    }
    if (msg.type === 'resize' && agent) {
      try { agent.send(JSON.stringify({ type: 'resize', channelId: att.cid, cols: msg.cols, rows: msg.rows })); } catch {}
      return;
    }
  }

  _agentWs() {
    for (const ws of this.ctx.getWebSockets('agent')) {
      const a = ws.deserializeAttachment();
      if (a && a.authed) return ws;
    }
    return null;
  }
  _browserByCid(cid) {
    for (const ws of this.ctx.getWebSockets('browser')) {
      const a = ws.deserializeAttachment();
      if (a && a.cid === cid) return ws;
    }
    return null;
  }
  _sendBrowser(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  async webSocketClose(ws) {
    const att = ws.deserializeAttachment() || {};
    if (att.role === 'browser') {
      const agent = this._agentWs();
      if (agent) { try { agent.send(JSON.stringify({ type: 'ssh_close', channelId: att.cid })); } catch {} }
      return;
    }
    if (att.authed && att.hostId) {
      try { await this.env.HUB.getByName(HUB_NAME).markOffline(att.hostId); } catch {}
      for (const b of this.ctx.getWebSockets('browser')) {
        try { b.send(JSON.stringify({ type: 'ssh_close', msg: '主机连接已断开' })); } catch {}
        try { b.close(1000, 'agent gone'); } catch {}
      }
    }
  }
  async webSocketError(ws) {}
}

// ============================ 内联面板(HTML/CSS/JS) ============================
// 设计:控制室风格,深色 slate 底,等宽字体呈现数据,青色信号色 + 琥珀/红表示离线告警。
// 纯系统字体,无 CDN 依赖,便于国内访问。客户端 JS 避免使用反引号模板。
const PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>host-relay</title>
<style>
  :root{
    --bg:#0e1116; --panel:#161b22; --panel-2:#1c232d; --line:#2a3441;
    --txt:#d6dee8; --muted:#7d8a9c; --signal:#3fd6c8; --signal-dim:#1f5e58;
    --amber:#e0a341; --red:#e05a5a; --green:#3fd67a;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--txt);font-family:var(--sans);
    -webkit-font-smoothing:antialiased;line-height:1.5}
  a{color:var(--signal)}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 20px 64px}
  header{display:flex;align-items:center;justify-content:space-between;
    padding:18px 0;border-bottom:1px solid var(--line);margin-bottom:24px}
  .brand{font-family:var(--mono);font-size:18px;letter-spacing:.5px}
  .brand b{color:var(--signal)}
  .brand .tag{color:var(--muted);font-size:12px;margin-left:10px}
  button{font-family:var(--sans);cursor:pointer;border-radius:8px;border:1px solid var(--line);
    background:var(--panel-2);color:var(--txt);padding:8px 14px;font-size:14px}
  button:hover{border-color:var(--signal-dim)}
  button.primary{background:var(--signal);color:#06231f;border-color:var(--signal);font-weight:600}
  button.primary:hover{filter:brightness(1.08)}
  button.ghost{background:transparent}
  button.danger:hover{border-color:var(--red);color:var(--red)}
  button:focus-visible{outline:2px solid var(--signal);outline-offset:2px}
  .toolbar{display:flex;gap:10px;align-items:center}

  /* 登录 */
  .login{max-width:360px;margin:14vh auto 0;padding:28px;background:var(--panel);
    border:1px solid var(--line);border-radius:14px}
  .login h1{font-family:var(--mono);font-size:20px;margin:0 0 4px}
  .login p{color:var(--muted);font-size:13px;margin:0 0 20px}
  .field{display:block;margin-bottom:14px}
  .field input{width:100%;padding:11px 12px;border-radius:8px;border:1px solid var(--line);
    background:var(--bg);color:var(--txt);font-family:var(--mono);font-size:14px}
  .field input:focus{outline:none;border-color:var(--signal)}
  .err{color:var(--red);font-size:13px;min-height:18px;margin:-4px 0 10px}

  /* 卡片 */
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .empty{color:var(--muted);text-align:center;padding:60px 0;font-size:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 16px 14px;
    position:relative;overflow:hidden}
  .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--line)}
  .card.online::before{background:var(--signal)}
  .card.offline::before{background:var(--muted)}
  .card .name{font-weight:600;font-size:15px;display:flex;align-items:center;gap:8px}
  .dot{width:8px;height:8px;border-radius:50%;background:var(--muted);flex:none}
  .card.online .dot{background:var(--green);box-shadow:0 0 0 0 rgba(63,214,122,.6);animation:pulse 2s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,214,122,.5)}70%{box-shadow:0 0 0 6px rgba(63,214,122,0)}100%{box-shadow:0 0 0 0 rgba(63,214,122,0)}}
  @media (prefers-reduced-motion:reduce){.card.online .dot{animation:none}}
  .card .meta{font-family:var(--mono);font-size:11px;color:var(--muted);margin:3px 0 14px}
  .metric{margin:10px 0}
  .metric .lbl{display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px}
  .metric .lbl b{color:var(--txt);font-family:var(--mono);font-weight:500}
  .bar{height:6px;border-radius:4px;background:var(--panel-2);overflow:hidden}
  .bar i{display:block;height:100%;background:var(--signal);border-radius:4px;transition:width .4s}
  .bar.warn i{background:var(--amber)} .bar.crit i{background:var(--red)}
  .card .foot{display:flex;justify-content:space-between;align-items:center;margin-top:14px;
    padding-top:12px;border-top:1px solid var(--line)}
  .card .foot .when{font-size:11px;color:var(--muted);font-family:var(--mono)}
  .card .foot .acts{display:flex;gap:6px}
  .card .foot button{padding:5px 9px;font-size:12px}
  .offnote{color:var(--muted);font-size:12px;padding:8px 0}
  .ips{font-size:11px;font-family:var(--mono);color:var(--muted);margin:8px 0 0 0;}
  .ips .pub{display:inline-flex;align-items:center;cursor:pointer;padding:2px 6px;background:var(--panel-2);border-radius:4px;}
  .ips .pub:hover{color:var(--txt);}
  .ips .pub svg{width:10px;height:10px;margin-left:4px;transition:transform .2s;}
  .ips.open .pub svg{transform:rotate(180deg);}
  .ips .locals{display:none;margin-top:6px;padding-left:4px;border-left:2px solid var(--line);}
  .ips.open .locals{display:block;}
  .ips .locals div{margin-bottom:2px;}

  /* 弹层 */
  .mask{position:fixed;inset:0;background:rgba(5,8,12,.7);display:flex;align-items:flex-start;
    justify-content:center;padding:8vh 16px;z-index:50}
  .modal{width:560px;max-width:100%;background:var(--panel);border:1px solid var(--line);
    border-radius:14px;padding:22px}
  .modal h2{font-family:var(--mono);font-size:17px;margin:0 0 16px;display:flex;justify-content:space-between}
  .modal h2 .x{cursor:pointer;color:var(--muted)}
  .step{margin-bottom:18px}
  .step .h{font-size:13px;color:var(--muted);margin-bottom:8px}
  .dl a{display:block;font-family:var(--mono);font-size:13px;padding:9px 12px;border:1px solid var(--line);
    border-radius:8px;margin-bottom:7px;text-decoration:none;color:var(--txt);word-break:break-all}
  .dl a:hover{border-color:var(--signal-dim)}
  .dl a span{color:var(--muted);margin-right:8px}
  .cmd{position:relative}
  .cmd pre{font-family:var(--mono);font-size:12.5px;background:var(--bg);border:1px solid var(--line);
    border-radius:8px;padding:14px 14px;margin:0;white-space:pre-wrap;word-break:break-all;color:var(--signal)}
  .cmd .copy{position:absolute;top:8px;right:8px;padding:4px 10px;font-size:12px}
  .hint{font-size:12px;color:var(--amber);margin-top:10px}
  .row-name{display:flex;gap:8px;margin-bottom:14px}
  .row-name input{flex:1;padding:10px 12px;border-radius:8px;border:1px solid var(--line);
    background:var(--bg);color:var(--txt);font-size:14px}
  .row-name input:focus{outline:none;border-color:var(--signal)}
</style>
</head>
<body>
<div id="app"></div>
<script>
"use strict";
var app = document.getElementById("app");
var ws = null;
var hosts = {};

function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;"}[c]; }); }
function fmtBytes(n){ if(!n&&n!==0) return "-"; var u=["B","KB","MB","GB","TB"],i=0;
  while(n>=1024&&i<u.length-1){n/=1024;i++;} return n.toFixed(n<10&&i>0?1:0)+u[i]; }
function fmtUptime(s){ if(!s) return "-"; s=Math.floor(s); var d=Math.floor(s/86400);
  var h=Math.floor((s%86400)/3600); var m=Math.floor((s%3600)/60);
  if(d>0) return d+"d "+h+"h"; if(h>0) return h+"h "+m+"m"; return m+"m"; }
function ago(ts){ if(!ts) return "从未"; var s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return s+"s 前"; if(s<3600) return Math.floor(s/60)+"m 前";
  if(s<86400) return Math.floor(s/3600)+"h 前"; return Math.floor(s/86400)+"d 前"; }

function api(path, body){
  return fetch(path, {method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify(body||{})}).then(function(r){ return r.json().then(function(j){
      return {status:r.status, body:j}; }); });
}

// ---------------- 登录 ----------------
function renderLogin(errMsg){
  app.innerHTML =
    '<div class="login"><h1>host-relay</h1>'+
    '<p>主机管理面板 · 请登录</p>'+
    '<div class="field"><input id="pw" type="password" placeholder="密码" autofocus></div>'+
    '<div class="err" id="le">'+esc(errMsg||"")+'</div>'+
    '<button class="primary" id="lb" style="width:100%">登录</button></div>';
  var pw=document.getElementById("pw"), lb=document.getElementById("lb");
  function go(){ lb.disabled=true;
    api("/api/login",{password:pw.value}).then(function(r){
      if(r.body.ok){ boot(); } else { lb.disabled=false;
        document.getElementById("le").textContent=r.body.error||"登录失败"; pw.focus(); } });
  }
  lb.onclick=go; pw.onkeydown=function(e){ if(e.key==="Enter") go(); };
}

// ---------------- 主面板 ----------------
function renderApp(){
  app.innerHTML =
    '<div class="wrap"><header>'+
    '<div class="brand"><b>host</b>-relay<span class="tag">主机管理面板</span></div>'+
    '<div class="toolbar">'+
    '<button class="primary" id="add">添加主机</button>'+
    '<button class="ghost" id="logout">退出</button>'+
    '</div></header><div id="list"></div></div>';
  document.getElementById("add").onclick=openAdd;
  document.getElementById("logout").onclick=function(){
    api("/api/logout",{}).then(function(){ if(ws) ws.close(); renderLogin(); }); };
  renderList();
}

function renderList(){
  var list=document.getElementById("list"); if(!list) return;
  var ids=Object.keys(hosts);
  if(ids.length===0){ list.innerHTML='<div class="empty">还没有主机。点击「添加主机」生成客户端运行命令。</div>'; return; }
  list.className="grid";
  list.innerHTML=ids.map(function(id){ return cardHtml(hosts[id]); }).join("");
  ids.forEach(function(id){
    var del=document.getElementById("del-"+id), rg=document.getElementById("rg-"+id), mg=document.getElementById("mg-"+id);
    var ipt=document.getElementById("ip-"+id);
    if(del) del.onclick=function(){ confirmDelete(id); };
    if(rg) rg.onclick=function(){ confirmRegen(id); };
    if(mg) mg.onclick=function(){ openTerm(id); };
    if(ipt) ipt.onclick=function(){ ipt.parentElement.classList.toggle("open"); };
  });
}

function confirmDelete(id) {
  var h = hosts[id];
  if (!h) return;
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal"><h2>删除主机<span class="x">&times;</span></h2>'+
    '<div class="step"><div class="h">此操作不可逆。将永久删除该主机及所有相关数据。</div></div>'+
    '<div class="step" style="margin-bottom:6px;"><div class="h">请输入 <b>'+esc(h.displayName)+'</b> 以确认:</div></div>'+
    '<div class="row-name" style="margin-bottom:16px;"><input id="dn-del" autocomplete="off" autofocus></div>'+
    '<button class="primary" id="do-del" style="width:100%;background:var(--red);border-color:var(--red);color:#fff;opacity:0.5;" disabled>我了解后果，删除此主机</button></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  
  var input = mask.querySelector("#dn-del");
  var btn = mask.querySelector("#do-del");
  input.oninput = function() {
    if(input.value === h.displayName) {
      btn.disabled = false;
      btn.style.opacity = "1";
    } else {
      btn.disabled = true;
      btn.style.opacity = "0.5";
    }
  };
  btn.onclick=function(){
    if(input.value === h.displayName) {
      close();
      api("/api/delete",{hostId:id});
    }
  };
}

function confirmRegen(id) {
  var h = hosts[id];
  if (!h) return;
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal"><h2>重新生成令牌<span class="x">&times;</span></h2>'+
    '<div class="step"><div class="h">正在为「'+esc(h.displayName)+'」重新生成令牌</div></div>'+
    '<div class="hint" style="margin-bottom:16px;">⚠️ 警告：旧令牌将立即失效！如果该主机目前在线，它会被强制踢下线，直到你在目标主机上使用新令牌重新运行 agent。</div>'+
    '<div style="text-align:right"><button class="ghost x-btn" style="margin-right:10px">取消</button><button class="primary" id="do-regen" style="background:var(--red);border-color:var(--red);color:#fff;">确认生成</button></div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.querySelector(".x-btn").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  mask.querySelector("#do-regen").onclick=function(){
    close();
    regen(id);
  };
}

function openTerm(id){
  api("/api/ticket",{hostId:id}).then(function(r){
    if(!r.body.ticket){ alert("无法打开终端"); return; }
    window.open("/term#"+encodeURIComponent(r.body.ticket), "_blank", "width=960,height=620");
  });
}

function bar(pct){ var cls=pct>=90?"crit":pct>=70?"warn":""; pct=Math.max(0,Math.min(100,pct||0));
  return '<div class="bar '+cls+'"><i style="width:'+pct+'%"></i></div>'; }

function cardHtml(h){
  var on = h.state==="active";
  var s = h.status||{};
  var head =
    '<div class="name"><span class="dot"></span>'+esc(h.displayName)+'</div>'+
    '<div class="meta">'+esc(h.os||"-")+(s.hostname?' · '+esc(s.hostname):'')+' · '+esc(h.hostId)+'</div>';
  var body;
  if(on && h.status){
    var memPct = s.memTotal? (s.memUsed/s.memTotal*100):0;
    var diskPct = s.diskTotal? (s.diskUsed/s.diskTotal*100):0;
    body =
      '<div class="metric"><div class="lbl"><span>CPU</span><b>'+(s.cpu!=null?s.cpu.toFixed(0):"-")+'%</b></div>'+bar(s.cpu)+'</div>'+
      '<div class="metric"><div class="lbl"><span>内存</span><b>'+fmtBytes(s.memUsed)+' / '+fmtBytes(s.memTotal)+'</b></div>'+bar(memPct)+'</div>'+
      '<div class="metric"><div class="lbl"><span>磁盘</span><b>'+fmtBytes(s.diskUsed)+' / '+fmtBytes(s.diskTotal)+'</b></div>'+bar(diskPct)+'</div>'+
      '<div class="metric"><div class="lbl"><span>运行</span><b>'+fmtUptime(s.uptime)+(s.load1!=null?'  ·  load '+s.load1.toFixed(2):'')+'</b></div></div>';
    
    if(s.publicIp || (s.localIps && s.localIps.length > 0)) {
      var pub = s.publicIp || "未知外网 IP";
      var locals = (s.localIps || []).map(function(ip){ return "<div>"+esc(ip)+"</div>"; }).join("");
      body += '<div class="ips"><div class="pub" id="ip-'+h.hostId+'">'+esc(pub)+
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg></div>'+
              (locals ? '<div class="locals">'+locals+'</div>' : '') + '</div>';
    }
  } else {
    body = '<div class="offnote">离线 · 暂无实时数据</div>';
  }
  var foot =
    '<div class="foot"><span class="when">'+(on?"在线":"最后在线 "+ago(h.lastSeen))+'</span>'+
    '<span class="acts">'+
    (on?'<button class="primary" id="mg-'+h.hostId+'">管理</button>':'')+
    '<button id="rg-'+h.hostId+'">重新生成令牌</button>'+
    '<button class="danger" id="del-'+h.hostId+'">删除</button>'+
    '</span></div>';
  return '<div class="card '+(on?"online":"offline")+'">'+head+body+foot+'</div>';
}

// ---------------- 添加主机弹层 ----------------
function openAdd(){
  var mask=document.createElement("div"); mask.className="mask";
  mask.innerHTML=
    '<div class="modal"><h2>添加主机<span class="x">&times;</span></h2>'+
    '<div class="row-name"><input id="dn" placeholder="主机名称(如:家里 NAS)" autofocus>'+
    '<button class="primary" id="gen">生成</button></div>'+
    '<div id="result"></div></div>';
  document.body.appendChild(mask);
  function close(){ document.body.removeChild(mask); }
  mask.querySelector(".x").onclick=close;
  mask.onclick=function(e){ if(e.target===mask) close(); };
  var dn=mask.querySelector("#dn");
  mask.querySelector("#gen").onclick=function(){
    api("/api/enroll",{displayName:dn.value}).then(function(r){
      if(r.body.command) showEnroll(mask.querySelector("#result"), r.body); });
  };
  dn.onkeydown=function(e){ if(e.key==="Enter") mask.querySelector("#gen").click(); };
}

function clientRows(clients){
  var labels={mac:"macOS",linux:"Linux",win:"Windows"};
  return Object.keys(clients).map(function(k){
    return '<a href="'+esc(clients[k])+'" target="_blank" rel="noopener">'+
      '<span>'+(labels[k]||k)+'</span>'+esc(clients[k])+'</a>'; }).join("");
}

function showEnroll(el, data){
  el.innerHTML=
    '<div class="step"><div class="h">1 · 下载客户端(选择对应平台)</div>'+
    '<div class="dl">'+clientRows(data.clients)+'</div></div>'+
    '<div class="step"><div class="h">2 · 在目标主机执行(令牌仅显示一次)</div>'+
    '<div class="cmd"><pre id="cmd">'+esc(data.command)+'</pre>'+
    '<button class="copy" id="cp">复制</button></div>'+
    '<div class="hint">令牌只显示这一次,关闭后无法再查看。丢失可在卡片上「重新生成令牌」。</div></div>';
  el.querySelector("#cp").onclick=function(){
    navigator.clipboard.writeText(data.command).then(function(){
      el.querySelector("#cp").textContent="已复制"; }); };
}

function regen(id){
  api("/api/regenerate",{hostId:id}).then(function(r){
    if(!r.body.command){ alert(r.body.error||"失败"); return; }
    var mask=document.createElement("div"); mask.className="mask";
    mask.innerHTML='<div class="modal"><h2>新令牌<span class="x">&times;</span></h2><div id="result"></div></div>';
    document.body.appendChild(mask);
    mask.querySelector(".x").onclick=function(){ document.body.removeChild(mask); };
    mask.onclick=function(e){ if(e.target===mask) document.body.removeChild(mask); };
    showEnroll(mask.querySelector("#result"), {command:r.body.command, clients:r.body.clients});
  });
}

// ---------------- 状态 WS ----------------
function connectWS(){
  var proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(proto+"//"+location.host+"/ws/status");
  ws.onmessage=function(ev){
    var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
    if(m.type==="snapshot"){ hosts={}; m.hosts.forEach(function(h){ hosts[h.hostId]=h; }); renderList(); }
    else if(m.type==="host"){ hosts[m.host.hostId]=m.host; renderList(); }
    else if(m.type==="remove"){ delete hosts[m.hostId]; renderList(); }
  };
  ws.onclose=function(){ setTimeout(function(){ if(document.getElementById("list")) connectWS(); }, 3000); };
}

// ---------------- 启动 ----------------
function boot(){
  fetch("/api/me").then(function(r){ return r.json(); }).then(function(j){
    if(j.authed){ renderApp(); connectWS(); } else { renderLogin(); } });
}
boot();
</script>
</body>
</html>`;

// ============================ 网页终端(/term)============================
// xterm.js 走 cdnjs(Cloudflare CDN,国内可达)。ticket 从 location.hash 读取(不入服务端日志)。
const TERM_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>host-relay · 终端</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
<style>
  html,body{margin:0;height:100%;background:#0e1116;color:#d6dee8;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
  #term{position:absolute;inset:0;padding:6px}
  .overlay{position:absolute;inset:0;background:rgba(8,11,16,.92);display:flex;
    align-items:center;justify-content:center;z-index:10}
  .box{width:340px;background:#161b22;border:1px solid #2a3441;border-radius:14px;padding:24px}
  .box h1{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:16px;margin:0 0 10px;color:#3fd6c8}
  .box label{display:block;font-size:12px;color:#7d8a9c;margin:12px 0 5px}
  .box input[type=text],.box input[type=password]{width:100%;box-sizing:border-box;padding:10px;
    border-radius:8px;border:1px solid #2a3441;background:#0e1116;color:#d6dee8;
    font-family:ui-monospace,monospace;font-size:14px}
  .box input:focus{outline:none;border-color:#3fd6c8}
  .seg{display:flex;gap:8px;margin-top:4px}
  .seg button{flex:1;padding:8px;border-radius:8px;border:1px solid #2a3441;background:#1c232d;
    color:#d6dee8;cursor:pointer;font-size:13px}
  .seg button.on{background:#3fd6c8;color:#06231f;border-color:#3fd6c8;font-weight:600}
  .save{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#7d8a9c}
  .connect{width:100%;margin-top:18px;padding:11px;border-radius:8px;border:none;
    background:#3fd6c8;color:#06231f;font-weight:600;cursor:pointer;font-size:14px}
  .connect:disabled{opacity:.5;cursor:default}
  .msg{color:#e05a5a;font-size:13px;min-height:18px;margin-top:10px}
</style></head>
<body>
<div id="term"></div>
<div class="overlay" id="ov"><div class="box">
  <h1>SSH 连接</h1>
  <label>用户名</label>
  <input type="text" id="user" value="root" autocomplete="off" spellcheck="false">
  <label>认证方式</label>
  <div class="seg"><button id="m-pw" class="on">密码</button><button id="m-key">私钥(主机本地)</button></div>
  <div id="pwwrap">
    <label>密码 <span style="color:#5b6675">(已保存可留空)</span></label>
    <input type="password" id="pw" autocomplete="off">
    <div class="save"><input type="checkbox" id="save"><label for="save" style="margin:0">保存密码,下次免输入</label></div>
  </div>
  <button class="connect" id="go">连接</button>
  <div class="msg" id="msg"></div>
</div></div>
<script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
<script>
"use strict";
var ticket = decodeURIComponent((location.hash||"").slice(1));
var authType = "password";
var term, fit, ws, connected=false;

document.getElementById("m-pw").onclick=function(){ authType="password";
  this.classList.add("on"); document.getElementById("m-key").classList.remove("on");
  document.getElementById("pwwrap").style.display="block"; };
document.getElementById("m-key").onclick=function(){ authType="key";
  this.classList.add("on"); document.getElementById("m-pw").classList.remove("on");
  document.getElementById("pwwrap").style.display="none"; };

function setMsg(t){ document.getElementById("msg").textContent=t||""; }
function btn(){ return document.getElementById("go"); }

function initTerm(){
  term = new Terminal({ cursorBlink:true, fontSize:13,
    fontFamily:"ui-monospace,Menlo,Consolas,monospace",
    theme:{ background:"#0e1116", foreground:"#d6dee8", cursor:"#3fd6c8" } });
  fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(document.getElementById("term"));
  try{ fit.fit(); }catch(e){}
  term.onData(function(d){ if(connected && ws && ws.readyState===1) ws.send(new TextEncoder().encode(d)); });
  window.addEventListener("resize", doFit);
}
function doFit(){ if(!fit) return; try{ fit.fit(); }catch(e){}
  if(connected && ws && ws.readyState===1)
    ws.send(JSON.stringify({type:"resize", cols:term.cols, rows:term.rows})); }

function connect(){
  setMsg("");
  if(!ticket){ setMsg("票据缺失,请从面板重新打开"); return; }
  if(!term) initTerm();
  var proto = location.protocol==="https:"?"wss:":"ws:";
  ws = new WebSocket(proto+"//"+location.host+"/ws/ssh?ticket="+encodeURIComponent(ticket));
  ws.binaryType="arraybuffer";
  btn().disabled=true;
  ws.onopen=function(){
    ws.send(JSON.stringify({ type:"auth",
      username: document.getElementById("user").value || "root",
      authType: authType,
      password: document.getElementById("pw").value,
      save: document.getElementById("save").checked,
      cols: term.cols, rows: term.rows }));
  };
  ws.onmessage=function(ev){
    if(typeof ev.data==="string"){
      var m; try{ m=JSON.parse(ev.data); }catch(e){ return; }
      if(m.type==="ssh_opened"){ connected=true;
        document.getElementById("ov").style.display="none"; term.focus(); doFit(); }
      else if(m.type==="ssh_error"){ btn().disabled=false; setMsg(m.msg||"连接失败"); }
      else if(m.type==="ssh_close"){ if(connected) term.write("\\r\\n\\x1b[33m[会话已结束]\\x1b[0m\\r\\n"); connected=false; }
    } else {
      term.write(new Uint8Array(ev.data));
    }
  };
  ws.onclose=function(){ if(connected) term.write("\\r\\n\\x1b[31m[连接已断开]\\x1b[0m\\r\\n");
    connected=false; btn().disabled=false; };
  ws.onerror=function(){ setMsg("连接错误"); btn().disabled=false; };
}
btn().onclick=connect;
document.getElementById("pw").onkeydown=function(e){ if(e.key==="Enter") connect(); };
document.getElementById("user").onkeydown=function(e){ if(e.key==="Enter") connect(); };
</script>
</body></html>`;