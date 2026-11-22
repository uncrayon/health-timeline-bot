import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import plugin from "./openclaw.mjs";

const digest = () => createHash("sha256").update(
  readFileSync(new URL("./build/timeline.sqlite", import.meta.url))
).digest("hex");

test("OpenClaw plugin registers all contract tools and backward-compatible health_ldl_trend returns bounded read-only synthetic comparison", async () => {
  const manifest = JSON.parse(readFileSync(new URL("./openclaw.plugin.json", import.meta.url)));
  assert.equal(plugin.id, manifest.id);

  const registered = new Map();
  let ldlOptions;
  plugin.register({
    registerTool(tool, options) {
      registered.set(tool.name, tool);
      if (tool.name === "health_ldl_trend") ldlOptions = options;
    },
  });

  assert.equal(ldlOptions?.optional, true);
  assert.deepEqual([...registered.keys()].sort(), [...manifest.contracts.tools].sort());

  const ldlTool = registered.get("health_ldl_trend");
  assert.ok(ldlTool, "Missing backward-compatible health_ldl_trend tool");

  const before = digest();
  const output = await ldlTool.execute("synthetic-smoke", { measurement: "ldl_direct_serum" });
  assert.deepEqual(JSON.parse(output.content[0].text), output.details);
  assert.equal(output.details.change, 27.212);
  assert.deepEqual(output.details.review, []);
  assert.deepEqual(output.details.results.map(row => [
    row.collected, row.value, row.unit, row.labRange, row.normalized, row.source.page, row.source.line, row.source.evidencePath,
  ]), [
    ["2026-02-14", "112", "mg/dL", "<100", 112, 1, 8, "/?result=cedar#evidence"],
    ["2026-10-08", "3.60", "mmol/L", "<3.00", 139.212, 2, 6, "/?result=meridian#evidence"],
  ]);
  await assert.rejects(ldlTool.execute("unknown", { measurement: "hdl" }));
  await assert.rejects(ldlTool.execute("outside", { measurement: "ldl_direct_serum", path: "/" }));
  assert.equal(digest(), before);
});
