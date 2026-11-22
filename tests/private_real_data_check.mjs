#!/usr/bin/env node
/**
 * Private real-data end-to-end verification script.
 * Run ONLY against a private inbox directory (e.g. on GCP VM against ~/private-labs-inbox).
 * NEVER commit any real-data DB, profile, or output files into the repository!
 *
 * Usage:
 *   node tests/private_real_data_check.mjs \
 *     --inbox ~/private-labs-inbox \
 *     --data-dir /tmp/ht-private-verify \
 *     --name "<FULL NAME>" \
 *     --aliases "<ALIAS1>|<ALIAS2>" \
 *     --dob "YYYY-MM-DD" \
 *     --sex "male" \
 *     --country "MX" \
 *     --expected-skipped "Resultados2605110274.pdf"
 */
import assert from "node:assert/strict";
import { rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

import { openDb } from "../core/db.mjs";
import { ingestDirectory } from "../core/ingest.mjs";
import {
  saveProfile,
  listBiomarkers,
  getTrend,
  getTimeline,
  getOverview,
  getDashboardPayload,
} from "../core/query.mjs";
import { syncRegionalGuidelines, readRegionalGuidelines } from "../core/guidelines.mjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i];
    if (key.startsWith("--")) {
      args[key.slice(2)] = argv[i + 1];
      i++;
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.inbox || !args.name) {
  console.error("Usage: node tests/private_real_data_check.mjs --inbox <dir> --name <fullName> [--aliases a|b] [--dob YYYY-MM-DD] [--sex male] [--country MX] [--data-dir <dir>] [--expected-skipped <filename>]");
  process.exit(2);
}

const inboxDir = path.resolve(args.inbox);
const dataDir = path.resolve(args["data-dir"] || "/tmp/ht-private-verify");
const expectedSkipped = args["expected-skipped"] || "Resultados2605110274.pdf";

if (existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true });
}
mkdirSync(dataDir, { recursive: true });

const opts = {
  dataDir,
  dbPath: path.join(dataDir, "timeline.sqlite"),
  guidelinesPath: path.join(dataDir, "regional-guidelines.md"),
  inboxDir,
  allowSyntheticDemo: false,
};

const aliases = args.aliases ? args.aliases.split("|").map((s) => s.trim()).filter(Boolean) : [];
const profile = saveProfile(
  {
    fullName: args.name,
    aliases,
    dob: args.dob || null,
    biologicalSex: args.sex || "male",
    country: args.country || "MX",
    pregnancyStatus: "none",
  },
  opts,
);

console.log("[1/7] Profile saved for country:", profile.country);

// Sync MX regional guidelines
const guideSync = await syncRegionalGuidelines(profile, { ...opts, timeoutMs: 8000 });
const guideRead = readRegionalGuidelines(opts);
assert.equal(guideRead.exists, true);
assert.ok(guideRead.targets.length > 0, "Expected regional guideline targets");
console.log(`[2/7] Regional guidelines synced (${guideSync.country}, mode=${guideSync.sourceMode}, targets=${guideRead.targets.length})`);

// Ingest private inbox directory
const batch = await ingestDirectory(inboxDir, opts);
console.log("[3/7] Batch ingest summary:", {
  processed: batch.processed,
  ingested: batch.ingested,
  skipped: batch.skipped,
  duplicates: batch.duplicates,
  needsVlm: batch.needsVlm,
  errors: batch.errors,
});

assert.equal(batch.processed, 8, `Expected 8 PDFs processed, got ${batch.processed}`);
assert.equal(batch.errors, 0, `Expected 0 ingest errors, got ${JSON.stringify(batch.results.filter((r) => r.status === "error"))}`);
assert.equal(batch.ingested, 7, `Expected 7 owner PDFs ingested, got ${batch.ingested}`);
assert.equal(batch.skipped, 1, `Expected 1 non-owner PDF skipped, got ${batch.skipped}`);

// Verify patient gate strictly
const db = openDb(opts);
let skippedRows;
let docs;
let obsByDoc;
try {
  skippedRows = db.prepare("SELECT filename, provider, reason FROM skipped_documents").all();
  docs = db.prepare("SELECT id, filename, provider, order_number, report_status, superseded_by, collected_at FROM documents ORDER BY filename").all();
  obsByDoc = db.prepare("SELECT document_id, COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active FROM observations GROUP BY document_id").all();
} finally {
  db.close();
}

assert.equal(skippedRows.length, 1, `Expected 1 row in skipped_documents, got ${skippedRows.length}`);
assert.equal(skippedRows[0].filename, expectedSkipped, `Expected ${expectedSkipped} to be skipped, got ${skippedRows[0].filename}`);
assert.equal(docs.some((d) => d.filename === expectedSkipped), false, "Skipped document must NOT appear in documents table");
console.log("[4/7] Patient Identity Gate verified: 7 owner PDFs ingested, 1 non-owner skipped with 0 observations.");

// Verify owner-encrypted LAPI PDFs parsed cleanly
const lapiDocs = docs.filter((d) => /lapi/i.test(d.provider) || /orden/i.test(d.filename));
assert.equal(lapiDocs.length, 2, `Expected 2 LAPI PDFs ingested, got ${lapiDocs.length}`);
const obsCountMap = new Map(obsByDoc.map((r) => [r.document_id, r]));
const lapiMainDoc = lapiDocs.find((d) => !d.filename.startsWith("ordenextrac"));
assert.ok(lapiMainDoc && (obsCountMap.get(lapiMainDoc.id)?.total || 0) > 10, "Expected main LAPI PDF to extract >10 observations");

// Verify PARCIAL superseded by FINAL
const parcialDoc = docs.find((d) => d.filename === "Resultados2605110275.pdf");
const finalDoc = docs.find((d) => d.filename === "Resultados2605110275 (1).pdf");
assert.ok(parcialDoc && finalDoc, "Expected both 2605110275 PARCIAL and FINAL documents");
assert.equal(parcialDoc.superseded_by, finalDoc.id, `Expected PARCIAL superseded_by=${finalDoc.id}, got ${parcialDoc.superseded_by}`);
assert.equal(obsCountMap.get(parcialDoc.id)?.active || 0, 0, "Superseded PARCIAL doc must have 0 active observations");

// Verify LAPI ordenextrac deduplication + Metabolic Syndrome finding preserved
const lapiExtraDoc = lapiDocs.find((d) => d.filename.startsWith("ordenextrac"));
assert.ok(lapiExtraDoc, "Expected LAPI ordenextrac document");
const timeline = getTimeline({}, opts);
const allFindings = timeline.events.flatMap((e) => e.findings || []);
assert.ok(
  allFindings.some((f) => /metab[oó]lic|s[ií]ndrome/i.test(`${f.title} ${f.summary} ${f.excerpt || ""}`)),
  `Expected Metabolic Syndrome finding preserved from ordenextrac, got ${allFindings.length} findings`,
);
console.log("[5/7] Superseding (PARCIAL->FINAL), LAPI encryption, and ordenextrac deduplication + findings verified.");

// Verify specimen disambiguation (serum vs urine glucose, and hemoglobin/leukocytes if present)
const biomarkers = listBiomarkers(opts);
const allBio = biomarkers.panels.flatMap((p) => p.biomarkers);
const bioKeys = new Set(allBio.map((b) => b.canonicalKey));
const serumGlucoseKey = [...bioKeys].find((k) => /^serum:glucose$/i.test(k));
const urineGlucoseKey = [...bioKeys].find((k) => /^urine:glucose$/i.test(k));
assert.ok(serumGlucoseKey, `Expected serum:glucose in extracted biomarkers (found: ${[...bioKeys].filter((k) => k.includes("glucose"))})`);
assert.ok(urineGlucoseKey, `Expected urine:glucose in extracted biomarkers (found: ${[...bioKeys].filter((k) => k.includes("glucose"))})`);

const serumGlucTrend = getTrend(serumGlucoseKey, opts);
assert.equal(serumGlucTrend.specimen, "serum", "serum:glucose trend must have specimen=serum");
// Ensure no duplicate LAPI order 695710 serum:glucose points
const lapiGlucPoints = serumGlucTrend.points.filter((p) => p.orderNumber === lapiMainDoc.order_number);
assert.ok(lapiGlucPoints.length <= 1, `Expected <=1 active serum:glucose point for LAPI order ${lapiMainDoc.order_number}, got ${lapiGlucPoints.length}`);

const urineGlucTrend = getTrend(urineGlucoseKey, opts);
assert.equal(urineGlucTrend.specimen, "urine", "urine:glucose trend must have specimen=urine");
console.log(`[6/7] Specimen disambiguation verified (${allBio.length} canonical biomarkers, ${biomarkers.totalActiveObservations} active observations).`);

// Verify lab ref ranges & computed abnormal flags exist (even when LMS INDICADOR is an image)
const overview = getOverview(opts);
const dashboard = getDashboardPayload(opts);
assert.ok(dashboard.biomarkers.totalBiomarkers > 15, `Expected >15 biomarkers, got ${dashboard.biomarkers.totalBiomarkers}`);
assert.ok(overview.counts.skippedDocuments === 1, "Overview must report 1 skipped document");
// Check that observations have refText and computed flags (normal/high/low)
const db2 = openDb(opts);
try {
  const flagStats = db2.prepare("SELECT flag, COUNT(*) AS c FROM observations WHERE is_active = 1 GROUP BY flag").all();
  const withRef = db2.prepare("SELECT COUNT(*) AS c FROM observations WHERE is_active = 1 AND ref_text IS NOT NULL AND ref_text != ''").get().c;
  assert.ok(withRef > 20, `Expected >20 active observations with preserved lab ref ranges, got ${withRef}`);
  const flagMap = Object.fromEntries(flagStats.map((r) => [r.flag, r.c]));
  assert.ok((flagMap.normal || 0) > 10, `Expected >10 computed normal flags, got ${JSON.stringify(flagMap)}`);
  assert.ok((flagMap.high || 0) + (flagMap.low || 0) + (flagMap.abnormal || 0) > 0, `Expected computed abnormal flags, got ${JSON.stringify(flagMap)}`);
  console.log("[7/7] Ref ranges & computed flags verified:", { withRef, flagMap });
} finally {
  db2.close();
}

console.log("ALL PRIVATE REAL-DATA CHECKS PASSED!");
