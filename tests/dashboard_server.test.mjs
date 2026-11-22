import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { ingestFile } from "../core/ingest.mjs";
import { saveProfile } from "../core/query.mjs";
import { syncRegionalGuidelines } from "../core/guidelines.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForServer(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not become ready at ${url}`);
}

test("dashboard server serves /api/dashboard, /api/trend, /api/guidelines, /evidence, /api/upload and blocks path traversal", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ht-srv-data-"));
  const inboxDir = mkdtempSync(path.join(tmpdir(), "ht-srv-inbox-"));
  const opts = {
    dataDir,
    dbPath: path.join(dataDir, "timeline.sqlite"),
    guidelinesPath: path.join(dataDir, "regional-guidelines.md"),
    inboxDir,
    allowSyntheticDemo: true,
  };

  saveProfile(
    {
      fullName: "Synthetic Demo Patient",
      dob: "1985-05-05",
      biologicalSex: "male",
      country: "US",
    },
    opts,
  );
  await syncRegionalGuidelines({ country: "US", biologicalSex: "male", dob: "1985-05-05" }, { ...opts, timeoutMs: 5000 });
  const rCedar = await ingestFile(path.join(FIXTURES_DIR, "cedar-lab.pdf"), opts);
  const rMeridian = await ingestFile(path.join(FIXTURES_DIR, "meridian-diagnostics.pdf"), opts);
  assert.equal(rCedar.status, "ingested");
  assert.equal(rMeridian.status, "ingested");

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "server.mjs")], {
    env: {
      ...process.env,
      HEALTH_TIMELINE_PORT: String(port),
      HEALTH_TIMELINE_DATA_DIR: dataDir,
      HEALTH_TIMELINE_INBOX_DIR: inboxDir,
      HEALTH_TIMELINE_ALLOW_SYNTHETIC: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (c) => {
    stderr += c.toString("utf8");
  });

  try {
    await waitForServer(`${baseUrl}/api/dashboard`);

    // 1. HTML index
    const indexRes = await fetch(`${baseUrl}/`);
    assert.equal(indexRes.status, 200);
    const html = await indexRes.text();
    assert.match(html, /Health Timeline/i);

    // 2. /api/dashboard and /timeline.json
    const dashRes = await fetch(`${baseUrl}/api/dashboard`);
    assert.equal(dashRes.status, 200);
    const dash = await dashRes.json();
    assert.ok(dash.overview, "Missing dash.overview");
    assert.ok(dash.biomarkers?.totalBiomarkers >= 1, "Expected >=1 biomarker");
    assert.ok(dash.defaultBiomarkerKey, "Expected defaultBiomarkerKey");

    const legacyRes = await fetch(`${baseUrl}/timeline.json`);
    assert.equal(legacyRes.status, 200);

    // 3. /api/trend
    const trendRes = await fetch(`${baseUrl}/api/trend?key=${encodeURIComponent(dash.defaultBiomarkerKey)}`);
    assert.equal(trendRes.status, 200);
    const trend = await trendRes.json();
    assert.equal(trend.points.length, 2);

    // 4. /api/guidelines
    const guideRes = await fetch(`${baseUrl}/api/guidelines`);
    assert.equal(guideRes.status, 200);
    const guide = await guideRes.json();
    assert.equal(guide.exists, true);
    assert.ok(guide.targets.length > 0);

    // 5. Evidence endpoints
    const docId = rCedar.documentId;
    const srcRes = await fetch(`${baseUrl}/evidence/${encodeURIComponent(docId)}/source`);
    assert.equal(srcRes.status, 200, `Expected 200 for /evidence/${docId}/source`);
    const srcBuf = Buffer.from(await srcRes.arrayBuffer());
    assert.equal(srcBuf.subarray(0, 4).toString("ascii"), "%PDF");

    const pageRes = await fetch(`${baseUrl}/evidence/${encodeURIComponent(docId)}/page/1.png`);
    // If pdftoppm was available, 200 PNG; if missing locally, 404 is acceptable locally (on VM pdftoppm is installed and must be 200)
    if (pageRes.status === 200) {
      const pngBuf = Buffer.from(await pageRes.arrayBuffer());
      assert.equal(pngBuf[0], 0x89);
      assert.equal(pngBuf[1], 0x50);
    } else {
      assert.equal(pageRes.status, 404);
    }

    // 6. Path traversal rejection on /evidence/
    for (const badPath of [
      "/evidence/../../etc/passwd/source",
      "/evidence/..%2F..%2Fpackage.json/source",
      "/evidence/..%2F..%2Fpackage.json/page/1.png",
      "/evidence/cedar/page/../../package.json",
    ]) {
      const badRes = await fetch(`${baseUrl}${badPath}`);
      assert.ok(
        [400, 403, 404].includes(badRes.status),
        `Path traversal ${badPath} must be rejected (400/403/404), got ${badRes.status}`,
      );
      const body = await badRes.text();
      assert.doesNotMatch(body, /"openclaw"/, "Response must not leak package.json");
      assert.doesNotMatch(body, /root:x:0:0/, "Response must not leak /etc/passwd");
    }

    // 7. POST /api/upload with a photo (JSON base64) -> needs_vlm_extraction
    const uploadPhotoRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "uploaded-photo.png",
        contentBase64: TINY_PNG_BASE64,
      }),
    });
    assert.ok([200, 201, 202].includes(uploadPhotoRes.status), `Photo upload failed (${uploadPhotoRes.status}): ${await uploadPhotoRes.clone().text()}`);
    const uploadPhotoJson = await uploadPhotoRes.json();
    assert.equal(uploadPhotoJson.status, "needs_vlm_extraction", `Expected needs_vlm_extraction, got ${JSON.stringify(uploadPhotoJson)}`);

    // 8. POST /api/upload path traversal filename rejection/containment
    const badUploadRes = await fetch(`${baseUrl}/api/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: "../../outside-traversal.png",
        contentBase64: TINY_PNG_BASE64,
      }),
    });
    if (badUploadRes.ok) {
      const badJson = await badUploadRes.json();
      // If sanitized instead of 400, verify it did NOT escape inboxDir
      const escapedPath = path.resolve(inboxDir, "../../outside-traversal.png");
      assert.throws(() => readFileSync(escapedPath), "Traversal upload must never write outside inboxDir");
      assert.ok(badJson.filename && !badJson.filename.includes(".."));
    } else {
      assert.ok([400, 403].includes(badUploadRes.status), `Expected 400/403 for traversal filename, got ${badUploadRes.status}`);
    }
  } finally {
    child.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(inboxDir, { recursive: true, force: true });
    if (stderr) {
      // keep stderr visible only on failure
    }
  }
});
