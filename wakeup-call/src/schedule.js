// Offset (ms) between UTC and the given timezone at the given instant.
function tzOffsetMs(timezone, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

// Converts a wall-clock time in a timezone to a UTC Date. A one-pass offset
// guess is exact except within the DST-change hour itself, where it lands
// within the hour — fine for an alarm clock.
function zonedToUtc(timezone, year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = tzOffsetMs(timezone, new Date(guess));
  return new Date(guess - offset);
}

function zonedCalendarDay(timezone, date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

// Next instant the alarm should fire, strictly after `from`.
export function nextWakeTime(config, from = new Date()) {
  for (let dayOffset = 0; dayOffset < 8; dayOffset++) {
    // Walk forward in calendar days of the target timezone by probing noon
    // UTC-ish instants, then resolve the exact local wake time for that day.
    const probe = new Date(from.getTime() + dayOffset * 24 * 60 * 60 * 1000);
    const { year, month, day } = zonedCalendarDay(config.timezone, probe);
    const candidate = zonedToUtc(
      config.timezone,
      year,
      month,
      day,
      config.time.hour,
      config.time.minute,
    );
    if (candidate <= from) continue;
    const localWeekday = new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      weekday: "short",
    })
      .format(candidate)
      .toLowerCase();
    if (config.days.has(localWeekday)) return candidate;
  }
  throw new Error("Could not find a wake-up day within the next week");
}

export function describe(config, when) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: config.timezone,
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(when);
}
