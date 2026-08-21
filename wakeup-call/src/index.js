import { loadConfig } from "./config.js";
import { placeCall, waitForOutcome, wasAnswered } from "./twilio.js";
import { nextWakeTime, describe } from "./schedule.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// One wake-up: place the call, and retry if it wasn't answered.
async function ringUntilAnswered(config) {
  const attempts = 1 + config.retries;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    log(`Calling ${config.to} (attempt ${attempt}/${attempts})...`);
    const sid = await placeCall(config);
    const status = await waitForOutcome(config, sid);
    if (wasAnswered(status)) {
      log("Call answered. Good morning!");
      return true;
    }
    log(`Call ended with status "${status}".`);
    if (attempt < attempts) {
      log(`Retrying in ${config.retryDelayMinutes} minute(s)...`);
      await sleep(config.retryDelayMinutes * 60 * 1000);
    }
  }
  log("Out of retries; giving up on this wake-up. Hope you're already up.");
  return false;
}

async function runScheduler(config) {
  log(
    `Wake-up calls to ${config.to} at ` +
      `${String(config.time.hour).padStart(2, "0")}:${String(config.time.minute).padStart(2, "0")} ` +
      `(${config.timezone}) on: ${[...config.days].join(", ")}`,
  );
  for (;;) {
    const next = nextWakeTime(config);
    log(`Next wake-up call: ${describe(config, next)}`);
    // Sleep in chunks so long waits never overflow setTimeout's 32-bit limit.
    while (next.getTime() - Date.now() > 0) {
      await sleep(Math.min(next.getTime() - Date.now(), 60 * 60 * 1000));
    }
    try {
      await ringUntilAnswered(config);
    } catch (err) {
      log(`Wake-up failed: ${err.message}`);
    }
  }
}

async function main() {
  const command = process.argv[2] ?? "start";
  const config = loadConfig();
  if (command === "now") {
    const ok = await ringUntilAnswered(config);
    process.exit(ok ? 0 : 1);
  } else if (command === "next") {
    console.log(describe(config, nextWakeTime(config)));
  } else if (command === "start") {
    await runScheduler(config);
  } else {
    console.error(`Unknown command "${command}". Use: start | now | next`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
