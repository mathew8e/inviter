/**
 * Phase 1 test — rate-limiter.js
 * Run: node test/phase1-test.js
 */

const fs = require("fs");
const rl = require("../src/rate-limiter");
const config = require("../src/config");

const STATE_PATH = config.rateLimitStatePath;
let failures = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS: ${name}`);
    } catch (e) {
        failures++;
        console.log(`  FAIL: ${name} — ${e.message}`);
    }
}

function assert(condition, msg) {
    if (!condition) throw new Error(msg || "assertion failed");
}

// Clean up before tests
if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
if (fs.existsSync(config.lockFilePath)) fs.unlinkSync(config.lockFilePath);

console.log("=== TEST 1: scanTextForRateLimit (pure function) ===\n");

test("English rate limit detected", () => {
    const r = rl.scanTextForRateLimit("You are doing that too much. Please try again later.");
    assert(r !== null, "should detect English rate limit");
    assert(r.includes("too much"), "should match correct pattern");
});

test("Czech rate limit detected", () => {
    const r = rl.scanTextForRateLimit("Tato akce je dočasně zablokována.");
    assert(r !== null, "should detect Czech rate limit");
    assert(r.includes("zablokov"), "should match Czech pattern");
});

test("Normal text — no false positive", () => {
    const r = rl.scanTextForRateLimit("Welcome to Facebook! Here are your notifications.");
    assert(r === null, "should not match normal text");
});

test("Empty text — no false positive", () => {
    const r = rl.scanTextForRateLimit("");
    assert(r === null, "should not match empty text");
});

test("Czech 'zpomal' detected", () => {
    const r = rl.scanTextForRateLimit("Zpomal! Děláš to příliš často.");
    assert(r !== null, "should detect Czech slow-down");
});

console.log("\n=== TEST 2: todayString ===\n");

test("Returns YYYY-MM-DD format", () => {
    const t = rl.todayString();
    assert(/^\d{4}-\d{2}-\d{2}$/.test(t), `bad format: ${t}`);
    const parts = t.split("-").map(Number);
    assert(parts[1] >= 1 && parts[1] <= 12, `bad month: ${parts[1]}`);
    assert(parts[2] >= 1 && parts[2] <= 31, `bad day: ${parts[2]}`);
});

console.log("\n=== TEST 3: Lock file (atomic) ===\n");

test("First acquire succeeds", () => {
    rl.acquireLock();
    assert(fs.existsSync(config.lockFilePath), "lock file should exist");
});

test("Second acquire throws", () => {
    let threw = false;
    try {
        rl.acquireLock();
    } catch (e) {
        threw = true;
        assert(e.message.includes("in progress"), `wrong error message: ${e.message}`);
    }
    assert(threw, "should have thrown on double acquire");
});

test("Release removes lock", () => {
    rl.releaseLock();
    assert(!fs.existsSync(config.lockFilePath), "lock file should be gone");
});

test("Re-acquire after release works", () => {
    rl.acquireLock();
    assert(fs.existsSync(config.lockFilePath), "lock file should exist");
    rl.releaseLock();
});

console.log("\n=== TEST 4: Daily reset + canInviteToday (fresh state) ===\n");

test("Fresh state: invites allowed", () => {
    const result = rl.canInviteToday();
    assert(result.allowed === true, `should be allowed, got ${JSON.stringify(result)}`);
    assert(result.remaining === config.dailyMax,
        `remaining should be ${config.dailyMax}, got ${result.remaining}`);
    assert(result.reason === null, `reason should be null, got ${result.reason}`);
});

test("Fresh state: state file created", () => {
    assert(fs.existsSync(STATE_PATH), "state file should exist");
});

console.log("\n=== TEST 5: Budget tracking ===\n");

test("After 5 invites, remaining drops", () => {
    rl.recordInvite(5);
    const remaining = rl.getRemainingBudget();
    assert(remaining === config.dailyMax - 5,
        `expected ${config.dailyMax - 5}, got ${remaining}`);
});

test("After 3 more, remaining drops further", () => {
    rl.recordInvite(3);
    const remaining = rl.getRemainingBudget();
    assert(remaining === config.dailyMax - 8,
        `expected ${config.dailyMax - 8}, got ${remaining}`);
});

test("State file reflects invites", () => {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    assert(state.invitesToday === 8, `expected 8, got ${state.invitesToday}`);
    assert(state.date === rl.todayString(), "date should be today");
});

console.log("\n=== TEST 6: Cooldown ===\n");

test("Not in cooldown initially", () => {
    const inC = rl.isInCooldown();
    assert(inC === false, `should not be in cooldown, got ${inC}`);
});

test("enterCooldown sets state", () => {
    rl.enterCooldown(1);
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    assert(state.isCooldown === true, "isCooldown should be true");
    assert(state.cooldownUntil > Date.now(), "cooldownUntil should be in the future");
    assert(state.consecutiveErrors === 1, `expected 1 error, got ${state.consecutiveErrors}`);
});

test("isInCooldown returns true during cooldown", () => {
    const inC = rl.isInCooldown();
    assert(inC === true, "should be in cooldown");
});

test("Cooldown blocks invites", () => {
    const result = rl.canInviteToday();
    assert(result.allowed === false, "should not be allowed during cooldown");
    assert(result.reason === "cooldown_active", `wrong reason: ${result.reason}`);
});

test("Expired cooldown clears", () => {
    // Manually set cooldown to the past
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.cooldownUntil = Date.now() - 1000; // 1 second ago
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");

    const inC = rl.isInCooldown();
    assert(inC === false, "cooldown should have expired");

    // State file should be updated
    const updated = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    assert(updated.isCooldown === false, "isCooldown should be cleared in state file");
});

console.log("\n=== TEST 7: getState ===\n");

test("getState returns a copy with expected keys", () => {
    const state = rl.getState();
    const keys = ["date", "invitesToday", "dailyLimit", "lastInviteTimestamp",
                   "isCooldown", "cooldownUntil", "consecutiveErrors"];
    for (const key of keys) {
        assert(key in state, `missing key: ${key}`);
    }
});

test("getState is a copy (mutation safe)", () => {
    const copy = rl.getState();
    copy.date = "hacked";
    const fresh = rl.getState();
    assert(fresh.date !== "hacked", "getState should return a copy, not the live object");
});

console.log("\n=== TEST 8: Config passthrough ===\n");

test("getLimitPerPost matches config", () => {
    assert(rl.getLimitPerPost() === config.perPostMax, "limit per post mismatch");
});

test("getRunTimeCap matches config", () => {
    assert(rl.getRunTimeCap() === config.runTimeCapMs, "runtime cap mismatch");
});

test("getPostCooldown matches config", () => {
    assert(rl.getPostCooldown() === config.postCooldownMs, "post cooldown mismatch");
});

console.log("\n=== TEST 9: resetErrorCounter ===\n");

test("resetErrorCounter zeroes consecutiveErrors", () => {
    // Manually set errors
    const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    state.consecutiveErrors = 3;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");

    rl.resetErrorCounter();
    const updated = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    assert(updated.consecutiveErrors === 0, `expected 0, got ${updated.consecutiveErrors}`);
});

// ── Cleanup ──
rl.releaseLock();
if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
if (fs.existsSync(config.lockFilePath)) fs.unlinkSync(config.lockFilePath);

console.log(`\n${"=".repeat(50)}`);
if (failures === 0) {
    console.log("ALL TESTS PASSED \u2713");
} else {
    console.log(`${failures} TEST(S) FAILED \u2717`);
    process.exit(1);
}
