// Pure state logic for TextLock. No DOM access — everything here runs in the
// browser and under `node --test`.

export const STORAGE_KEY = 'textlock/v1';
export const MIN_HOURS = 0.25;
export const MAX_HOURS = 72;
export const HOUR_MS = 3_600_000;
export const BREAK_PHRASE = 'let me out early';
export const HOLD_TO_BREAK_MS = 5_000;
export const COOL_DOWN_MS = 60_000;

export function initialState() {
  return {
    version: 1,
    lock: null,
    history: [],
    vault: [],
    settings: { notify: false },
  };
}

// Merge a parsed storage payload into a known-good shape so a corrupt or
// older payload can never take the UI down.
export function reviveState(raw) {
  const state = initialState();
  if (!raw || typeof raw !== 'object') return state;
  if (raw.lock && typeof raw.lock === 'object'
    && Number.isFinite(raw.lock.startedAt) && Number.isFinite(raw.lock.endsAt)) {
    state.lock = {
      startedAt: raw.lock.startedAt,
      endsAt: raw.lock.endsAt,
      hours: Number.isFinite(raw.lock.hours) ? raw.lock.hours : (raw.lock.endsAt - raw.lock.startedAt) / HOUR_MS,
      reason: typeof raw.lock.reason === 'string' ? raw.lock.reason : '',
    };
  }
  if (Array.isArray(raw.history)) {
    state.history = raw.history.filter((entry) => entry && typeof entry === 'object'
      && Number.isFinite(entry.startedAt) && Number.isFinite(entry.endedAt)
      && OUTCOMES.includes(entry.outcome));
  }
  if (Array.isArray(raw.vault)) {
    state.vault = raw.vault.filter((item) => item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.text === 'string'
      && Number.isFinite(item.createdAt));
  }
  if (raw.settings && typeof raw.settings === 'object') {
    state.settings.notify = raw.settings.notify === true;
  }
  return state;
}

export function clampHours(value) {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return null;
  const hours = Number(value);
  if (!Number.isFinite(hours)) return null;
  return Math.min(MAX_HOURS, Math.max(MIN_HOURS, hours));
}

export function startLock(state, { hours, reason = '' }, now) {
  if (state.lock) throw new Error('A lock is already running.');
  const clamped = clampHours(hours);
  if (clamped === null) throw new RangeError('Hours must be a number.');
  return {
    ...state,
    lock: {
      startedAt: now,
      endsAt: now + Math.round(clamped * HOUR_MS),
      hours: clamped,
      reason: reason.trim().slice(0, 280),
    },
  };
}

export function addHour(state, now) {
  if (!isActive(state.lock, now)) throw new Error('No active lock to extend.');
  const endsAt = state.lock.endsAt + HOUR_MS;
  if (endsAt - now > MAX_HOURS * HOUR_MS) throw new RangeError('Lock cannot extend past the maximum.');
  return { ...state, lock: { ...state.lock, endsAt, hours: state.lock.hours + 1 } };
}

export const OUTCOMES = ['completed', 'broken', 'emergency'];

// Ends the current lock — the timer ran out ('completed'), the break-glass
// flow finished ('broken'), or the emergency entrance was used ('emergency').
// Held messages are released in every case.
export function finishLock(state, now, outcome) {
  if (!state.lock) throw new Error('No lock to finish.');
  if (!OUTCOMES.includes(outcome)) throw new RangeError('Unknown outcome.');
  const endedAt = outcome === 'completed' ? Math.min(now, state.lock.endsAt) : now;
  return {
    ...state,
    lock: null,
    history: [
      ...state.history,
      {
        startedAt: state.lock.startedAt,
        endsAt: state.lock.endsAt,
        endedAt,
        hours: state.lock.hours,
        reason: state.lock.reason,
        outcome,
      },
    ],
    vault: state.vault.map((item) => (item.releasedAt ? item : { ...item, releasedAt: now })),
  };
}

export function holdMessage(state, text, now, id = newId()) {
  const trimmed = text.trim();
  if (!trimmed) throw new RangeError('Message is empty.');
  return {
    ...state,
    vault: [...state.vault, { id, text: trimmed.slice(0, 2000), createdAt: now, releasedAt: null }],
  };
}

export function dismissMessage(state, id) {
  return { ...state, vault: state.vault.filter((item) => item.id !== id) };
}

export function heldMessages(state) {
  return state.vault.filter((item) => !item.releasedAt);
}

export function releasedMessages(state) {
  return state.vault.filter((item) => item.releasedAt);
}

export function isActive(lock, now) {
  return Boolean(lock) && remainingMs(lock, now) > 0;
}

export function remainingMs(lock, now) {
  if (!lock) return 0;
  return Math.max(0, lock.endsAt - now);
}

export function progress(lock, now) {
  if (!lock) return 0;
  const total = lock.endsAt - lock.startedAt;
  if (total <= 0) return 1;
  return Math.min(1, Math.max(0, (now - lock.startedAt) / total));
}

// "1:04:09" with hours, "12:03" under an hour. Ceils to the next whole second
// so a fresh 2-hour lock reads 2:00:00, not 1:59:59.
export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

export function formatHours(hours) {
  const rounded = Math.round(hours * 100) / 100;
  return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
}

// Consecutive completed locks, counting back from the most recent entry.
// Emergency exits are skipped — a real emergency shouldn't cost the streak;
// only a deliberate break resets it.
export function currentStreak(history) {
  let streak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const { outcome } = history[i];
    if (outcome === 'emergency') continue;
    if (outcome !== 'completed') break;
    streak += 1;
  }
  return streak;
}

function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}
