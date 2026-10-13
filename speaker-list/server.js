'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '2468';

const SPEAK_BUDGET_MS = 60 * 1000;
const REBUTTAL_BUDGET_MS = 60 * 1000;
const CYCLES = 2;

// Where the live meeting is checkpointed, so a crash or restart doesn't lose it.
const STATE_FILE = process.env.STATE_FILE || path.join(__dirname, 'meeting-state.json');

// ---------------------------------------------------------------- state

function freshState() {
  return {
    phase: 'signup', // signup | running | ended
    members: [], // {id, token, name, speakMs, rebuttalMs, intent, served:[]}
    order: [], // member ids, shuffled at start
    cycle: 1,
    cursor: 0, // index into order of the next main-list speaker to consider
    mainListComplete: false,
    rebuttalQueue: [], // member ids, FIFO
    active: null, // {id, kind, remainingMs, runningSince}
    version: 0,
  };
}

let S = freshState();

// ---------------------------------------------------------------- persistence

// Write the whole meeting to disk after every change. Atomic (temp + rename)
// so a crash mid-write can never leave a half-written file. savedAt lets a
// reload tell how long ago this snapshot was taken.
let saveTimer = null;
function saveState() {
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ savedAt: Date.now(), state: S }));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('  (could not save meeting state:', e.message + ')');
  }
}

function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch {
    return false; // no file yet — first run
  }
  try {
    const { savedAt, state } = JSON.parse(raw);
    if (!state || !Array.isArray(state.members)) return false;
    S = state;

    // The clock was frozen in reality while the server was down — nobody spoke
    // during the outage. Freeze whoever had the floor at the moment of the last
    // save and leave them paused, so the chair resumes when actually ready.
    if (S.active && S.active.runningSince !== null) {
      const elapsed = Math.max(0, (savedAt || Date.now()) - S.active.runningSince);
      S.active.remainingMs = S.active.remainingMs - elapsed;
      S.active.runningSince = null; // paused
    }
    return true;
  } catch (e) {
    // A corrupt file should never stop the meeting from starting.
    console.error('  (saved state was unreadable, starting fresh:', e.message + ')');
    return false;
  }
}

const byId = (id) => S.members.find((m) => m.id === id) || null;

function liveRemaining(now) {
  if (!S.active) return 0;
  const { remainingMs, runningSince } = S.active;
  return runningSince === null ? remainingMs : remainingMs - (now - runningSince);
}

function bankActive(now) {
  if (!S.active) return;
  const m = byId(S.active.id);
  const left = Math.max(0, liveRemaining(now));
  if (m) {
    if (S.active.kind === 'speak') m.speakMs = left;
    else m.rebuttalMs = left;
  }
  S.active = null;
}

function startTurn(id, kind, now) {
  const m = byId(id);
  if (!m) return;
  S.active = {
    id,
    kind,
    remainingMs: kind === 'speak' ? m.speakMs : m.rebuttalMs,
    runningSince: now,
  };
}

// Advance to whatever should happen next. Rebuttals always win.
function advance(now) {
  bankActive(now);

  if (S.rebuttalQueue.length > 0) {
    const id = S.rebuttalQueue.shift();
    const m = byId(id);
    if (m && m.rebuttalMs > 0) {
      startTurn(id, 'rebuttal', now);
      return;
    }
    return advance(now); // stale entry, skip it
  }

  if (S.mainListComplete) return; // floor is quiet; rebuttals stay open

  let guard = 0;
  while (guard++ < 1000) {
    if (S.cursor >= S.order.length) {
      if (S.cycle < CYCLES) {
        S.cycle += 1;
        S.cursor = 0;
        // A new pass means a fresh pass/speak decision for everyone.
        S.members.forEach((m) => {
          m.intent = 'undecided';
        });
        continue;
      }
      // Second pass is over: unused speaking time is gone.
      S.mainListComplete = true;
      S.members.forEach((m) => {
        m.speakMs = 0;
      });
      return;
    }

    const id = S.order[S.cursor];
    S.cursor += 1;
    const m = byId(id);
    if (!m) continue;
    if (m.intent === 'pass') continue; // deferred, not forfeited
    if (m.speakMs <= 0) continue;

    m.served.push(S.cycle);
    startTurn(id, 'speak', now);
    return;
  }
}

// ---------------------------------------------------------------- actions

const actions = {
  join(payload) {
    if (S.phase === 'ended') throw new Error('This meeting has ended.');
    const name = String(payload.name || '').trim().slice(0, 40);
    if (!name) throw new Error('Enter a name first.');
    const clash = S.members.some(
      (m) => m.name.toLowerCase() === name.toLowerCase()
    );
    if (clash) throw new Error('Someone already signed up with that name.');

    const member = {
      id: crypto.randomBytes(6).toString('hex'),
      token: crypto.randomBytes(16).toString('hex'),
      name,
      speakMs: SPEAK_BUDGET_MS,
      rebuttalMs: REBUTTAL_BUDGET_MS,
      intent: 'undecided',
      served: [],
    };
    S.members.push(member);
    // Anyone joining after the shuffle goes to the back of the current pass.
    if (S.phase === 'running') S.order.push(member.id);
    return { id: member.id, token: member.token };
  },

  setIntent(payload, member) {
    if (!member) throw new Error('Rejoin to do that.');
    const v = payload.intent;
    if (v !== 'speak' && v !== 'pass') throw new Error('Unknown choice.');
    member.intent = v;
  },

  requestRebuttal(payload, member) {
    if (!member) throw new Error('Rejoin to do that.');
    if (member.rebuttalMs <= 0) throw new Error('Your rebuttal time is used up.');
    if (S.rebuttalQueue.includes(member.id)) return;
    if (S.active && S.active.id === member.id && S.active.kind === 'rebuttal') return;
    S.rebuttalQueue.push(member.id);
  },

  withdrawRebuttal(payload, member) {
    if (!member) throw new Error('Rejoin to do that.');
    S.rebuttalQueue = S.rebuttalQueue.filter((x) => x !== member.id);
  },

  stop(payload, member, now) {
    if (!member) throw new Error('Rejoin to do that.');
    if (!S.active || S.active.id !== member.id) throw new Error('You do not have the floor.');
    advance(now);
  },

  // ---- admin ----
  start(payload, member, now) {
    requireAdmin(payload);
    if (S.members.length === 0) throw new Error('Nobody has signed up yet.');
    S.order = shuffle(S.members.map((m) => m.id));
    S.phase = 'running';
    S.cycle = 1;
    S.cursor = 0;
    S.mainListComplete = false;
    advance(now);
  },

  pause(payload, member, now) {
    requireAdmin(payload);
    if (!S.active || S.active.runningSince === null) return;
    S.active.remainingMs = liveRemaining(now);
    S.active.runningSince = null;
  },

  resume(payload, member, now) {
    requireAdmin(payload);
    if (!S.active || S.active.runningSince !== null) return;
    S.active.runningSince = now;
  },

  next(payload, member, now) {
    requireAdmin(payload);
    if (S.phase !== 'running') throw new Error('The meeting is not running.');
    advance(now);
  },

  setTime(payload, member, now) {
    requireAdmin(payload);
    const m = byId(payload.id);
    if (!m) throw new Error('No such member.');
    const clamp = (v) => Math.max(0, Math.min(99 * 60000, Math.round(v)));

    const touchedSpeak = payload.speakMs !== undefined;
    const touchedReb = payload.rebuttalMs !== undefined;
    if (touchedSpeak) m.speakMs = clamp(payload.speakMs);
    if (touchedReb) m.rebuttalMs = clamp(payload.rebuttalMs);

    // If they are on the floor right now, retarget the live clock too.
    if (S.active && S.active.id === m.id) {
      const isSpeak = S.active.kind === 'speak';
      if ((isSpeak && touchedSpeak) || (!isSpeak && touchedReb)) {
        S.active.remainingMs = isSpeak ? m.speakMs : m.rebuttalMs;
        if (S.active.runningSince !== null) S.active.runningSince = now;
      }
    }
  },

  drop(payload, member, now) {
    requireAdmin(payload);
    const id = payload.id;
    if (S.active && S.active.id === id) advance(now);
    S.members = S.members.filter((m) => m.id !== id);
    S.order = S.order.filter((x) => x !== id);
    S.rebuttalQueue = S.rebuttalQueue.filter((x) => x !== id);
  },

  endMeeting(payload, member, now) {
    requireAdmin(payload);
    bankActive(now);
    S.phase = 'ended';
  },

  reset(payload) {
    requireAdmin(payload);
    S = freshState();
  },
};

function requireAdmin(payload) {
  if (String(payload.pin || '') !== ADMIN_PIN) throw new Error('Wrong PIN.');
}

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------------------------------------------------------------- views

function publicState(now) {
  const rebuttalSet = new Set(S.rebuttalQueue);
  return {
    phase: S.phase,
    cycle: S.cycle,
    cycles: CYCLES,
    mainListComplete: S.mainListComplete,
    serverNow: now,
    active: S.active
      ? {
          id: S.active.id,
          name: (byId(S.active.id) || {}).name || '—',
          kind: S.active.kind,
          remainingMs: S.active.remainingMs,
          runningSince: S.active.runningSince,
          paused: S.active.runningSince === null,
        }
      : null,
    upcoming: S.order
      .slice(S.cursor)
      .map((id) => byId(id))
      .filter((m) => m && m.intent !== 'pass' && m.speakMs > 0)
      .map((m) => ({ id: m.id, name: m.name, speakMs: m.speakMs })),
    deferred: S.order
      .slice(S.cursor)
      .map((id) => byId(id))
      .filter((m) => m && m.intent === 'pass')
      .map((m) => ({ id: m.id, name: m.name })),
    rebuttals: S.rebuttalQueue
      .map((id) => byId(id))
      .filter(Boolean)
      .map((m) => ({ id: m.id, name: m.name, rebuttalMs: m.rebuttalMs })),
    roster: S.members.map((m) => {
      let speakMs = m.speakMs;
      let rebuttalMs = m.rebuttalMs;
      if (S.active && S.active.id === m.id) {
        const live = Math.max(0, liveRemaining(now));
        if (S.active.kind === 'speak') speakMs = live;
        else rebuttalMs = live;
      }
      return {
        id: m.id,
        name: m.name,
        speakMs,
        rebuttalMs,
        intent: m.intent,
        queued: rebuttalSet.has(m.id),
        onFloor: !!(S.active && S.active.id === m.id),
        served: m.served.length,
      };
    }),
  };
}

// ---------------------------------------------------------------- transport

const clients = new Set();

function broadcast() {
  S.version += 1;
  saveState(); // checkpoint on every change
  const frame = `data: ${JSON.stringify(publicState(Date.now()))}\n\n`;
  for (const res of clients) {
    try {
      res.write(frame);
    } catch {
      clients.delete(res);
    }
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(`data: ${JSON.stringify(publicState(Date.now()))}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (url.pathname === '/action' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e5) req.destroy();
    });
    req.on('end', () => {
      let out;
      try {
        const payload = JSON.parse(body || '{}');
        const fn = actions[payload.action];
        if (!fn) throw new Error('Unknown action.');
        const member = payload.token
          ? S.members.find((m) => m.token === payload.token) || null
          : null;
        out = fn(payload, member, Date.now()) || {};
        broadcast();
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: e.message }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...out }));
    });
    return;
  }

  if (url.pathname === '/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(publicState(Date.now())));
  }

  if (url.pathname === '/whoami' && req.method === 'GET') {
    const token = url.searchParams.get('token');
    const m = S.members.find((x) => x.token === token);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(m ? { id: m.id, name: m.name } : { id: null }));
  }

  serveStatic(req, res, url.pathname);
});

// Keep proxies and phone radios from dropping the stream.
setInterval(() => {
  for (const res of clients) {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clients.delete(res);
    }
  }
}, 20000);

// While a clock is running, re-checkpoint every few seconds. Actions already
// save, but a turn can run a while with no action; this keeps the saved
// snapshot (and so the reload freeze-point) within ~5s of real time.
setInterval(() => {
  if (S.active && S.active.runningSince !== null) saveState();
}, 5000);

const restored = loadState();

server.listen(PORT, () => {
  const nets = os.networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal) lan.push(n.address);
    }
  }
  console.log('\n  Speaker list is up.\n');
  if (restored) {
    const n = S.members.length;
    let where = 'sign-ups still open';
    if (S.phase === 'ended') where = 'last meeting had ended — press Reset for a new one';
    else if (S.active) where = `${(byId(S.active.id) || {}).name || 'someone'} had the floor (clock paused — press Resume)`;
    else if (S.phase === 'running') where = 'meeting in progress';
    console.log(`  Picked up the saved meeting: ${n} member${n === 1 ? '' : 's'}, ${where}.`);
    console.log('');
  }
  console.log(`  Projector / admin   http://localhost:${PORT}/admin.html`);
  console.log(`  Admin PIN           ${ADMIN_PIN}`);
  console.log('');
  if (lan.length) {
    console.log('  Phones on the same wifi open:');
    lan.forEach((ip) => console.log(`      http://${ip}:${PORT}`));
  } else {
    console.log(`  Phones open:        http://localhost:${PORT}`);
  }
  console.log('');
});
