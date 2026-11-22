import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  isAllowedOfficialUrl,
  fetchOfficialSource,
  syncRegionalGuidelines,
  readRegionalGuidelines,
} from "../core/guidelines.mjs";

function makeTempOpts(country) {
  const dataDir = mkdtempSync(path.join(tmpdir(), `ht-guide-${country}-`));
  return {
    dataDir,
    dbPath: path.join(dataDir, "timeline.sqlite"),
    guidelinesPath: path.join(dataDir, "regional-guidelines.md"),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("official domain allowlist blocks unofficial/commercial URLs and allows official health ministries", async () => {
  const blocked = [
    "https://example.com/guidelines",
    "https://www.webmd.com/cholesterol-management/default.htm",
    "https://healthline.com/health/cholesterol",
    "https://gob.mx.evil.com/cenetec",
    "https://cdc.gov.attacker.net/cholesterol",
    "http://localhost:8080/internal",
    "file:///etc/passwd",
  ];
  for (const url of blocked) {
    const check = isAllowedOfficialUrl(url);
    assert.equal(check.allowed, false, `Expected ${url} to be BLOCKED, got ${JSON.stringify(check)}`);
    await assert.rejects(
      () => fetchOfficialSource(url, { timeoutMs: 2000 }),
      /allow|block|official|forbidden|denied|protocol/i,
      `fetchOfficialSource must reject blocked URL ${url}`,
    );
  }

  const allowed = [
    "https://www.gob.mx/cenetec",
    "https://www.dof.gob.mx/",
    "https://www.imss.gob.mx/",
    "https://www.cdc.gov/cholesterol/",
    "https://www.uspreventiveservicestaskforce.org/",
    "https://medlineplus.gov/",
    "https://www.awmf.org/",
    "https://www.rki.de/",
    "https://www.who.int/",
  ];
  for (const url of allowed) {
    const check = isAllowedOfficialUrl(url);
    assert.equal(check.allowed, true, `Expected ${url} to be ALLOWED, got ${JSON.stringify(check)}`);
  }
});

for (const country of ["MX", "US", "DE"]) {
  test(`syncRegionalGuidelines and readRegionalGuidelines work cleanly for ${country}`, async () => {
    const opts = makeTempOpts(country);
    try {
      const profile = {
        fullName: `Synthetic ${country} User`,
        dob: "1990-01-15",
        biologicalSex: "male",
        country,
        pregnancyStatus: "none",
      };

      const synced = await syncRegionalGuidelines(profile, { ...opts, timeoutMs: 6000 });
      assert.equal(synced.country, country);
      assert.ok(synced.guidelinesPath, "Expected guidelinesPath");
      assert.ok(Array.isArray(synced.sources) && synced.sources.length > 0, `Expected official sources for ${country}`);
      assert.ok(Array.isArray(synced.targets) && synced.targets.length > 0, `Expected clinical target bands for ${country}`);

      // Verify every cited source URL passes the official allowlist
      for (const src of synced.sources) {
        const url = typeof src === "string" ? src : src.url;
        assert.ok(url, `Source missing URL: ${JSON.stringify(src)}`);
        assert.equal(isAllowedOfficialUrl(url).allowed, true, `Cited source URL not on official allowlist: ${url}`);
      }

      // Verify markdown written to disk
      const mdOnDisk = readFileSync(opts.guidelinesPath, "utf8");
      assert.ok(mdOnDisk.includes("---"), "Expected YAML frontmatter in regional-guidelines.md");
      assert.ok(mdOnDisk.includes("http"), "Expected official URLs in regional-guidelines.md");

      // Verify readRegionalGuidelines parses it cleanly
      const parsed = readRegionalGuidelines(opts);
      assert.equal(parsed.exists, true);
      assert.equal(parsed.frontmatter?.country, country);
      assert.ok(parsed.sources.length > 0);
      assert.ok(parsed.targets.length > 0);
      assert.ok(parsed.targetsByKey && Object.keys(parsed.targetsByKey).length > 0);
    } finally {
      opts.cleanup();
    }
  });
}
