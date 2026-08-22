import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIN_HOURS, MAX_HOURS, HOUR_MS,
  initialState, reviveState, clampHours, startLock, addHour, finishLock,
  holdMessage, dismissMessage, heldMessages, releasedMessages,
  isActive, remainingMs, progress, formatDuration, formatHours, currentStreak,
  telHref,
} from '../lib/lock.js';

const T0 = 1_700_000_000_000;

test('clampHours clamps into range and rejects non-numbers', () => {
  assert.equal(clampHours('4'), 4);
  assert.equal(clampHours(0), MIN_HOURS);
  assert.equal(clampHours(-3), MIN_HOURS);
  assert.equal(clampHours(1000), MAX_HOURS);
  assert.equal(clampHours('nope'), null);
  assert.equal(clampHours(''), null);
  assert.equal(clampHours(Infinity), null);
  assert.equal(clampHours(NaN), null);
  assert.equal(clampHours(null), null);
  assert.equal(clampHours(undefined), null);
});

test('startLock creates an active lock ending hours later', () => {
  const state = startLock(initialState(), { hours: 4, reason: '  night off  ' }, T0);
  assert.equal(state.lock.startedAt, T0);
  assert.equal(state.lock.endsAt, T0 + 4 * HOUR_MS);
  assert.equal(state.lock.reason, 'night off');
  assert.ok(isActive(state.lock, T0));
  assert.ok(isActive(state.lock, T0 + 4 * HOUR_MS - 1));
  assert.ok(!isActive(state.lock, T0 + 4 * HOUR_MS));
});

test('startLock refuses to stack locks and clamps hours', () => {
  const state = startLock(initialState(), { hours: 4 }, T0);
  assert.throws(() => startLock(state, { hours: 2 }, T0), /already running/);
  const clamped = startLock(initialState(), { hours: 500 }, T0);
  assert.equal(clamped.lock.endsAt, T0 + MAX_HOURS * HOUR_MS);
});

test('addHour extends by one hour and respects the ceiling', () => {
  let state = startLock(initialState(), { hours: 2 }, T0);
  state = addHour(state, T0 + 1000);
  assert.equal(state.lock.endsAt, T0 + 3 * HOUR_MS);
  assert.equal(state.lock.hours, 3);

  let big = startLock(initialState(), { hours: MAX_HOURS }, T0);
  assert.throws(() => addHour(big, T0 + 1000), RangeError);
  // After enough time has passed, extending fits under the ceiling again.
  big = addHour(big, T0 + 2 * HOUR_MS);
  assert.equal(big.lock.endsAt, T0 + (MAX_HOURS + 1) * HOUR_MS);

  const expired = startLock(initialState(), { hours: 1 }, T0);
  assert.throws(() => addHour(expired, T0 + 2 * HOUR_MS), /No active lock/);
});

test('finishLock records history and clears the lock', () => {
  const state = startLock(initialState(), { hours: 1, reason: 'sleep' }, T0);
  const done = finishLock(state, T0 + 2 * HOUR_MS, 'completed');
  assert.equal(done.lock, null);
  assert.equal(done.history.length, 1);
  assert.equal(done.history[0].outcome, 'completed');
  // Completed locks end at the scheduled time even if noticed later.
  assert.equal(done.history[0].endedAt, T0 + HOUR_MS);
  assert.equal(done.history[0].reason, 'sleep');

  const broken = finishLock(state, T0 + 600_000, 'broken');
  assert.equal(broken.history[0].outcome, 'broken');
  assert.equal(broken.history[0].endedAt, T0 + 600_000);

  const emergency = finishLock(state, T0 + 60_000, 'emergency');
  assert.equal(emergency.lock, null);
  assert.equal(emergency.history[0].outcome, 'emergency');
  assert.equal(emergency.history[0].endedAt, T0 + 60_000);

  assert.throws(() => finishLock(initialState(), T0, 'completed'), /No lock/);
  assert.throws(() => finishLock(state, T0, 'gave-up'), RangeError);
});

test('emergency exit releases held messages immediately', () => {
  let state = startLock(initialState(), { hours: 4 }, T0);
  state = holdMessage(state, 'need to reach mom', T0 + 1000, 'm1');
  state = finishLock(state, T0 + 2000, 'emergency');
  assert.equal(heldMessages(state).length, 0);
  assert.equal(releasedMessages(state).length, 1);
});

test('vault: hold during lock, release on finish, dismiss after', () => {
  let state = startLock(initialState(), { hours: 1 }, T0);
  state = holdMessage(state, '  hey u up  ', T0 + 1000, 'a');
  state = holdMessage(state, 'second thoughts', T0 + 2000, 'b');
  assert.equal(heldMessages(state).length, 2);
  assert.equal(releasedMessages(state).length, 0);
  assert.equal(state.vault[0].text, 'hey u up');

  assert.throws(() => holdMessage(state, '   ', T0), RangeError);

  state = finishLock(state, T0 + HOUR_MS, 'completed');
  assert.equal(heldMessages(state).length, 0);
  assert.equal(releasedMessages(state).length, 2);

  state = dismissMessage(state, 'a');
  assert.equal(releasedMessages(state).length, 1);
  assert.equal(state.vault[0].id, 'b');
});

test('remainingMs and progress clamp at the edges', () => {
  const { lock } = startLock(initialState(), { hours: 2 }, T0);
  assert.equal(remainingMs(lock, T0), 2 * HOUR_MS);
  assert.equal(remainingMs(lock, T0 + 3 * HOUR_MS), 0);
  assert.equal(remainingMs(null, T0), 0);
  assert.equal(progress(lock, T0 - 5000), 0);
  assert.equal(progress(lock, T0 + HOUR_MS), 0.5);
  assert.equal(progress(lock, T0 + 9 * HOUR_MS), 1);
  assert.equal(progress(null, T0), 0);
});

test('formatDuration ceils to whole seconds', () => {
  assert.equal(formatDuration(2 * HOUR_MS), '2:00:00');
  assert.equal(formatDuration(2 * HOUR_MS - 500), '2:00:00');
  assert.equal(formatDuration(HOUR_MS - 1), '1:00:00');
  assert.equal(formatDuration(59_000), '0:59');
  assert.equal(formatDuration(61_000), '1:01');
  assert.equal(formatDuration(999), '0:01');
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(-5000), '0:00');
  assert.equal(formatDuration(25 * HOUR_MS), '25:00:00');
});

test('formatHours pluralizes and trims', () => {
  assert.equal(formatHours(1), '1 hour');
  assert.equal(formatHours(1.5), '1.5 hours');
  assert.equal(formatHours(12), '12 hours');
});

test('currentStreak counts consecutive completed from the end', () => {
  const done = { outcome: 'completed' };
  const broke = { outcome: 'broken' };
  const er = { outcome: 'emergency' };
  assert.equal(currentStreak([]), 0);
  assert.equal(currentStreak([done, done, done]), 3);
  assert.equal(currentStreak([done, broke]), 0);
  assert.equal(currentStreak([broke, done, done]), 2);
  // Emergencies are skipped: they neither break nor extend the streak.
  assert.equal(currentStreak([done, er, done]), 2);
  assert.equal(currentStreak([done, er]), 1);
  assert.equal(currentStreak([broke, er]), 0);
  assert.equal(currentStreak([er]), 0);
});

test('reviveState survives garbage and keeps good data', () => {
  assert.deepEqual(reviveState(null), initialState());
  assert.deepEqual(reviveState('junk'), initialState());
  assert.deepEqual(reviveState({ lock: { startedAt: 'x' } }).lock, null);
  assert.deepEqual(reviveState({ history: 'no', vault: 5, settings: 2 }), initialState());

  const good = finishLock(
    holdMessage(startLock(initialState(), { hours: 1, reason: 'r' }, T0), 'msg', T0, 'id1'),
    T0 + HOUR_MS,
    'completed',
  );
  const revived = reviveState(JSON.parse(JSON.stringify(good)));
  assert.equal(revived.history.length, 1);
  assert.equal(revived.vault.length, 1);
  assert.equal(revived.lock, null);

  // Emergency outcomes survive revival; unknown outcomes are dropped.
  const withEmergency = finishLock(startLock(initialState(), { hours: 1 }, T0), T0 + 1, 'emergency');
  assert.equal(reviveState(JSON.parse(JSON.stringify(withEmergency))).history.length, 1);
  assert.equal(reviveState({ history: [{ startedAt: T0, endedAt: T0, outcome: 'rage-quit' }] }).history.length, 0);

  const active = startLock(initialState(), { hours: 2 }, T0);
  const revivedActive = reviveState(JSON.parse(JSON.stringify(active)));
  assert.equal(revivedActive.lock.endsAt, T0 + 2 * HOUR_MS);

  // Settings only accept a real boolean true.
  assert.equal(reviveState({ settings: { notify: 'yes' } }).settings.notify, false);
  assert.equal(reviveState({ settings: { notify: true } }).settings.notify, true);

  // Trusted contact strings survive; non-strings are ignored; length is capped.
  const trusted = reviveState({ settings: { trustedName: 'Sam', trustedPhone: '+1 555 010 1234' } });
  assert.equal(trusted.settings.trustedName, 'Sam');
  assert.equal(trusted.settings.trustedPhone, '+1 555 010 1234');
  assert.equal(reviveState({ settings: { trustedName: 42 } }).settings.trustedName, '');
  assert.equal(reviveState({ settings: { trustedName: 'x'.repeat(200) } }).settings.trustedName.length, 60);
});

test('telHref keeps a leading plus and digits only', () => {
  assert.equal(telHref('+1 (555) 010-1234'), 'tel:+15550101234');
  assert.equal(telHref('555 010 1234'), 'tel:5550101234');
  assert.equal(telHref('  +44 20 7946 0958 '), 'tel:+442079460958');
  assert.equal(telHref('no digits here'), null);
  assert.equal(telHref(''), null);
  assert.equal(telHref(null), null);
  assert.equal(telHref(undefined), null);
});
