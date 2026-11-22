import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import plugin, { trendTool } from "./openclaw.mjs";

const digest = () => createHash("sha256").update(
  readFileSync(new URL("./build/timeline.sqlite", import.meta.url))
).digest("hex");

test("optional OpenClaw tool returns a bounded read-only synthetic comparison", async () => {
  const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url)));
  assert.equal(plugin.id, manifest.id);
  let registered;
  plugin.register({ registerTool(tool, options) { registered = tool; assert.equal(options.optional, true); } });
  assert.equal(registered, trendTool);
  assert.deepEqual(manifest.contracts.tools, [registered.name]);
  const before = digest();
  const output = await registered.execute("synthetic-smoke", { measurement: "ldl_direct_serum" });
  assert.deepEqual(JSON.parse(output.content[0].text), output.details);
  assert.equal(output.details.change, 27.212);
  assert.deepEqual(output.details.review, []);
  assert.deepEqual(output.details.results.map(row => [
    row.collected, row.value, row.unit, row.labRange, row.normalized, row.source.page, row.source.line, row.source.evidencePath,
  ]), [
    ["2026-02-14", "112", "mg/dL", "<100", 112, 1, 8, "/?result=cedar#evidence"],
    ["2026-10-08", "3.60", "mmol/L", "<3.00", 139.212, 2, 6, "/?result=meridian#evidence"],
  ]);
  await assert.rejects(registered.execute("unknown", { measurement: "hdl" }));
  await assert.rejects(registered.execute("outside", { measurement: "ldl_direct_serum", path: "/" }));
  assert.equal(digest(), before);
});
