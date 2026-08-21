import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function loadDotEnv() {
  const envPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    ".env",
  );
  let raw;
  try {
    raw = readFileSync(envPath, "utf8");
  } catch {
    return; // no .env file; rely on process env
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required setting ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function parsePhone(name) {
  const value = required(name).replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{6,14}$/.test(value)) {
    throw new Error(
      `${name} must be in E.164 format, e.g. +13475550100 (got "${value}")`,
    );
  }
  return value;
}

function parseTime(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) throw new Error(`WAKEUP_TIME must be 24-hour HH:MM (got "${value}")`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`WAKEUP_TIME out of range (got "${value}")`);
  }
  return { hour, minute };
}

function parseDays(value) {
  if (value.toLowerCase() === "all") return new Set(DAY_NAMES);
  const days = new Set();
  for (const part of value.split(",")) {
    const day = part.trim().toLowerCase().slice(0, 3);
    if (!DAY_NAMES.includes(day)) {
      throw new Error(`WAKEUP_DAYS contains unknown day "${part.trim()}"`);
    }
    days.add(day);
  }
  if (days.size === 0) throw new Error("WAKEUP_DAYS must name at least one day");
  return days;
}

function parseTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
  } catch {
    throw new Error(`WAKEUP_TIMEZONE is not a valid IANA timezone (got "${value}")`);
  }
  return value;
}

export function loadConfig() {
  loadDotEnv();
  return {
    accountSid: required("TWILIO_ACCOUNT_SID"),
    authToken: required("TWILIO_AUTH_TOKEN"),
    from: parsePhone("TWILIO_FROM_NUMBER"),
    to: parsePhone("WAKEUP_TO_NUMBER"),
    time: parseTime(process.env.WAKEUP_TIME ?? "07:00"),
    timezone: parseTimezone(process.env.WAKEUP_TIMEZONE ?? "America/New_York"),
    days: parseDays(process.env.WAKEUP_DAYS ?? "mon,tue,wed,thu,fri"),
    message:
      process.env.WAKEUP_MESSAGE ??
      "Good morning! This is your wake-up call. Time to get up.",
    sayLoop: Math.max(1, Number(process.env.WAKEUP_SAY_LOOP ?? 2) || 1),
    retries: Math.max(0, Number(process.env.WAKEUP_RETRIES ?? 2) || 0),
    retryDelayMinutes: Math.max(
      1,
      Number(process.env.WAKEUP_RETRY_DELAY_MINUTES ?? 3) || 1,
    ),
  };
}

export { DAY_NAMES };
