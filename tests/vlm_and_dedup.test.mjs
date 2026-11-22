import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDb } from "../core/db.mjs";
import { ingestFile, commitExtractedDocument } from "../core/ingest.mjs";
import { saveProfile, getTrend, getTimeline, getOverview } from "../core/query.mjs";

// Minimal 1x1 valid PNG (67 bytes)
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function makeTempOpts() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "ht-vlm-dedup-"));
  return {
    dataDir,
    dbPath: path.join(dataDir, "timeline.sqlite"),
    guidelinesPath: path.join(dataDir, "regional-guidelines.md"),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  };
}

test("VLM photo path: ingestFile on .png returns needs_vlm_extraction; commitExtractedDocument enforces patient gate", async () => {
  const opts = makeTempOpts();
  try {
    saveProfile(
      {
        fullName: "Alex Rivera",
        aliases: ["RIVERA, ALEX", "RIVERA ALEX"],
        dob: "1992-04-10",
        biologicalSex: "male",
        country: "MX",
      },
      opts,
    );

    const photoPath = path.join(opts.dataDir, "lab-photo.png");
    writeFileSync(photoPath, Buffer.from(TINY_PNG_BASE64, "base64"));

    const photoResult = await ingestFile(photoPath, opts);
    assert.equal(photoResult.status, "needs_vlm_extraction", `Got: ${JSON.stringify(photoResult)}`);
    assert.ok(Array.isArray(photoResult.imagePaths) && photoResult.imagePaths.length >= 1);
    assert.ok(photoResult.schemaHint, "Expected schemaHint for VLM extraction");

    // Commit valid matching patient payload
    const validCommit = await commitExtractedDocument(
      {
        filename: "lab-photo.png",
        sourcePath: photoPath,
        provider: "Photo Lab MX",
        orderNumber: "PHOTO-1001",
        reportStatus: "FINAL",
        docType: "lab_photo",
        pageCount: 1,
        patient: { nameRaw: "RIVERA, ALEX", dobRaw: "10/04/1992", sexRaw: "M" },
        collectedAt: "2026-03-15",
        reportedAt: "2026-03-15",
        observations: [
          {
            rawName: "Glucosa en suero",
            specimen: "serum",
            panel: "Quimica Sanguinea",
            valueNum: 92,
            valueText: "92",
            unitRaw: "mg/dL",
            refText: "70 - 99",
            page: 1,
            excerpt: "Glucosa en suero: 92 mg/dL (70 - 99)",
          },
        ],
      },
      opts,
    );
    assert.equal(validCommit.status, "ingested", `Expected ingested, got: ${JSON.stringify(validCommit)}`);
    assert.equal(validCommit.observationsCount, 1);

    // Commit non-matching patient payload -> MUST be rejected into skipped_documents with 0 observations written
    const rejectedCommit = await commitExtractedDocument(
      {
        filename: "other-person-photo.png",
        provider: "Photo Lab MX",
        orderNumber: "PHOTO-9999",
        reportStatus: "FINAL",
        patient: { nameRaw: "GARCIA LOPEZ, MARIA", dobRaw: "01/01/1988", sexRaw: "F" },
        collectedAt: "2026-03-16",
        observations: [
          {
            rawName: "Glucosa en suero",
            specimen: "serum",
            valueNum: 180,
            valueText: "180",
            unitRaw: "mg/dL",
            refText: "70 - 99",
            page: 1,
            excerpt: "Glucosa en suero: 180 mg/dL",
          },
        ],
      },
      opts,
    );
    assert.equal(rejectedCommit.status, "skipped", `Expected skipped, got: ${JSON.stringify(rejectedCommit)}`);

    const db = openDb(opts);
    try {
      const obsRows = db.prepare("SELECT value_num FROM observations").all();
      assert.deepEqual(
        obsRows.map((r) => r.value_num),
        [92],
        "Non-owner observation must never be stored",
      );
      const skippedRows = db.prepare("SELECT filename, patient_name_raw, reason FROM skipped_documents").all();
      assert.equal(skippedRows.length, 1);
      assert.equal(skippedRows[0].filename, "other-person-photo.png");
    } finally {
      db.close();
    }
  } finally {
    opts.cleanup();
  }
});

test("deduplication: FINAL supersedes PARCIAL and companion summary deduplicates overlapping metrics while preserving unique findings", async () => {
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

    // 1. PARCIAL report
    const parcial = await commitExtractedDocument(
      {
        filename: "order-1001-parcial.pdf",
        provider: "LMS",
        orderNumber: "ORD-1001",
        reportStatus: "PARCIAL",
        patient: { nameRaw: "RIVERA, ALEX", dobRaw: "10/04/1992" },
        collectedAt: "2026-05-11T08:00:00",
        reportedAt: "2026-05-11T10:00:00",
        observations: [
          {
            rawName: "Hemoglobina",
            specimen: "blood",
            panel: "Biometria Hematica",
            valueNum: 15.2,
            valueText: "15.2",
            unitRaw: "g/dL",
            refText: "13.5 - 17.5",
            page: 1,
          },
          {
            rawName: "Ferritina",
            specimen: "serum",
            panel: "Hierro",
            valueNum: 110,
            valueText: "110",
            unitRaw: "ng/mL",
            refText: "30 - 400",
            page: 2,
          },
        ],
      },
      opts,
    );
    assert.equal(parcial.status, "ingested");

    // 2. FINAL report for same orderNumber
    const finalDoc = await commitExtractedDocument(
      {
        filename: "order-1001-final.pdf",
        provider: "LMS",
        orderNumber: "ORD-1001",
        reportStatus: "FINAL",
        patient: { nameRaw: "RIVERA, ALEX", dobRaw: "10/04/1992" },
        collectedAt: "2026-05-11T08:00:00",
        reportedAt: "2026-05-11T13:00:00",
        observations: [
          {
            rawName: "Hemoglobina",
            specimen: "blood",
            panel: "Biometria Hematica",
            valueNum: 15.2,
            valueText: "15.2",
            unitRaw: "g/dL",
            refText: "13.5 - 17.5",
            page: 1,
          },
          {
            rawName: "Ferritina",
            specimen: "serum",
            panel: "Hierro",
            valueNum: 110,
            valueText: "110",
            unitRaw: "ng/mL",
            refText: "30 - 400",
            page: 5,
          },
          {
            rawName: "TSH",
            specimen: "serum",
            panel: "Perfil Tiroideo",
            valueNum: 2.1,
            valueText: "2.1",
            unitRaw: "uUI/mL",
            refText: "0.4 - 4.0",
            page: 7,
          },
        ],
      },
      opts,
    );
    assert.equal(finalDoc.status, "ingested");
    assert.ok(
      Array.isArray(finalDoc.supersededDocumentIds) && finalDoc.supersededDocumentIds.includes(parcial.documentId),
      `Expected FINAL to supersede PARCIAL (${parcial.documentId}), got ${JSON.stringify(finalDoc.supersededDocumentIds)}`,
    );

    const hgbTrend = getTrend("blood:hemoglobin", opts);
    assert.equal(hgbTrend.points.length, 1, `Expected 1 active hemoglobin point after superseding, got ${hgbTrend.points.length}`);

    // 3. Companion summary (ordenextrac) for LAPI order
    const lapiMain = await commitExtractedDocument(
      {
        filename: "ordenc_123456.pdf",
        provider: "LAPI",
        orderNumber: "123456",
        reportStatus: "FINAL",
        docType: "lab_report",
        patient: { nameRaw: "RIVERA ALEX Dr.", dobRaw: "10/04/1992" },
        collectedAt: "2025-11-27T08:30:00",
        observations: [
          {
            rawName: "Glucosa",
            specimen: "serum",
            valueNum: 91,
            valueText: "91",
            unitRaw: "mg/dL",
            refText: "70 - 99",
            page: 1,
          },
          {
            rawName: "Triglicéridos",
            specimen: "serum",
            valueNum: 140,
            valueText: "140",
            unitRaw: "mg/dL",
            refText: "< 150",
            page: 1,
          },
        ],
      },
      opts,
    );
    assert.equal(lapiMain.status, "ingested");

    const lapiExtra = await commitExtractedDocument(
      {
        filename: "ordenextrac_123456.pdf",
        provider: "LAPI",
        orderNumber: "123456",
        reportStatus: "SUMMARY",
        docType: "lab_summary",
        patient: { nameRaw: "RIVERA ALEX", dobRaw: "10/04/92" },
        collectedAt: "2025-11-27T08:30:00",
        observations: [
          {
            rawName: "Glucosa",
            specimen: "serum",
            valueNum: 91,
            valueText: "91",
            unitRaw: "mg/dL",
            refText: "70 - 99",
            page: 1,
          },
        ],
        findings: [
          {
            findingType: "risk_assessment",
            title: "Metabolic Syndrome Classification",
            summary: "Low risk — 0/5 metabolic syndrome criteria met",
            collectedAt: "2025-11-27T08:30:00",
            page: 1,
            excerpt: "Riesgo de Síndrome Metabólico: Bajo",
          },
        ],
      },
      opts,
    );
    assert.equal(lapiExtra.status, "ingested");

    const glucoseTrend = getTrend("serum:glucose", opts);
    assert.equal(
      glucoseTrend.points.length,
      1,
      `Expected 1 deduplicated serum:glucose point for LAPI order 123456, got ${glucoseTrend.points.length}`,
    );

    const timeline = getTimeline({}, opts);
    const allFindings = timeline.events.flatMap((e) => e.findings || []);
    assert.ok(
      allFindings.some((f) => /metabolic/i.test(`${f.title} ${f.summary}`)),
      `Expected Metabolic Syndrome finding preserved, got: ${JSON.stringify(allFindings)}`,
    );

    const overview = getOverview(opts);
    assert.ok(overview.counts.activeDocuments >= 2);
  } finally {
    opts.cleanup();
  }
});
