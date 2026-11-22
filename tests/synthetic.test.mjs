import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openDb } from "../core/db.mjs";
import { normalizeName, evaluatePatientMatch } from "../core/patient_gate.mjs";
import {
  resolveAnalyte,
  normalizeUnit,
  convertValue,
  parseReferenceRange,
  computeFlag,
} from "../core/analytes.mjs";
import { ingestFile } from "../core/ingest.mjs";
import {
  getOverview,
  getTimeline,
  getTrend,
  getEvidence,
  listBiomarkers,
} from "../core/query.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

function makeTempOpts() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ht-synth-"));
  return {
    dataDir,
    dbPath: path.join(dataDir, "timeline.sqlite"),
    guidelinesPath: path.join(dataDir, "regional-guidelines.md"),
    allowSyntheticDemo: true,
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("patient_gate handles accents, LMS comma format, LAPI trailing Dr., and rejects mismatches", () => {
  const profile = {
    fullName: "Juan Carlos Perez Garcia",
    aliases: ["PEREZ GARCIA, JUAN CARLOS", "PEREZ GARCIA JUAN CARLOS"],
    dob: "1990-05-15",
    biologicalSex: "male",
  };

  assert.equal(normalizeName("Pérez García, Juan Carlos"), "perez garcia juan carlos");

  const lmsMatch = evaluatePatientMatch(
    { nameRaw: "PÉREZ GARCÍA, JUAN CARLOS", dobRaw: "15/05/1990", sexRaw: "M" },
    profile,
    {},
  );
  assert.equal(lmsMatch.matched, true, `Expected LMS match, got: ${JSON.stringify(lmsMatch)}`);

  const lapiMatch = evaluatePatientMatch(
    { nameRaw: "PEREZ GARCIA JUAN CARLOS Dr.", dobRaw: "15/05/90" },
    profile,
    {},
  );
  assert.equal(lapiMatch.matched, true, `Expected LAPI match, got: ${JSON.stringify(lapiMatch)}`);

  const wrongPerson = evaluatePatientMatch(
    { nameRaw: "LOPEZ MARTINEZ, MARIA ELENA", dobRaw: "20/08/1992", sexRaw: "F" },
    profile,
    {},
  );
  assert.equal(wrongPerson.matched, false, `Expected mismatch rejection, got: ${JSON.stringify(wrongPerson)}`);

  const wrongSibling = evaluatePatientMatch(
    { nameRaw: "PEREZ GARCIA, SOFIA", dobRaw: "12/03/1993", sexRaw: "F" },
    profile,
    {},
  );
  assert.equal(wrongSibling.matched, false, `Expected sibling mismatch rejection, got: ${JSON.stringify(wrongSibling)}`);
});

test("analytes ontology disambiguates specimen, converts LDL mmol/L->mg/dL, parses ranges, and computes flags", () => {
  const serumGlucose = resolveAnalyte("GLUCOSA", "serum", "mg/dL", "Quimica Sanguinea");
  const urineGlucose = resolveAnalyte("GLUCOSA", "urine", "mg/dL", "Examen General de Orina");
  assert.notEqual(
    serumGlucose.canonicalKey,
    urineGlucose.canonicalKey,
    "Serum and urine glucose must have distinct canonical keys",
  );
  assert.match(serumGlucose.canonicalKey, /serum.*glucose/i);
  assert.match(urineGlucose.canonicalKey, /urine.*glucose/i);

  const ldl = resolveAnalyte("LDL Cholesterol (Direct)", "serum", "mmol/L", "Lipids");
  assert.match(ldl.canonicalKey, /ldl/i);
  const converted = convertValue(ldl.canonicalKey, 3.6, "mmol/L");
  assert.ok(
    Math.abs(converted.normalizedValue - 139.212) < 0.05,
    `Expected ~139.212 mg/dL, got ${JSON.stringify(converted)}`,
  );

  assert.equal(normalizeUnit("µg/dL"), normalizeUnit("ug/dL"));
  assert.equal(normalizeUnit("UI/L"), normalizeUnit("U/L"));

  const rangeTwoSided = parseReferenceRange("70 - 99");
  assert.equal(rangeTwoSided.refLow, 70);
  assert.equal(rangeTwoSided.refHigh, 99);

  const rangeLess = parseReferenceRange("< 100");
  assert.equal(rangeLess.refHigh, 100);

  const rangeSpanish = parseReferenceRange("Menor a 150");
  assert.equal(rangeSpanish.refHigh, 150);

  assert.equal(computeFlag({ valueNum: 112, refLow: null, refHigh: 100 }), "high");
  assert.equal(computeFlag({ valueNum: 65, refLow: 70, refHigh: 99 }), "low");
  assert.equal(computeFlag({ valueNum: 85, refLow: 70, refHigh: 99 }), "normal");
});

test("synthetic demo acceptance: ingest Cedar & Meridian idempotently, order by collection date, convert LDL, verify evidence, no hallucinated follow-up", async () => {
  const opts = makeTempOpts();
  try {
    // Ingest Meridian first (collected Oct 2026, received Oct 10) then Cedar (collected Feb 2026, received Oct 18)
    const meridianPath = path.join(FIXTURES_DIR, "meridian-diagnostics.pdf");
    const cedarPath = path.join(FIXTURES_DIR, "cedar-lab.pdf");

    const r1 = await ingestFile(meridianPath, opts);
    assert.equal(r1.status, "ingested", `Meridian ingest failed: ${JSON.stringify(r1)}`);

    const r2 = await ingestFile(cedarPath, opts);
    assert.equal(r2.status, "ingested", `Cedar ingest failed: ${JSON.stringify(r2)}`);

    // Idempotent re-import
    const r1Again = await ingestFile(meridianPath, opts);
    assert.equal(r1Again.status, "duplicate", `Expected duplicate on re-import, got: ${JSON.stringify(r1Again)}`);
    const r2Again = await ingestFile(cedarPath, opts);
    assert.equal(r2Again.status, "duplicate", `Expected duplicate on re-import, got: ${JSON.stringify(r2Again)}`);

    // Verify DB counts remain strictly 2 documents
    const db = openDb(opts);
    try {
      const docCount = db.prepare("SELECT COUNT(*) AS c FROM documents").get().c;
      assert.equal(docCount, 2, `Expected 2 documents after idempotent re-import, got ${docCount}`);
    } finally {
      db.close();
    }

    // Verify collection-date ordering (Cedar 2026-02-14 before Meridian 2026-10-08)
    const timeline = getTimeline({}, opts);
    assert.equal(timeline.events.length, 2);
    const dates = timeline.events.map((e) => e.collectedAt?.slice(0, 10));
    assert.deepEqual(dates, ["2026-02-14", "2026-10-08"]);

    // Find canonical LDL key from biomarkers list
    const biomarkers = listBiomarkers(opts);
    const allBio = biomarkers.panels.flatMap((p) => p.biomarkers);
    const ldlBio = allBio.find((b) => /ldl/i.test(b.canonicalKey));
    assert.ok(ldlBio, `Expected LDL biomarker in listBiomarkers: ${JSON.stringify(allBio)}`);

    const trend = getTrend(ldlBio.canonicalKey, opts);
    assert.equal(trend.points.length, 2, `Expected 2 trend points, got ${JSON.stringify(trend)}`);
    assert.deepEqual(
      trend.points.map((p) => p.collectedAt?.slice(0, 10)),
      ["2026-02-14", "2026-10-08"],
    );
    assert.equal(trend.points[0].normalizedValue, 112);
    assert.ok(
      Math.abs(trend.points[1].normalizedValue - 139.212) < 0.05,
      `Expected ~139.212, got ${trend.points[1].normalizedValue}`,
    );
    assert.ok(
      Math.abs(trend.change.absolute - 27.212) < 0.05,
      `Expected change ~27.212, got ${JSON.stringify(trend.change)}`,
    );

    // Verify evidence & bounding boxes (when bbox extracted)
    for (const pt of trend.points) {
      assert.ok(pt.page >= 1, `Expected page >= 1 on point ${JSON.stringify(pt)}`);
      assert.ok(pt.excerpt && pt.excerpt.length > 0, "Expected non-empty excerpt");
      const ev = getEvidence(pt.observationId, opts);
      assert.ok(ev, `Expected getEvidence to return record for ${pt.observationId}`);
      assert.equal(ev.page, pt.page);
      if (Array.isArray(ev.bbox) && ev.bbox.length === 4) {
        const [x, y, w, h] = ev.bbox;
        assert.ok(x >= 0 && x < x + w && x + w <= 1.01, `Invalid bbox x/w: ${ev.bbox}`);
        assert.ok(y >= 0 && y < y + h && y + h <= 1.01, `Invalid bbox y/h: ${ev.bbox}`);
      }
    }

    // No hallucinated follow-ups
    const overview = getOverview(opts);
    assert.deepEqual(overview.followups, [], `Expected no hallucinated follow-ups, got ${JSON.stringify(overview.followups)}`);
  } finally {
    opts.cleanup();
  }
});
