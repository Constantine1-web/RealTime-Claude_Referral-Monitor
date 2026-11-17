import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractReferrals, DeduplicationStore, TelegramNotifier } from "./monitor.mjs";

test("extractReferrals extracts and normalizes referral links without duplicates", () => {
  const sampleText = `
    Grab my fresh Claude Pro trial here:
    https://www.claude.ai/referral/AbCdEf123456!
    Duplicate in same post: https://claude.ai/invite/abcdef123456
    And an Anthropic invite: https://anthropic.com/invite/XyZ_98765
  `;
  const matches = extractReferrals(
    sampleText,
    "Free Claude Pro Trials Megathread",
    "https://www.reddit.com/r/ClaudeAI/comments/xyz"
  );

  assert.equal(matches.length, 2);
  assert.equal(matches[0].url, "https://claude.ai/referral/AbCdEf123456");
  assert.equal(matches[0].code, "Claude Referral / Trial:abcdef123456");
  assert.equal(matches[1].url, "https://www.anthropic.com/invite/XyZ_98765");
});

test("DeduplicationStore atomically prevents duplicate alerts", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ref-test-"));
  const dbFile = path.join(tmpDir, "test.db");
  const store = new DeduplicationStore(dbFile);

  const [item] = extractReferrals(
    "Check https://claude.ai/referral/UniqueCode99",
    "Test Title",
    "https://reddit.com/r/test"
  );

  assert.equal(store.isNewAndMark(item), true);
  assert.equal(store.isNewAndMark(item), false);
  assert.equal(store.count(), 1);

  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("TelegramNotifier.escapeMd escapes special MarkdownV2 characters", () => {
  const escaped = TelegramNotifier.escapeMd("Claude Pro (Trial) - Free! [Link]");
  assert.ok(escaped.includes("\\(Trial\\)"));
  assert.ok(escaped.includes("\\!"));
});
