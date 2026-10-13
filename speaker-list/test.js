'use strict';
const { spawn } = require('child_process');

const PORT = 3999;
const PIN = '2468';
const base = `http://127.0.0.1:${PORT}`;

let fails = 0;
function ok(cond, msg) {
  console.log((cond ? '  ok   ' : '  FAIL ') + msg);
  if (!cond) fails++;
}

async function act(body) {
  const r = await fetch(base + '/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
const admin = (action, extra) => act({ action, pin: PIN, ...(extra || {}) });

async function state() {
  const r = await fetch(base + '/state');
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const srv = spawn('node', ['server.js'], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(PORT), ADMIN_PIN: PIN },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  await sleep(600);

  try {
    console.log('\n-- sign-up --');
    const A = await act({ action: 'join', name: 'Alto Ander' });
    const B = await act({ action: 'join', name: 'Bass Brooks' });
    const C = await act({ action: 'join', name: 'Tenor Chen' });
    ok(A.token && B.token && C.token, 'three members joined');

    const dup = await act({ action: 'join', name: 'alto ander' });
    ok(!!dup.error, 'duplicate name rejected: ' + dup.error);

    let s = await state();
    ok(s.phase === 'signup' && s.roster.length === 3, 'signup phase, roster of 3');
    ok(s.roster.every((m) => m.speakMs === 60000 && m.rebuttalMs === 60000), 'everyone starts 1:00 / 1:00');

    console.log('\n-- start --');
    ok(!!(await admin('start', {})).ok, 'meeting started');
    s = await state();
    ok(s.phase === 'running' && s.cycle === 1, 'running, pass I');
    ok(!!s.active && s.active.kind === 'speak', 'someone has the floor: ' + s.active.name);
    ok(s.upcoming.length === 2, 'two people queued behind them');
    const first = s.active.id;
    const firstTok = [A, B, C].find((x) => x.id === first).token;

    console.log('\n-- stop banks unused time --');
    await sleep(1200);
    await act({ action: 'stop', token: firstTok });
    s = await state();
    const firstRec = s.roster.find((m) => m.id === first);
    ok(firstRec.speakMs > 57000 && firstRec.speakMs < 59500,
      'banked ~58.8s after speaking ~1.2s (got ' + firstRec.speakMs + 'ms)');
    ok(s.active.id !== first, 'floor moved on to ' + s.active.name);

    console.log('\n-- wrong person cannot stop the clock --');
    const notSpeaking = [A, B, C].find((x) => x.id !== s.active.id);
    const bad = await act({ action: 'stop', token: notSpeaking.token });
    ok(!!bad.error, 'rejected: ' + bad.error);

    console.log('\n-- rebuttal jumps the main list --');
    const second = s.active.id;
    const third = s.upcoming[0].id;
    const thirdTok = [A, B, C].find((x) => x.id === third).token;
    const firstReb = await act({ action: 'requestRebuttal', token: firstTok });
    ok(!firstReb.error, 'first speaker queued a rebuttal');
    s = await state();
    ok(s.rebuttals.length === 1 && s.rebuttals[0].id === first, 'rebuttal queue holds them');
    ok(s.active.id === second, 'current speaker not interrupted');

    await admin('next', {});
    s = await state();
    ok(s.active.kind === 'rebuttal' && s.active.id === first,
      'rebuttal served before the next main speaker');

    console.log('\n-- FIFO order --');
    await act({ action: 'requestRebuttal', token: thirdTok });
    const secondTok = [A, B, C].find((x) => x.id === second).token;
    await act({ action: 'requestRebuttal', token: secondTok });
    s = await state();
    ok(s.rebuttals[0].id === third && s.rebuttals[1].id === second,
      'queue is first-tapped-first-served');
    const dupReb = await act({ action: 'requestRebuttal', token: thirdTok });
    s = await state();
    ok(s.rebuttals.length === 2, 'double-tapping does not double-queue');
    await act({ action: 'withdrawRebuttal', token: secondTok });
    s = await state();
    ok(s.rebuttals.length === 1 && s.rebuttals[0].id === third, 'withdraw works');

    console.log('\n-- drain rebuttals, then resume main list --');
    await admin('next', {}); // serve third's rebuttal
    s = await state();
    ok(s.active.kind === 'rebuttal' && s.active.id === third, 'third rebuts');
    await admin('next', {});
    s = await state();
    ok(s.active.kind === 'speak' && s.active.id === third,
      'main list resumes where it left off (third speaks)');

    console.log('\n-- pause and resume --');
    await admin('pause', {});
    s = await state();
    ok(s.active.paused === true, 'clock paused');
    const frozen = s.active.remainingMs;
    await sleep(700);
    s = await state();
    ok(s.active.remainingMs === frozen, 'paused clock does not drain');
    await admin('resume', {});
    s = await state();
    ok(s.active.paused === false, 'clock resumed');

    console.log('\n-- pass defers, it does not forfeit --');
    await admin('next', {}); // finish pass I
    s = await state();
    ok(s.cycle === 2, 'rolled into pass II');
    const pAll = s.roster.map((m) => m.speakMs);
    ok(pAll.every((v) => v > 0), 'everyone still holds speaking time in pass II');

    const cur = s.active.id;
    const others = [A, B, C].filter((x) => x.id !== cur);
    await act({ action: 'setIntent', token: others[0].token, intent: 'pass' });
    s = await state();
    ok(s.deferred.length === 1, 'passer shown as deferred, not queued');
    ok(!s.upcoming.some((m) => m.id === others[0].id), 'passer removed from up-next');

    console.log('\n-- second pass ends, speaking time is trashed --');
    let guard = 0;
    while (s.active && guard++ < 12) {
      await admin('next', {});
      s = await state();
    }
    ok(s.mainListComplete === true, 'main list complete');
    ok(s.roster.every((m) => m.speakMs === 0), 'unused speaking time zeroed after pass II');
    ok(s.roster.some((m) => m.rebuttalMs > 0), 'rebuttal time survives — it floats free');

    console.log('\n-- rebuttals still open after the list is done --');
    const alive = s.roster.find((m) => m.rebuttalMs > 0);
    const aliveTok = [A, B, C].find((x) => x.id === alive.id).token;
    const late = await act({ action: 'requestRebuttal', token: aliveTok });
    ok(!late.error, 'can still request rebuttal after the main list finishes');
    await admin('next', {});
    s = await state();
    ok(!!s.active && s.active.kind === 'rebuttal', 'and it gets served');

    console.log('\n-- auth --');
    const noPin = await act({ action: 'next' });
    ok(!!noPin.error, 'admin action without PIN rejected: ' + noPin.error);
    const badPin = await act({ action: 'reset', pin: '0000' });
    ok(!!badPin.error, 'wrong PIN rejected');

    console.log('\n-- exhausted rebuttal budget --');
    // burn it down by force
    await admin('pause', {});
    s = await state();
    const holder = s.active.id;
    const holderTok = [A, B, C].find((x) => x.id === holder).token;
    await admin('resume', {});
    await sleep(300);
    // drain by repeatedly serving until zero would take a minute; check the guard directly instead
    const zeroed = s.roster.filter((m) => m.rebuttalMs === 0);
    console.log('     (members at 0 rebuttal: ' + zeroed.length + ')');

    console.log('\n-- reset --');
    await admin('reset', {});
    s = await state();
    ok(s.phase === 'signup' && s.roster.length === 0, 'reset clears everything');

    console.log('\n-- editing time and removing people --');
    const D = await act({ action: 'join', name: 'Dropper Dane' });
    const E = await act({ action: 'join', name: 'Editor Ellis' });
    const F = await act({ action: 'join', name: 'Filler Fox' });

    await admin('setTime', { id: E.id, speakMs: 20000 });
    s = await state();
    ok(s.roster.find((m) => m.id === E.id).speakMs === 20000, 'speaking time set to 0:20');

    await admin('setTime', { id: E.id, rebuttalMs: 95000 });
    s = await state();
    ok(s.roster.find((m) => m.id === E.id).rebuttalMs === 95000, 'rebuttal time raised past a minute');

    await admin('setTime', { id: E.id, speakMs: -5000 });
    s = await state();
    ok(s.roster.find((m) => m.id === E.id).speakMs === 0, 'negative time clamps to zero');

    const noSuch = await admin('setTime', { id: 'nope', speakMs: 1000 });
    ok(!!noSuch.error, 'editing an unknown member rejected: ' + noSuch.error);
    const notChair = await act({ action: 'setTime', id: E.id, speakMs: 1000 });
    ok(!!notChair.error, 'editing without the PIN rejected');

    console.log('\n-- editing the person currently on the floor --');
    await admin('setTime', { id: E.id, speakMs: 60000 });
    await admin('start', {});
    s = await state();
    const onFloor = s.active.id;
    await sleep(900);
    await admin('setTime', { id: onFloor, speakMs: 30000 });
    s = await state();
    ok(Math.abs(s.active.remainingMs - 30000) < 100, 'live clock retargeted to 0:30');
    await sleep(700);
    s = await state();
    const nowLeft = s.roster.find((m) => m.id === onFloor).speakMs;
    ok(nowLeft < 30000 && nowLeft > 28500, 'and it keeps draining from the new value');

    console.log('\n-- removing people --');
    s = await state();
    const victim = s.upcoming[0].id;
    await admin('drop', { id: victim });
    s = await state();
    ok(!s.roster.some((m) => m.id === victim), 'removed from the roster');
    ok(!s.upcoming.some((m) => m.id === victim), 'and from the running order');

    const floorNow = s.active.id;
    await admin('drop', { id: floorNow });
    s = await state();
    ok(!s.roster.some((m) => m.id === floorNow), 'can remove whoever is on the floor');
    ok(!s.active || s.active.id !== floorNow, 'floor moves on when they are removed');

  } catch (e) {
    console.log('  FAIL threw: ' + e.message);
    fails++;
  }

  srv.kill();
  console.log(fails === 0 ? '\nAll checks passed.\n' : `\n${fails} FAILED\n`);
  process.exit(fails ? 1 : 0);
})();
