import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  extractReferrals,
  getTargetSources,
  parseFeedResponse,
  TelegramNotifier,
} from "./lib/core.mjs";
import { DeduplicationStore } from "./monitor.mjs";

test("extractReferrals extracts and normalizes referral links without duplicates", () => {
  const sampleText = `
    Grab my fresh Claude Pro trial here:
    https://www.claude.ai/referral/AbCdEf123456!
    Duplicate in same post: https://claude.ai/invite/abcdef123456
    Guest pass: https://claude.ai/guest-pass/GuestPass777
    And an Anthropic invite: https://anthropic.com/invite/XyZ_98765
  `;
  const matches = extractReferrals(
    sampleText,
    "Free Claude Pro Trials Megathread",
    "https://www.reddit.com/r/ClaudeAI/comments/xyz"
  );

  assert.equal(matches.length, 3);
  assert.equal(matches[0].url, "https://claude.ai/referral/AbCdEf123456");
  assert.equal(matches[0].code, "Claude Referral / Trial:abcdef123456");
  assert.equal(matches[1].url, "https://claude.ai/guest-pass/GuestPass777");
  assert.equal(matches[2].url, "https://www.anthropic.com/invite/XyZ_98765");
});

test("getTargetSources preserves commas inside query params like tags=(story,comment)", () => {
  const raw =
    "https://old.reddit.com/r/ClaudeAI/new/.rss?limit=25,https://hn.algolia.com/api/v1/search_by_date?query=claude&tags=(story,comment)";
  const parsed = getTargetSources(raw);
  assert.equal(parsed.length, 2);
  assert.equal(
    parsed[1],
    "https://hn.algolia.com/api/v1/search_by_date?query=claude&tags=(story,comment)"
  );
});

test("parseFeedResponse extracts referrals from Atom RSS entries and HN Algolia JSON", async () => {
  const atomXml = `
    <feed>
      <entry>
        <title>Claude Pro Trial Available</title>
        <link href="https://www.reddit.com/r/ClaudeAI/comments/abc123" />
        <content type="html">Claim here: https://claude.ai/referral/AtomCode123</content>
      </entry>
    </feed>
  `;
  const rssResp = new Response(atomXml, { headers: { "content-type": "application/atom+xml" } });
  const rssMatches = await parseFeedResponse(rssResp, "https://old.reddit.com/r/ClaudeAI/new/.rss");
  assert.equal(rssMatches.length, 1);
  assert.equal(rssMatches[0].url, "https://claude.ai/referral/AtomCode123");
  assert.equal(rssMatches[0].sourcePermalink, "https://www.reddit.com/r/ClaudeAI/comments/abc123");

  const hnJson = JSON.stringify({
    hits: [
      {
        objectID: "424242",
        title: "Sharing Claude invite",
        comment_text: "Try https://claude.ai/invite/HnInvite99",
      },
    ],
  });
  const hnResp = new Response(hnJson, { headers: { "content-type": "application/json" } });
  const hnMatches = await parseFeedResponse(hnResp, "https://hn.algolia.com/api/v1/search_by_date");
  assert.equal(hnMatches.length, 1);
  assert.equal(hnMatches[0].url, "https://claude.ai/referral/HnInvite99");
  assert.equal(hnMatches[0].sourcePermalink, "https://news.ycombinator.com/item?id=424242");
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
