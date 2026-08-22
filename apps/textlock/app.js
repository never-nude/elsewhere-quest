import {
  STORAGE_KEY, MAX_HOURS, HOUR_MS, HOLD_TO_BREAK_MS, COOL_DOWN_MS,
  GATE_ROUNDS, makeSequence, checkRecall, closeGate, gateClosedRemaining,
  initialState, reviveState, clampHours, startLock, addHour, finishLock,
  holdMessage, dismissMessage, heldMessages, releasedMessages,
  isActive, remainingMs, progress, formatDuration, formatHours, currentStreak,
  telHref,
} from './lib/lock.js';

const $ = (id) => document.getElementById(id);

const els = {
  viewSetup: $('view-setup'),
  viewLocked: $('view-locked'),
  announcer: $('announcer'),
  finishedBanner: $('finished-banner'),
  finishedBannerTitle: $('finished-banner-title'),
  finishedBannerDetail: $('finished-banner-detail'),
  releasedCard: $('released-messages'),
  releasedList: $('released-list'),
  setupForm: $('setup-form'),
  presetRow: $('preset-row'),
  customHours: $('custom-hours'),
  endsPreview: $('ends-preview'),
  reason: $('reason'),
  notify: $('notify'),
  notifyNote: $('notify-note'),
  setupError: $('setup-error'),
  statsCard: $('stats-card'),
  statsLine: $('stats-line'),
  historyList: $('history-list'),
  lockReason: $('lock-reason'),
  countdown: $('countdown'),
  progressbar: $('progressbar'),
  progressFill: $('progress-fill'),
  endsAt: $('ends-at'),
  addHourBtn: $('add-hour'),
  vaultForm: $('vault-form'),
  vaultText: $('vault-text'),
  vaultCount: $('vault-count'),
  breakDetails: $('break-details'),
  stepHold: $('break-step-hold'),
  stepMemory: $('break-step-memory'),
  stepWait: $('break-step-wait'),
  holdButton: $('hold-button'),
  holdLabel: $('hold-label'),
  holdFill: $('hold-fill'),
  gateRoundLabel: $('gate-round-label'),
  gateInstruction: $('gate-instruction'),
  gateSequence: $('gate-sequence'),
  gateCountdown: $('gate-countdown'),
  gateStart: $('gate-start'),
  gateForm: $('gate-form'),
  gateAnswer: $('gate-answer'),
  gateFeedback: $('gate-feedback'),
  cooldownRemaining: $('cooldown-remaining'),
  breakNow: $('break-now'),
  breakCancel: $('break-cancel'),
  trustedName: $('trusted-name'),
  trustedPhone: $('trusted-phone'),
  emergencyCall: $('emergency-call'),
  emergencyOpen: $('emergency-open'),
  emergencyConfirm: $('emergency-confirm'),
  emergencyYes: $('emergency-yes'),
  emergencyCancel: $('emergency-cancel'),
};

// ---------------------------------------------------------------- storage

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return reviveState(raw ? JSON.parse(raw) : null);
  } catch {
    return initialState();
  }
}

// Tracks the exact payload this page last wrote (or saw), so a tab waking
// from the back/forward cache can tell whether another tab moved the state.
let lastSavedRaw = null;
try {
  lastSavedRaw = localStorage.getItem(STORAGE_KEY);
} catch {
  // Ignore; resync will simply re-render.
}

function saveState() {
  try {
    const raw = JSON.stringify(state);
    localStorage.setItem(STORAGE_KEY, raw);
    lastSavedRaw = raw;
  } catch {
    // Private mode or full quota: the app still works for this page load.
  }
}

let state = loadState();

// Banner about the most recent finish, kept only for this page session.
let finishedNotice = null;

// Break-glass flow lives in memory on purpose: reloading restarts the steps.
// (The gate-closed timestamp from a failed memory round persists in state.)
const breakFlow = {
  stage: 'idle', // idle → memory → wait
  holdStart: 0, holdTimer: 0,
  phase: 'idle', round: 0, sequence: '', phaseEndsAt: 0, gateTimer: 0,
  coolTimer: 0, coolEndsAt: 0,
};

// ---------------------------------------------------------------- helpers

function announce(text) {
  els.announcer.textContent = '';
  requestAnimationFrame(() => { els.announcer.textContent = text; });
}

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayTimeFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'short', hour: 'numeric', minute: '2-digit',
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function formatWhen(ts, now = Date.now()) {
  const target = new Date(ts);
  const today = new Date(now);
  const sameDay = target.toDateString() === today.toDateString();
  return sameDay ? timeFormat.format(target) : dayTimeFormat.format(target);
}

// Storage events never reach a page parked in the back/forward cache, so on
// wake-up compare payloads and adopt whatever another tab wrote in between —
// otherwise this tab's stale state could overwrite a newer lock or vault.
function resyncFromStorage() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    render();
    return;
  }
  if (raw !== lastSavedRaw) {
    lastSavedRaw = raw;
    state = loadState();
    resetBreakFlow();
    resetEmergency();
  }
  render();
}

async function maybeNotify(title, body) {
  if (!state.settings.notify) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const options = { body, icon: './icon-192.png' };
  // Android Chrome (and installed PWAs generally) only allow notifications
  // through the service worker registration; the constructor throws there.
  try {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration()
      : null;
    if (registration?.showNotification) {
      await registration.showNotification(title, options);
      return;
    }
  } catch {
    // Fall through to the constructor.
  }
  try {
    new Notification(title, options);
  } catch {
    // No notification path on this platform; the on-page banner still shows.
  }
}

// ---------------------------------------------------------------- rendering

let lastView = null;

function render() {
  const now = Date.now();

  // A lock that ran out (possibly while the page was closed) completes now.
  if (state.lock && !isActive(state.lock, now)) {
    completeLock();
    return;
  }

  const locked = Boolean(state.lock);
  els.viewSetup.hidden = locked;
  els.viewLocked.hidden = !locked;

  // On a real view swap, land keyboard focus on the new view so it isn't
  // silently dropped to <body>. Skipped on initial page load.
  const view = locked ? 'locked' : 'setup';
  if (lastView !== null && lastView !== view) {
    (locked ? els.viewLocked : els.viewSetup).focus();
  }
  lastView = view;

  if (locked) {
    els.lockReason.hidden = !state.lock.reason;
    els.lockReason.textContent = state.lock.reason ? `“${state.lock.reason}”` : '';
    renderTick(now);
    renderVaultCount();
    renderBreakFlow();
    renderEmergencyCall();
  } else {
    renderFinishedBanner();
    renderReleased();
    renderStats();
    renderEndsPreview();
    renderNotifyControl();
    els.trustedName.value = state.settings.trustedName;
    els.trustedPhone.value = state.settings.trustedPhone;
  }
}

function renderNotifyControl() {
  const supported = 'Notification' in window;
  const denied = supported && Notification.permission === 'denied';
  els.notify.disabled = !supported || denied;
  els.notify.checked = state.settings.notify && supported && Notification.permission === 'granted';
  els.notifyNote.textContent = !supported
    ? '(not supported in this browser)'
    : denied ? '(blocked in your browser settings)' : '';
}

function renderEmergencyCall() {
  const href = telHref(state.settings.trustedPhone);
  els.emergencyCall.hidden = !href;
  if (!href) return;
  els.emergencyCall.href = href;
  els.emergencyCall.textContent = state.settings.trustedName
    ? `Call ${state.settings.trustedName}`
    : 'Call your person';
}

function renderTick(now = Date.now()) {
  if (!state.lock) return;
  if (!isActive(state.lock, now)) {
    completeLock();
    return;
  }
  const remaining = remainingMs(state.lock, now);
  const text = formatDuration(remaining);
  if (els.countdown.textContent !== text) els.countdown.textContent = text;

  const pct = Math.round(progress(state.lock, now) * 100);
  els.progressFill.style.width = `${pct}%`;
  els.progressbar.setAttribute('aria-valuenow', String(pct));

  els.endsAt.textContent = `Opens at ${formatWhen(state.lock.endsAt, now)}`;
  els.addHourBtn.disabled = state.lock.endsAt + HOUR_MS - now > MAX_HOURS * HOUR_MS;
}

function renderEndsPreview() {
  const hours = clampHours(els.customHours.value);
  let text;
  if (hours === null || hours !== Number(els.customHours.value)) {
    // Matches the form's native validation instead of previewing a clamp
    // the submit button would reject.
    text = 'Locks run from 15 minutes (0.25) to 72 hours.';
  } else {
    text = `The lock would open at ${formatWhen(Date.now() + hours * HOUR_MS)}.`;
  }
  if (els.endsPreview.textContent !== text) els.endsPreview.textContent = text;
}

function renderFinishedBanner() {
  els.finishedBanner.hidden = !finishedNotice;
  if (!finishedNotice) return;
  if (finishedNotice.outcome === 'completed') {
    els.finishedBannerTitle.textContent = 'The line is open — you kept your lock.';
    els.finishedBannerDetail.textContent =
      `Your ${formatHours(finishedNotice.hours)} lock opened at ${dateFormat.format(new Date(finishedNotice.endedAt))}.`;
  } else if (finishedNotice.outcome === 'emergency') {
    els.finishedBannerTitle.textContent = 'The line is open — emergency entrance.';
    els.finishedBannerDetail.textContent =
      'Noted in your record, not held against you. Your streak stands. We hope everyone is okay.';
  } else {
    els.finishedBannerTitle.textContent = 'Lock broken — the line is open.';
    els.finishedBannerDetail.textContent =
      'You chose to open it early, slowly and on purpose. That counts for something. The next lock starts fresh.';
  }
}

function renderReleased() {
  const released = releasedMessages(state);
  els.releasedCard.hidden = released.length === 0;
  els.releasedList.textContent = '';
  for (const item of released) {
    const li = document.createElement('li');

    const quote = document.createElement('blockquote');
    quote.textContent = item.text;
    li.appendChild(quote);

    const meta = document.createElement('p');
    meta.className = 'muted';
    meta.textContent = `Written ${dateFormat.format(new Date(item.createdAt))}`;
    li.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'vault-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'button';
    copyBtn.textContent = 'Copy';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(item.text);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
      } catch {
        copyBtn.textContent = 'Select & copy manually';
      }
    });
    actions.appendChild(copyBtn);

    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'button button--ghost';
    dismissBtn.textContent = 'Let it go';
    dismissBtn.addEventListener('click', () => {
      state = dismissMessage(state, item.id);
      saveState();
      render();
      announce('Message let go.');
    });
    actions.appendChild(dismissBtn);

    li.appendChild(actions);
    els.releasedList.appendChild(li);
  }
}

function renderStats() {
  const { history } = state;
  els.statsCard.hidden = history.length === 0;
  if (history.length === 0) return;

  const completed = history.filter((h) => h.outcome === 'completed').length;
  const broken = history.filter((h) => h.outcome === 'broken').length;
  const emergencies = history.filter((h) => h.outcome === 'emergency').length;
  const streak = currentStreak(history);
  const parts = [`${completed} kept`, `${broken} broken`];
  if (emergencies > 0) parts.push(`${emergencies} ${emergencies === 1 ? 'emergency' : 'emergencies'}`);
  if (streak >= 2) parts.push(`current streak: ${streak}`);
  els.statsLine.textContent = parts.join(' · ');

  els.historyList.textContent = '';
  for (const entry of history.slice(-6).reverse()) {
    const li = document.createElement('li');
    const when = document.createElement('span');
    when.textContent = `${dateFormat.format(new Date(entry.startedAt))} · ${formatHours(entry.hours)}`;
    const outcome = document.createElement('span');
    outcome.className = `outcome--${entry.outcome}`;
    outcome.textContent = { completed: 'kept', broken: 'broken', emergency: 'emergency' }[entry.outcome];
    li.append(when, outcome);
    els.historyList.appendChild(li);
  }
}

function renderVaultCount() {
  const held = heldMessages(state).length;
  els.vaultCount.hidden = held === 0;
  els.vaultCount.textContent = held === 1
    ? '1 message sealed until the lock opens.'
    : `${held} messages sealed until the lock opens.`;
}

// ---------------------------------------------------------------- lock flow

// A vault draft typed but not yet sealed shouldn't vanish when the lock ends
// out from under it — seal it so it's released alongside the others.
function sealDraftIfAny() {
  const draft = els.vaultText.value.trim();
  if (!draft || !state.lock) return;
  state = holdMessage(state, draft, Date.now());
  els.vaultText.value = '';
}

function completeLock() {
  sealDraftIfAny();
  const endedAt = Math.min(Date.now(), state.lock.endsAt);
  const { hours } = state.lock;
  state = finishLock(state, Date.now(), 'completed');
  finishedNotice = { outcome: 'completed', hours, endedAt };
  resetBreakFlow();
  resetEmergency();
  saveState();
  render();
  announce('Your lock is complete. The line is open.');
  maybeNotify('TextLock — the line is open', `You kept your ${formatHours(hours)} lock.`);
}

function breakLock() {
  // The 250ms tick may not have noticed expiry yet: a lock that already ran
  // out was served in full and must never be recorded as broken.
  if (!isActive(state.lock, Date.now())) {
    completeLock();
    return;
  }
  sealDraftIfAny();
  state = finishLock(state, Date.now(), 'broken');
  finishedNotice = { outcome: 'broken' };
  resetBreakFlow();
  resetEmergency();
  saveState();
  render();
  announce('Lock broken. The line is open.');
}

function emergencyExit() {
  if (!isActive(state.lock, Date.now())) {
    completeLock();
    return;
  }
  sealDraftIfAny();
  state = finishLock(state, Date.now(), 'emergency');
  finishedNotice = { outcome: 'emergency' };
  resetBreakFlow();
  resetEmergency();
  saveState();
  render();
  announce('Emergency entrance used. The line is open.');
}

// ---------------------------------------------------------------- setup view

function selectedPreset() {
  return els.presetRow.querySelector('.preset.is-selected');
}

els.presetRow.addEventListener('click', (event) => {
  const button = event.target.closest('.preset');
  if (!button) return;
  for (const p of els.presetRow.querySelectorAll('.preset')) {
    p.classList.toggle('is-selected', p === button);
    p.setAttribute('aria-pressed', String(p === button));
  }
  els.customHours.value = button.dataset.hours;
  renderEndsPreview();
});

els.customHours.addEventListener('input', () => {
  const preset = selectedPreset();
  if (preset && preset.dataset.hours !== els.customHours.value) {
    preset.classList.remove('is-selected');
    preset.setAttribute('aria-pressed', 'false');
  }
  renderEndsPreview();
});

els.notify.addEventListener('change', async () => {
  state.settings.notify = els.notify.checked;
  if (els.notify.checked && 'Notification' in window && Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') state.settings.notify = false;
  }
  saveState();
  renderNotifyControl();
});

els.trustedName.addEventListener('input', () => {
  state.settings.trustedName = els.trustedName.value.trim().slice(0, 60);
  saveState();
});
els.trustedPhone.addEventListener('input', () => {
  state.settings.trustedPhone = els.trustedPhone.value.trim().slice(0, 30);
  saveState();
});

els.setupForm.addEventListener('submit', (event) => {
  event.preventDefault();
  els.setupError.hidden = true;
  const hours = clampHours(els.customHours.value);
  if (hours === null) {
    els.setupError.textContent = 'Enter how many hours to lock (0.25 to 72).';
    els.setupError.hidden = false;
    return;
  }
  try {
    state = startLock(state, { hours, reason: els.reason.value }, Date.now());
  } catch (error) {
    els.setupError.textContent = error.message;
    els.setupError.hidden = false;
    return;
  }
  finishedNotice = null;
  els.reason.value = '';
  saveState();
  render();
  announce(`Locked for ${formatHours(hours)}. Opens at ${formatWhen(state.lock.endsAt)}.`);
});

// ---------------------------------------------------------------- locked view

els.addHourBtn.addEventListener('click', () => {
  try {
    state = addHour(state, Date.now());
  } catch {
    return;
  }
  saveState();
  renderTick();
  announce(`One hour added. Opens at ${formatWhen(state.lock.endsAt)}.`);
});

els.vaultForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = els.vaultText.value;
  if (!text.trim()) return;
  state = holdMessage(state, text, Date.now());
  els.vaultText.value = '';
  saveState();
  renderVaultCount();
  announce('Message sealed until the lock opens.');
});

// ---- break-glass flow: hold 5 s → memory rounds → wait 60 s --------------

function resetBreakFlow() {
  breakFlow.stage = 'idle';
  breakFlow.phase = 'idle';
  breakFlow.round = 0;
  breakFlow.sequence = '';
  clearInterval(breakFlow.holdTimer);
  clearInterval(breakFlow.gateTimer);
  clearInterval(breakFlow.coolTimer);
  breakFlow.holdTimer = 0;
  breakFlow.gateTimer = 0;
  breakFlow.coolTimer = 0;
  els.holdFill.style.width = '0%';
  els.holdLabel.textContent = 'Press to begin';
  els.gateAnswer.value = '';
  els.gateFeedback.textContent = '';
  els.breakNow.disabled = true;
  if (els.breakDetails) els.breakDetails.open = false;
  renderBreakFlow();
}

function renderBreakFlow() {
  els.stepHold.hidden = false;
  els.stepMemory.hidden = breakFlow.stage !== 'memory';
  els.stepWait.hidden = breakFlow.stage !== 'wait';
}

// Press once to arm a five-second countdown; press again to stop it. A plain
// click (mouse, touch, keyboard, voice control, switch access) is the only
// gesture required, so every input method can operate it.
function beginHold() {
  if (breakFlow.stage !== 'idle' || breakFlow.holdTimer) return;
  breakFlow.holdStart = Date.now();
  breakFlow.holdTimer = setInterval(() => {
    const held = Date.now() - breakFlow.holdStart;
    const pct = Math.min(100, (held / HOLD_TO_BREAK_MS) * 100);
    els.holdFill.style.width = `${pct}%`;
    const secondsLeft = Math.ceil((HOLD_TO_BREAK_MS - held) / 1000);
    els.holdLabel.textContent = secondsLeft > 0 ? `Wait… ${secondsLeft} (press to stop)` : 'Done';
    if (held >= HOLD_TO_BREAK_MS) {
      clearInterval(breakFlow.holdTimer);
      breakFlow.holdTimer = 0;
      els.holdLabel.textContent = 'Step 1 done';
      enterGate();
      announce('Step one done. The memory check is next.');
    }
  }, 100);
}

function cancelHold() {
  if (!breakFlow.holdTimer) return;
  clearInterval(breakFlow.holdTimer);
  breakFlow.holdTimer = 0;
  els.holdFill.style.width = '0%';
  els.holdLabel.textContent = 'Press to begin';
}

els.holdButton.addEventListener('click', () => {
  if (breakFlow.holdTimer) cancelHold();
  else beginHold();
});

// ---- the memory gate ----

function enterGate() {
  breakFlow.stage = 'memory';
  breakFlow.round = 0;
  breakFlow.phase = gateClosedRemaining(state.lock, Date.now()) > 0 ? 'closed' : 'intro';
  renderBreakFlow();
  renderGate();
}

function renderGate() {
  const cfg = GATE_ROUNDS[Math.min(breakFlow.round, GATE_ROUNDS.length - 1)];
  els.gateRoundLabel.textContent =
    `Round ${Math.min(breakFlow.round + 1, GATE_ROUNDS.length)} of ${GATE_ROUNDS.length}.`;
  els.gateSequence.hidden = breakFlow.phase !== 'study';
  els.gateCountdown.hidden = breakFlow.phase !== 'study' && breakFlow.phase !== 'delay';
  els.gateStart.hidden = breakFlow.phase !== 'intro';
  els.gateForm.hidden = breakFlow.phase !== 'entry';

  if (breakFlow.phase === 'closed') {
    renderGateClosed();
  } else if (breakFlow.phase === 'intro') {
    const how = cfg.kind === 'reverse' ? 'type them back in reverse order — last digit first' : 'type them back';
    els.gateInstruction.textContent =
      `You'll see ${cfg.length} digits for ${cfg.studyMs / 1000} seconds, then a ${cfg.delayMs / 1000}-second quiet wait — then ${how}.`;
    els.gateStart.textContent = `Start round ${breakFlow.round + 1}`;
  } else if (breakFlow.phase === 'study') {
    els.gateInstruction.textContent = 'Hold these in mind.';
    els.gateSequence.textContent = [...breakFlow.sequence].join(' ');
  } else if (breakFlow.phase === 'delay') {
    els.gateInstruction.textContent = 'Keep holding them…';
  } else if (breakFlow.phase === 'entry') {
    els.gateInstruction.textContent = cfg.kind === 'reverse'
      ? 'Type the digits in reverse order — last digit first.'
      : 'Type the digits.';
    els.gateAnswer.value = '';
    els.gateAnswer.focus();
  }
}

// Shown when a failed round has closed the gate; also reopens it on expiry.
function renderGateClosed() {
  const remaining = gateClosedRemaining(state.lock, Date.now());
  if (remaining <= 0) {
    breakFlow.round = 0;
    breakFlow.phase = 'intro';
    els.gateFeedback.textContent = '';
    renderGate();
    return;
  }
  els.gateInstruction.textContent =
    "Not this time — your short-term memory isn't back yet, and that's exactly what the lock is for.";
  els.gateFeedback.textContent = `The gate reopens in ${formatDuration(remaining)}.`;
}

els.gateStart.addEventListener('click', () => {
  if (breakFlow.stage !== 'memory' || breakFlow.phase !== 'intro') return;
  const cfg = GATE_ROUNDS[breakFlow.round];
  breakFlow.sequence = makeSequence(cfg.length);
  breakFlow.phase = 'study';
  breakFlow.phaseEndsAt = Date.now() + cfg.studyMs;
  els.gateFeedback.textContent = '';
  renderGate();
  announce(`Remember these digits: ${[...breakFlow.sequence].join(' ')}.`);
  breakFlow.gateTimer = setInterval(() => {
    const now = Date.now();
    const left = breakFlow.phaseEndsAt - now;
    els.gateCountdown.textContent = String(Math.max(0, Math.ceil(left / 1000)));
    if (left > 0) return;
    if (breakFlow.phase === 'study') {
      breakFlow.phase = 'delay';
      breakFlow.phaseEndsAt = now + cfg.delayMs;
      renderGate();
      announce('Digits hidden. Hold them in mind while we wait.');
    } else if (breakFlow.phase === 'delay') {
      clearInterval(breakFlow.gateTimer);
      breakFlow.gateTimer = 0;
      breakFlow.phase = 'entry';
      renderGate();
      announce(cfg.kind === 'reverse'
        ? 'Now type the digits in reverse order, last digit first.'
        : 'Now type the digits you remember.');
    }
  }, 100);
});

els.gateForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (breakFlow.stage !== 'memory' || breakFlow.phase !== 'entry') return;
  const cfg = GATE_ROUNDS[breakFlow.round];
  if (checkRecall(breakFlow.sequence, els.gateAnswer.value, cfg.kind)) {
    breakFlow.round += 1;
    if (breakFlow.round >= GATE_ROUNDS.length) {
      els.gateFeedback.textContent = '';
      startCoolDown();
    } else {
      breakFlow.phase = 'intro';
      renderGate();
      els.gateFeedback.textContent = `Round ${breakFlow.round} done.`;
      announce(`Round ${breakFlow.round} passed. One more.`);
    }
  } else {
    state = closeGate(state, Date.now());
    saveState();
    breakFlow.phase = 'closed';
    renderGate();
    announce('Not this round. The gate closes for ten minutes — the lock stays.');
  }
});

function startCoolDown() {
  breakFlow.stage = 'wait';
  breakFlow.coolEndsAt = Date.now() + COOL_DOWN_MS;
  renderBreakFlow();
  els.cooldownRemaining.textContent = String(Math.ceil(COOL_DOWN_MS / 1000));
  els.breakCancel.focus();
  announce('Memory check passed. One minute to sit with it.');
  breakFlow.coolTimer = setInterval(() => {
    const left = Math.max(0, Math.ceil((breakFlow.coolEndsAt - Date.now()) / 1000));
    els.cooldownRemaining.textContent = String(left);
    if (left === 0) {
      clearInterval(breakFlow.coolTimer);
      breakFlow.coolTimer = 0;
      els.breakNow.disabled = false;
      announce('The cool-down is over. You can open the lock now, or keep it.');
    }
  }, 250);
}

els.breakNow.addEventListener('click', () => {
  if (breakFlow.stage !== 'wait' || els.breakNow.disabled) return;
  breakLock();
});

els.breakCancel.addEventListener('click', () => {
  resetBreakFlow();
  announce('Kept the lock. Good hold.');
});

// -------- emergency entrance: one tap, one confirm, immediate open --------

function resetEmergency() {
  els.emergencyConfirm.hidden = true;
  els.emergencyOpen.hidden = false;
}

els.emergencyOpen.addEventListener('click', () => {
  els.emergencyOpen.hidden = true;
  els.emergencyConfirm.hidden = false;
  els.emergencyYes.focus();
});

els.emergencyYes.addEventListener('click', emergencyExit);

els.emergencyCancel.addEventListener('click', () => {
  resetEmergency();
  els.emergencyOpen.focus();
  announce('Kept the lock.');
});

// ---------------------------------------------------------------- lifecycle

setInterval(() => {
  if (state.lock) {
    renderTick();
  } else if (!els.viewSetup.hidden) {
    renderEndsPreview(); // keep "would open at…" honest as time passes
  }
  // Keep the "gate reopens in…" countdown live, and reopen it on expiry.
  if (breakFlow.stage === 'memory' && breakFlow.phase === 'closed') renderGateClosed();
}, 250);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resyncFromStorage();
});

// Restored from the back/forward cache: storage events were not delivered
// while parked, so the in-memory state may be behind another tab's writes.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) resyncFromStorage();
});

// Another tab changed the state (started, extended, or broke a lock).
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
  lastSavedRaw = event.newValue;
  state = loadState();
  resetBreakFlow();
  resetEmergency();
  render();
});

if ('serviceWorker' in navigator
  && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
  navigator.serviceWorker.register('./sw.js').catch(() => {
    // Offline install is a nicety; the app works without it.
  });
}

render();
