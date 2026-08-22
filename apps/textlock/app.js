import {
  STORAGE_KEY, MAX_HOURS, HOUR_MS, BREAK_PHRASE, HOLD_TO_BREAK_MS, COOL_DOWN_MS,
  initialState, reviveState, clampHours, startLock, addHour, finishLock,
  holdMessage, dismissMessage, heldMessages, releasedMessages,
  isActive, remainingMs, progress, formatDuration, formatHours, currentStreak,
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
  stepPhrase: $('break-step-phrase'),
  stepWait: $('break-step-wait'),
  holdButton: $('hold-button'),
  holdLabel: $('hold-label'),
  holdFill: $('hold-fill'),
  phraseInput: $('phrase-input'),
  cooldownRemaining: $('cooldown-remaining'),
  breakNow: $('break-now'),
  breakCancel: $('break-cancel'),
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

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or full quota: the app still works for this page load.
  }
}

let state = loadState();

// Banner about the most recent finish, kept only for this page session.
let finishedNotice = null;

// Break-glass flow lives in memory on purpose: reloading restarts the steps.
const breakFlow = { stage: 'idle', holdStart: 0, holdTimer: 0, coolTimer: 0, coolEndsAt: 0 };

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

function maybeNotify(title, body) {
  if (!state.settings.notify) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    new Notification(title, { body, icon: './icon.svg' });
  } catch {
    // Some platforms only allow notifications from a service worker; skip.
  }
}

// ---------------------------------------------------------------- rendering

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

  if (locked) {
    els.lockReason.hidden = !state.lock.reason;
    els.lockReason.textContent = state.lock.reason ? `“${state.lock.reason}”` : '';
    renderTick(now);
    renderVaultCount();
    renderBreakFlow();
  } else {
    renderFinishedBanner();
    renderReleased();
    renderStats();
    renderEndsPreview();
    els.notify.checked = state.settings.notify;
  }
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
  if (hours === null) {
    els.endsPreview.textContent = '';
    return;
  }
  const endsAt = Date.now() + hours * HOUR_MS;
  els.endsPreview.textContent = `The lock would open at ${formatWhen(endsAt)}.`;
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

function completeLock() {
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
  state = finishLock(state, Date.now(), 'broken');
  finishedNotice = { outcome: 'broken' };
  resetBreakFlow();
  resetEmergency();
  saveState();
  render();
  announce('Lock broken. The line is open.');
}

function emergencyExit() {
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
    if (p === button) p.setAttribute('aria-pressed', 'true');
    else p.removeAttribute('aria-pressed');
  }
  els.customHours.value = button.dataset.hours;
  renderEndsPreview();
});

els.customHours.addEventListener('input', () => {
  const preset = selectedPreset();
  if (preset && preset.dataset.hours !== els.customHours.value) {
    preset.classList.remove('is-selected');
    preset.removeAttribute('aria-pressed');
  }
  renderEndsPreview();
});

els.notify.addEventListener('change', async () => {
  state.settings.notify = els.notify.checked;
  if (els.notify.checked && 'Notification' in window && Notification.permission === 'default') {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      state.settings.notify = false;
      els.notify.checked = false;
    }
  }
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

// -------- break-glass flow: hold 5 s → type the phrase → wait 60 s --------

function resetBreakFlow() {
  breakFlow.stage = 'idle';
  clearInterval(breakFlow.holdTimer);
  clearInterval(breakFlow.coolTimer);
  breakFlow.holdTimer = 0;
  breakFlow.coolTimer = 0;
  els.holdFill.style.width = '0%';
  els.holdLabel.textContent = 'Hold to begin';
  els.phraseInput.value = '';
  els.breakNow.disabled = true;
  if (els.breakDetails) els.breakDetails.open = false;
  renderBreakFlow();
}

function renderBreakFlow() {
  els.stepHold.hidden = false;
  els.stepPhrase.hidden = breakFlow.stage === 'idle';
  els.stepWait.hidden = breakFlow.stage !== 'wait';
}

function beginHold() {
  if (breakFlow.stage !== 'idle' || breakFlow.holdTimer) return;
  breakFlow.holdStart = Date.now();
  breakFlow.holdTimer = setInterval(() => {
    const held = Date.now() - breakFlow.holdStart;
    const pct = Math.min(100, (held / HOLD_TO_BREAK_MS) * 100);
    els.holdFill.style.width = `${pct}%`;
    const secondsLeft = Math.ceil((HOLD_TO_BREAK_MS - held) / 1000);
    els.holdLabel.textContent = secondsLeft > 0 ? `Keep holding… ${secondsLeft}` : 'Done';
    if (held >= HOLD_TO_BREAK_MS) {
      clearInterval(breakFlow.holdTimer);
      breakFlow.holdTimer = 0;
      breakFlow.stage = 'phrase';
      els.holdLabel.textContent = 'Step 1 done';
      renderBreakFlow();
      els.phraseInput.focus();
      announce(`Step one done. Type the phrase: ${BREAK_PHRASE}.`);
    }
  }, 100);
}

function cancelHold() {
  if (!breakFlow.holdTimer) return;
  clearInterval(breakFlow.holdTimer);
  breakFlow.holdTimer = 0;
  els.holdFill.style.width = '0%';
  els.holdLabel.textContent = 'Hold to begin';
}

els.holdButton.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  try {
    els.holdButton.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic events can carry an unknown pointerId; capture is optional.
  }
  beginHold();
});
els.holdButton.addEventListener('pointerup', cancelHold);
els.holdButton.addEventListener('pointercancel', cancelHold);
els.holdButton.addEventListener('keydown', (event) => {
  if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
    event.preventDefault();
    beginHold();
  }
});
els.holdButton.addEventListener('keyup', (event) => {
  if (event.key === ' ' || event.key === 'Enter') cancelHold();
});
els.holdButton.addEventListener('blur', cancelHold);

els.phraseInput.addEventListener('input', () => {
  if (breakFlow.stage !== 'phrase') return;
  if (els.phraseInput.value.trim().toLowerCase() !== BREAK_PHRASE) return;
  breakFlow.stage = 'wait';
  breakFlow.coolEndsAt = Date.now() + COOL_DOWN_MS;
  renderBreakFlow();
  els.breakCancel.focus();
  announce('Step two done. One minute to sit with it.');
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
});

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
  if (state.lock) renderTick();
}, 250);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) render();
});

// Another tab changed the state (started, extended, or broke a lock).
window.addEventListener('storage', (event) => {
  if (event.key !== STORAGE_KEY) return;
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
