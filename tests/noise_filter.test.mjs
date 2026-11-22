import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { openDb } from "../core/db.mjs";
import { resolveAnalyte } from "../core/analytes.mjs";
import { commitExtractedDocument } from "../core/ingest.mjs";
import { saveProfile, getDashboardPayload, listBiomarkers } from "../core/query.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempOpts() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ht-noise-"));
  return {
    dataDir,
    dbPath: path.join(dataDir, "timeline.sqlite"),
    guidelinesPath: path.join(dataDir, "regional-guidelines.md"),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("address, footer, signature, and accreditation lines are NEVER stored as observations and defaultBiomarkerKey prefers canonical biomarkers", async () => {
  const opts = makeTempOpts();
  try {
    saveProfile(
      {
        fullName: "Alex Rivera",
        aliases: ["RIVERA, ALEX"],
        dob: "1992-04-10",
        biologicalSex: "male",
        country: "MX",
      },
      opts,
    );

    // Commit a document containing genuine biomarkers mixed with LAPI/LMS address/footer noise rows
    const res = await commitExtractedDocument(
      {
        filename: "lapi-noise-regression.pdf",
        provider: "LAPI",
        orderNumber: "123456",
        reportStatus: "FINAL",
        docType: "lab_report",
        patient: { nameRaw: "RIVERA ALEX Dr.", dobRaw: "10/04/1992" },
        collectedAt: "2025-11-27T08:00:00",
        observations: [
          // Noise rows that MUST be dropped
          { rawName: "Alcaldía Álvaro Obregón. CDMX", specimen: "serum", panel: "Lipids", valueNum: 1470, valueText: "01470", refText: "MIGUEL", page: 1 },
          { rawName: "Lapi, S. A. de C.V. Rosa Blanca # 63. Col. Molino de Rosas", specimen: "serum", valueNum: 63, valueText: "63", page: 1 },
          { rawName: "C.P. 01470", specimen: "serum", valueNum: 1470, valueText: "01470", page: 2 },
          { rawName: "Puente de Piedra No. 150 Tlalpan CDMX", specimen: "serum", valueNum: 150, valueText: "150", page: 1 },
          { rawName: "ATENTAMENTE Q.F.B. Responsable Sanitario", specimen: "serum", valueNum: 123456, valueText: "123456", page: 3 },
          { rawName: "Ced. Prof. 4567890 Universidad", specimen: "serum", valueNum: 4567890, valueText: "4567890", page: 3 },
          { rawName: "CAP ACCREDITED", specimen: "serum", valueNum: 1, valueText: "1", page: 4 },
          { rawName: "Página 1 de 5", specimen: "serum", valueNum: 1, valueText: "1", page: 1 },
          // Genuine clinical biomarkers that MUST be preserved
          { rawName: "Colesterol LDL", specimen: "serum", panel: "Lipids", valueNum: 111, valueText: "111", unitRaw: "mg/dL", refText: "< 100", page: 2 },
          { rawName: "Colesterol HDL", specimen: "serum", panel: "Lipids", valueNum: 60, valueText: "60", unitRaw: "mg/dL", refText: ">= 40", page: 2 },
          { rawName: "Triglicéridos", specimen: "serum", panel: "Lipids", valueNum: 85, valueText: "85", unitRaw: "mg/dL", refText: "< 150", page: 2 },
        ],
      },
      opts,
    );
    assert.equal(res.status, "ingested");
    assert.equal(res.observationsCount, 3, `Expected strictly 3 genuine observations (noise dropped), got ${res.observationsCount}`);

    // Verify second date so LDL has 2 points and custom analyte has 3 points
    await commitExtractedDocument(
      {
        filename: "lms-second-date.pdf",
        provider: "LMS",
        orderNumber: "ORD-1001",
        reportStatus: "FINAL",
        docType: "lab_report",
        patient: { nameRaw: "RIVERA, ALEX", dobRaw: "10/04/1992" },
        collectedAt: "2026-05-11T08:00:00",
        observations: [
          { rawName: "Colesterol LDL", specimen: "serum", panel: "Lipids", valueNum: 117, valueText: "117", unitRaw: "mg/dL", refText: "< 130", page: 3 },
          { rawName: "Obscure Unmapped Test XYZ", specimen: "serum", valueNum: 42, valueText: "42", unitRaw: "U/L", page: 3 },
        ],
      },
      opts,
    );

    const db = openDb(opts);
    try {
      const rows = db.prepare("SELECT canonical_key, display_name, value_text FROM observations WHERE is_active = 1").all();
      const forbiddenPattern = /alcald|obreg|01470|rosa blanca|molino|puente de piedra|tlalpan|cdmx|atentamente|ced\.?\s*prof|cap accredited|p[aá]gina/i;
      for (const row of rows) {
        assert.doesNotMatch(
          `${row.canonical_key} ${row.display_name} ${row.value_text}`,
          forbiddenPattern,
          `Footer/address noise leaked into observations: ${JSON.stringify(row)}`,
        );
      }
    } finally {
      db.close();
    }

    // defaultBiomarkerKey must prefer a canonical biomarker, never custom:*
    const dash = getDashboardPayload(opts);
    assert.ok(dash.defaultBiomarkerKey, "Expected defaultBiomarkerKey");
    assert.equal(
      dash.defaultBiomarkerKey.startsWith("custom:"),
      false,
      `defaultBiomarkerKey must never pick an unmapped custom:* key, got ${dash.defaultBiomarkerKey}`,
    );

    const bio = listBiomarkers(opts);
    const ldl = bio.panels.flatMap((p) => p.biomarkers).find((b) => b.canonicalKey === "serum:ldl");
    assert.ok(ldl && ldl.count === 2, `Expected 2 serum:ldl points, got ${JSON.stringify(ldl)}`);
  } finally {
    opts.cleanup();
  }
});

test("core/extract_pdf.py is_noise_analyte blocks LAPI/LMS address and footer strings", () => {
  const pyCode = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("extract_pdf", sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
noise_samples = [
  "Alcaldía Álvaro Obregón. CDMX",
  "Lapi, S. A. de C.V. Rosa Blanca # 63. Col. Molino de Rosas",
  "C.P. 01470",
  "Puente de Piedra No. 150, Col. Toriello Guerra, Tlalpan",
  "ATENTAMENTE",
  "Ced. Prof. 1234567",
  "CAP ACCREDITED",
  "Página 1 de 5",
  "Tel: 55 5593 7517",
  "https://www.lapi.com.mx",
]
valid_samples = [
  "Colesterol LDL",
  "Glucosa",
  "Hemoglobina",
  "Triglicéridos",
  "TSH",
]
bad_missed = [s for s in noise_samples if not mod.is_noise_analyte(s)]
good_blocked = [s for s in valid_samples if mod.is_noise_analyte(s)]
print(json.dumps({"bad_missed": bad_missed, "good_blocked": good_blocked}))
`;
  const out = execFileSync(
    process.env.HEALTH_TIMELINE_PYTHON || "python3",
    ["-c", pyCode, path.join(REPO_ROOT, "core", "extract_pdf.py")],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(out.trim());
  assert.deepEqual(parsed.bad_missed, [], `extract_pdf.py failed to filter noise strings: ${JSON.stringify(parsed.bad_missed)}`);
  assert.deepEqual(parsed.good_blocked, [], `extract_pdf.py falsely blocked valid analytes: ${JSON.stringify(parsed.good_blocked)}`);
});

test("urine leukocyte esterase is distinct from urine microscopy WBC", () => {
  const esterase = resolveAnalyte("Leucocitos (esterasa)", "urine", null, "Examen General de Orina");
  const wbc = resolveAnalyte("Leucocitos", "urine", "Cels/µL", "Examen General de Orina");
  assert.equal(esterase.canonicalKey, "urine:leukocyte_esterase");
  assert.equal(wbc.canonicalKey, "urine:wbc");
});
