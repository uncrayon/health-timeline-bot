import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  computeFlag,
  convertValue,
  normalizeUnit,
  parseNumericValue,
  parseReferenceRange,
  resolveAnalyte,
} from "./analytes.mjs";
import { openDb, resolvePagesDir, resolveSourcesDir } from "./db.mjs";
import { evaluatePatientMatch, normalizeDob } from "./patient_gate.mjs";

const execFileAsync = promisify(execFile);
const CORE_DIR = path.dirname(fileURLToPath(import.meta.url));
const EXTRACTOR_PATH = path.join(CORE_DIR, "extract_pdf.py");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);
const SUPPORTED_EXTENSIONS = new Set([".pdf", ...IMAGE_EXTENSIONS]);

export const VLM_EXTRACTION_SCHEMA = {
  description:
    "Inspect the provided lab report image(s) with your vision capability and call health_commit_extracted with strictly valid JSON matching this schema. Preserve the exact printed patient name, collection date (YYYY-MM-DD), units, and lab reference ranges. Never invent values or follow-up plans.",
  schema: {
    type: "object",
    required: ["filename", "provider", "observations"],
    properties: {
      filename: { type: "string" },
      sourcePath: { type: "string" },
      provider: { type: "string", description: "Laboratory or clinic name printed on the report" },
      orderNumber: { type: ["string", "null"] },
      reportStatus: { type: "string", enum: ["FINAL", "PARCIAL", "UNKNOWN"] },
      docType: { type: "string", enum: ["lab_report", "lab_summary", "imaging", "clinical_note", "photo"] },
      patient: {
        type: "object",
        properties: {
          nameRaw: { type: ["string", "null"], description: "Exact patient name as printed on the document" },
          dobRaw: { type: ["string", "null"] },
          sexRaw: { type: ["string", "null"] },
        },
      },
      collectedAt: { type: ["string", "null"], description: "Collection date in YYYY-MM-DD (convert DD/MM/YYYY carefully!)" },
      reportedAt: { type: ["string", "null"], description: "Report/print date in YYYY-MM-DD" },
      observations: {
        type: "array",
        items: {
          type: "object",
          required: ["rawName", "valueText"],
          properties: {
            rawName: { type: "string" },
            specimen: { type: "string", enum: ["serum", "blood", "plasma", "urine", "vitals"] },
            panel: { type: "string" },
            valueNum: { type: ["number", "null"] },
            valueText: { type: "string" },
            unitRaw: { type: ["string", "null"] },
            refText: { type: ["string", "null"] },
            method: { type: ["string", "null"] },
            page: { type: "integer" },
            excerpt: { type: "string" },
          },
        },
      },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["findingType", "title", "summary"],
          properties: {
            findingType: { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
            followupPlan: { type: ["string", "null"] },
            page: { type: "integer" },
            excerpt: { type: "string" },
          },
        },
      },
    },
  },
};

function sha256Buffer(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function makeDocId(payload, sha256) {
  if (payload.documentId) return String(payload.documentId);
  if (payload.isSyntheticDemo) {
    const fn = String(payload.filename || "").toLowerCase();
    if (fn.includes("cedar")) return "cedar";
    if (fn.includes("meridian")) return "meridian";
  }
  return `doc_${sha256.slice(0, 12)}`;
}

function normalizeIsoDate(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const candidate = s.slice(0, 10);
    const parsed = normalizeDob(candidate);
    if (parsed) return parsed;
  }
  return normalizeDob(s);
}

function detectPythonBin(opts = {}) {
  if (opts.pythonBin) return opts.pythonBin;
  if (process.env.HEALTH_TIMELINE_PYTHON) return process.env.HEALTH_TIMELINE_PYTHON;
  const venvCandidates = [
    "/opt/health-timeline-venv/bin/python3",
    path.join(process.env.HOME || "", "health-venv/bin/python3"),
  ];
  for (const cand of venvCandidates) {
    if (cand && fs.existsSync(cand)) return cand;
  }
  return "python3";
}

function readProfileRow(db) {
  const row = db.prepare("SELECT * FROM patient_profile WHERE id = 1").get();
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    aliases: JSON.parse(row.aliases_json || "[]"),
    dob: row.dob,
    biologicalSex: row.biological_sex,
    country: row.country,
    ethnicity: row.ethnicity,
    pregnancyStatus: row.pregnancy_status,
    conditions: JSON.parse(row.conditions_json || "[]"),
    updatedAt: row.updated_at,
  };
}

function stageSourceCopy(sourcePath, docId, filename, opts = {}) {
  if (!sourcePath || !fs.existsSync(sourcePath)) return null;
  const sourcesDir = resolveSourcesDir(opts);
  fs.mkdirSync(sourcesDir, { recursive: true });
  const ext = path.extname(filename || sourcePath).toLowerCase() || ".bin";
  const dest = path.join(sourcesDir, `${docId}${ext}`);
  if (!fs.existsSync(dest)) {
    fs.copyFileSync(sourcePath, dest);
  }
  return dest;
}

export async function commitExtractedDocument(payload, opts = {}) {
  if (!payload || typeof payload !== "object") {
    return {
      status: "error",
      documentId: null,
      filename: "unknown",
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: "Invalid payload object",
      message: "commitExtractedDocument requires a non-null payload object",
    };
  }

  const filename = String(payload.filename || (payload.sourcePath ? path.basename(payload.sourcePath) : "extracted-document.json"));
  const sourcePath = payload.sourcePath ? path.resolve(payload.sourcePath) : null;
  const sha256 =
    payload.sha256 ||
    (sourcePath && fs.existsSync(sourcePath)
      ? sha256File(sourcePath)
      : sha256Buffer(Buffer.from(JSON.stringify({ filename, provider: payload.provider, orderNumber: payload.orderNumber, collectedAt: payload.collectedAt, observations: payload.observations || [] }))));
  const documentId = makeDocId(payload, sha256);
  const provider = String(payload.provider || "Unknown Lab").trim();
  const orderNumber = payload.orderNumber ? String(payload.orderNumber).trim() : null;
  const reportStatus = String(payload.reportStatus || "UNKNOWN").trim().toUpperCase();
  const docType = String(payload.docType || "lab_report").trim();
  const pageCount = Number(payload.pageCount || 1);
  const collectedAt = normalizeIsoDate(payload.collectedAt);
  const reportedAt = normalizeIsoDate(payload.reportedAt);
  const receivedAt = normalizeIsoDate(payload.receivedAt);
  const patient = payload.patient || {};
  const isSyntheticDemo = Boolean(payload.isSyntheticDemo);
  const nowIso = new Date().toISOString();

  const db = openDb(opts);
  try {
    // 1. Idempotency check by SHA-256
    const existing = db.prepare("SELECT id, provider, order_number, report_status, collected_at FROM documents WHERE sha256 = ?").get(sha256);
    if (existing) {
      const obsCount = db.prepare("SELECT COUNT(*) AS c FROM observations WHERE document_id = ?").get(existing.id).c;
      const findCount = db.prepare("SELECT COUNT(*) AS c FROM findings WHERE document_id = ?").get(existing.id).c;
      return {
        status: "duplicate",
        documentId: existing.id,
        filename,
        provider: existing.provider,
        orderNumber: existing.order_number,
        reportStatus: existing.report_status,
        collectedAt: existing.collected_at,
        observationsCount: obsCount,
        findingsCount: findCount,
        reviewItemsCount: 0,
        supersededDocumentIds: [],
        skipReason: null,
        message: "Document already imported (matching SHA-256)",
      };
    }

    // 2. Patient identity gate (strict fail-closed before ANY observation write!)
    const profile = readProfileRow(db);
    const gate = evaluatePatientMatch(
      {
        nameRaw: patient.nameRaw || null,
        dobRaw: patient.dobRaw || null,
        sexRaw: patient.sexRaw || null,
        isSyntheticDemo,
      },
      profile,
      opts
    );

    if (!gate.matched) {
      const skipId = `skip_${sha256.slice(0, 12)}`;
      db.prepare(
        `INSERT OR REPLACE INTO skipped_documents
         (id, filename, source_path, sha256, provider, patient_name_raw, reason, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(skipId, filename, sourcePath, sha256, provider, patient.nameRaw || null, gate.reason, nowIso);

      return {
        status: "skipped",
        documentId: null,
        filename,
        provider,
        orderNumber,
        reportStatus,
        collectedAt,
        observationsCount: 0,
        findingsCount: 0,
        reviewItemsCount: 0,
        supersededDocumentIds: [],
        skipReason: gate.reason,
        message: `Rejected by patient identity gate: ${gate.reason}`,
      };
    }

    // Copy source file safely into dataDir/sources for evidence serving
    const stagedSourcePath = stageSourceCopy(sourcePath, documentId, filename, opts);

    // If source is an image (photo), also copy to pages/<docId>-1.png or keep reference so evidence viewer can render it
    if (stagedSourcePath && IMAGE_EXTENSIONS.has(path.extname(stagedSourcePath).toLowerCase())) {
      const pagesDir = resolvePagesDir(opts);
      fs.mkdirSync(pagesDir, { recursive: true });
      const ext = path.extname(stagedSourcePath).toLowerCase();
      if (ext === ".png") {
        const targetPng = path.join(pagesDir, `${documentId}-1.png`);
        if (!fs.existsSync(targetPng)) fs.copyFileSync(stagedSourcePath, targetPng);
      }
    }

    // 3. Atomic transaction: insert document, supersede/deduplicate, normalize & insert observations/findings/review_items
    const supersededDocumentIds = [];
    let insertedObservations = 0;
    let insertedFindings = 0;
    let insertedReviews = 0;

    db.exec("BEGIN IMMEDIATE");
    try {
      // Check existing sibling docs with same (provider, order_number)
      let newDocSupersededBy = null;
      let overlappingKeysToDeactivateOnNew = new Set();
      let existingSummaryDocs = [];
      let existingPartialsToSupersede = [];

      if (orderNumber) {
        const siblings = db
          .prepare(
            "SELECT id, doc_type, report_status, superseded_by FROM documents WHERE provider = ? AND order_number = ?"
          )
          .all(provider, orderNumber);

        for (const sib of siblings) {
          if (docType === "lab_report" && sib.doc_type === "lab_report") {
            if (reportStatus === "FINAL" && sib.report_status !== "FINAL") {
              existingPartialsToSupersede.push(sib.id);
            } else if (reportStatus === "PARCIAL" && sib.report_status === "FINAL") {
              newDocSupersededBy = sib.id;
            }
          } else if (docType === "lab_summary" && sib.doc_type === "lab_report") {
            // Companion summary (e.g. LAPI ordenextrac): deduplicate observations already in main report
            const sibKeys = db
              .prepare("SELECT canonical_key, specimen FROM observations WHERE document_id = ? AND is_active = 1")
              .all(sib.id);
            for (const row of sibKeys) {
              overlappingKeysToDeactivateOnNew.add(`${row.canonical_key}|${row.specimen}`);
            }
          } else if (docType === "lab_report" && sib.doc_type === "lab_summary") {
            existingSummaryDocs.push(sib.id);
          }
        }
      }

      const metaJson = JSON.stringify({
        ...(payload.meta || {}),
        patientGate: gate,
        stagedSourcePath,
        pagesRendered: payload.pagesRendered || [],
      });

      db.prepare(
        `INSERT INTO documents
         (id, filename, source_path, sha256, provider, order_number, report_status,
          patient_name_raw, patient_dob_raw, patient_sex_raw, collected_at, reported_at, received_at,
          doc_type, page_count, superseded_by, meta_json, imported_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        documentId,
        filename,
        stagedSourcePath || sourcePath,
        sha256,
        provider,
        orderNumber,
        reportStatus,
        patient.nameRaw || null,
        patient.dobRaw || null,
        patient.sexRaw || null,
        collectedAt,
        reportedAt,
        receivedAt,
        docType,
        pageCount,
        newDocSupersededBy,
        metaJson,
        nowIso
      );

      // Supersede older PARCIAL reports when FINAL arrives
      for (const partialId of existingPartialsToSupersede) {
        db.prepare("UPDATE documents SET superseded_by = ? WHERE id = ?").run(documentId, partialId);
        db.prepare("UPDATE observations SET is_active = 0 WHERE document_id = ?").run(partialId);
        supersededDocumentIds.push(partialId);
      }

      const insertObsStmt = db.prepare(
        `INSERT INTO observations
         (id, document_id, canonical_key, specimen, display_name, panel,
          value_num, value_text, unit_raw, normalized_value, normalized_unit,
          ref_low, ref_high, ref_text, flag, method, collected_at,
          page, line_index, bbox_json, excerpt, is_active, meta_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const insertReviewStmt = db.prepare(
        `INSERT INTO review_items
         (id, document_id, observation_id, code, severity, message, details_json, resolved)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
      );

      const newActiveKeys = new Set();
      const rawObservations = Array.isArray(payload.observations) ? payload.observations : [];

      for (let idx = 0; idx < rawObservations.length; idx++) {
        const obs = rawObservations[idx];
        if (!obs || (!obs.rawName && !obs.canonicalKey)) continue;

        const resolved = obs.canonicalKey
          ? resolveAnalyte(obs.rawName || obs.canonicalKey, obs.specimen || obs.canonicalKey.split(":")[0], obs.unitRaw, obs.panel, obs.method)
          : resolveAnalyte(obs.rawName, obs.specimen || "serum", obs.unitRaw, obs.panel, obs.method);

        const canonicalKey = obs.canonicalKey || resolved.canonicalKey;
        const specimen = obs.specimen && ["serum", "blood", "plasma", "urine", "vitals"].includes(obs.specimen)
          ? obs.specimen
          : resolved.specimen;
        const displayName = resolved.isKnown ? resolved.displayName : (obs.rawName || resolved.displayName);
        const panel = resolved.isKnown ? resolved.panel : (obs.panel || resolved.panel);

        const valueText = String(obs.valueText ?? obs.valueNum ?? "").trim();
        const parsedVal = parseNumericValue(valueText);
        const valueNum = obs.valueNum !== undefined && obs.valueNum !== null && Number.isFinite(Number(obs.valueNum))
          ? Number(obs.valueNum)
          : parsedVal.valueNum;

        const unitRaw = obs.unitRaw ? String(obs.unitRaw).trim() : null;
        const conv = convertValue(canonicalKey, valueNum, unitRaw);

        const refText = obs.refText ? String(obs.refText).trim() : null;
        const parsedRef = parseReferenceRange(refText);
        const refLow = obs.refLow !== undefined && obs.refLow !== null ? Number(obs.refLow) : parsedRef.refLow;
        const refHigh = obs.refHigh !== undefined && obs.refHigh !== null ? Number(obs.refHigh) : parsedRef.refHigh;

        const flag = computeFlag({
          valueNum,
          valueText,
          refLow,
          refHigh,
          refText,
          inclusiveLow: parsedRef.inclusiveLow,
          inclusiveHigh: parsedRef.inclusiveHigh,
          comparator: parsedVal.comparator,
        });

        const obsCollectedAt = normalizeIsoDate(obs.collectedAt) || collectedAt;
        const keySpec = `${canonicalKey}|${specimen}`;
        const isActive =
          newDocSupersededBy !== null
            ? 0
            : overlappingKeysToDeactivateOnNew.has(keySpec)
              ? 0
              : 1;

        if (isActive === 1) newActiveKeys.add(keySpec);

        const obsId = `${documentId}_obs_${String(idx + 1).padStart(3, "0")}`;
        const obsMeta = {
          ...(obs.meta || {}),
          rawName: obs.rawName || displayName,
          normalizedUnitRaw: normalizeUnit(unitRaw),
          conversionFactor: conv.conversionFactor,
          comparable: conv.comparable,
          conversionReason: conv.reason,
          comparator: parsedVal.comparator,
        };

        insertObsStmt.run(
          obsId,
          documentId,
          canonicalKey,
          specimen,
          displayName,
          panel,
          valueNum,
          valueText,
          unitRaw,
          conv.normalizedValue,
          conv.normalizedUnit,
          refLow,
          refHigh,
          refText,
          flag,
          obs.method || null,
          obsCollectedAt,
          obs.page ?? null,
          obs.lineIndex ?? null,
          obs.bbox ? JSON.stringify(obs.bbox) : null,
          obs.excerpt || null,
          isActive,
          JSON.stringify(obsMeta)
        );
        insertedObservations += 1;

        // Add review item if numeric value could not be unit-normalized for trending
        if (isActive === 1 && valueNum !== null && !conv.comparable && conv.reason) {
          insertReviewStmt.run(
            `rev_${obsId}_unit`,
            documentId,
            obsId,
            "unconverted_unit",
            "warning",
            `${displayName}: ${conv.reason}`,
            JSON.stringify({ unitRaw, canonicalKey })
          );
          insertedReviews += 1;
        }
      }

      // If main lab_report arrived AFTER companion lab_summary (ordenextrac), deactivate overlapping summary observations
      for (const summaryId of existingSummaryDocs) {
        const sumObs = db
          .prepare("SELECT id, canonical_key, specimen FROM observations WHERE document_id = ? AND is_active = 1")
          .all(summaryId);
        for (const row of sumObs) {
          if (newActiveKeys.has(`${row.canonical_key}|${row.specimen}`)) {
            db.prepare("UPDATE observations SET is_active = 0 WHERE id = ?").run(row.id);
          }
        }
      }

      // Insert findings (metabolic syndrome summary, imaging reports, documented follow-ups)
      const insertFindingStmt = db.prepare(
        `INSERT INTO findings
         (id, document_id, finding_type, title, summary, followup_plan, collected_at, page, bbox_json, excerpt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const rawFindings = Array.isArray(payload.findings) ? payload.findings : [];
      for (let idx = 0; idx < rawFindings.length; idx++) {
        const f = rawFindings[idx];
        if (!f || !f.title || !f.summary) continue;
        const fid = `${documentId}_find_${String(idx + 1).padStart(3, "0")}`;
        insertFindingStmt.run(
          fid,
          documentId,
          String(f.findingType || "clinical_finding"),
          String(f.title),
          String(f.summary),
          f.followupPlan ? String(f.followupPlan) : null,
          normalizeIsoDate(f.collectedAt) || collectedAt,
          f.page ?? null,
          f.bbox ? JSON.stringify(f.bbox) : null,
          f.excerpt || null
        );
        insertedFindings += 1;
      }

      // Insert review items (from extractor + missing collection date + no-profile warning)
      const rawReviews = Array.isArray(payload.reviewItems) ? [...payload.reviewItems] : [];
      if (!collectedAt) {
        rawReviews.push({
          code: "missing_collection_date",
          severity: "warning",
          message: `Collection date missing or unreadable in ${filename}`,
          details: { filename },
        });
      }
      if (gate.method === "no_profile_warning") {
        rawReviews.push({
          code: "no_patient_profile",
          severity: "info",
          message: "Imported without patient identity profile configured; run health_onboarding to enable strict cross-patient filtering.",
          details: { filename },
        });
      }
      for (let idx = 0; idx < rawReviews.length; idx++) {
        const r = rawReviews[idx];
        if (!r || !r.message) continue;
        const rid = `rev_${documentId}_${String(idx + 1).padStart(3, "0")}`;
        insertReviewStmt.run(
          rid,
          documentId,
          r.observationId || null,
          String(r.code || "review_needed"),
          String(r.severity || "warning"),
          String(r.message),
          JSON.stringify(r.details || {})
        );
        insertedReviews += 1;
      }

      // Insert optional delivery metadata (synthetic fixtures / email delivery receipt dates)
      const deliveries = Array.isArray(payload.deliveries) ? payload.deliveries : [];
      const insertDelStmt = db.prepare(
        "INSERT OR IGNORE INTO deliveries (id, document_id, received, channel) VALUES (?, ?, ?, ?)"
      );
      for (let idx = 0; idx < deliveries.length; idx++) {
        const d = deliveries[idx];
        if (!d || !d.received) continue;
        insertDelStmt.run(
          d.id || `del_${documentId}_${idx + 1}`,
          documentId,
          String(d.received),
          String(d.channel || "Imported file")
        );
      }

      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }

    return {
      status: "ingested",
      documentId,
      filename,
      provider,
      orderNumber,
      reportStatus,
      collectedAt,
      observationsCount: insertedObservations,
      findingsCount: insertedFindings,
      reviewItemsCount: insertedReviews,
      supersededDocumentIds,
      skipReason: null,
      message: `Ingested ${insertedObservations} observations and ${insertedFindings} findings from ${filename}`,
    };
  } finally {
    db.close();
  }
}

export async function ingestFile(filePath, opts = {}) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
    return {
      status: "error",
      documentId: null,
      filename: path.basename(absPath),
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      message: `File not found: ${absPath}`,
    };
  }

  const filename = path.basename(absPath);
  const ext = path.extname(filename).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return {
      status: "error",
      documentId: null,
      filename,
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      message: `Unsupported file extension "${ext}". Supported: .pdf, .jpg, .jpeg, .png, .webp, .heic`,
    };
  }

  const sha256 = sha256File(absPath);
  const fileId = `doc_${sha256.slice(0, 12)}`;

  // Image / photo path: return structured VLM handoff without local OCR!
  if (IMAGE_EXTENSIONS.has(ext)) {
    const stagedPath = stageSourceCopy(absPath, fileId, filename, opts) || absPath;
    // Also record a pending review item if requested or simply return VLM handoff payload
    return {
      status: "needs_vlm_extraction",
      documentId: null,
      fileId,
      filename,
      sourcePath: stagedPath,
      sha256,
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      imagePaths: [stagedPath],
      schemaHint: VLM_EXTRACTION_SCHEMA,
      message: `Photo "${filename}" requires VLM vision extraction. Inspect imagePaths[0] and commit structured JSON via commitExtractedDocument / health_commit_extracted.`,
    };
  }

  // PDF path: run deterministic Python extractor
  const pagesDir = resolvePagesDir(opts);
  fs.mkdirSync(pagesDir, { recursive: true });
  const fnLower = filename.toLowerCase();
  const docPrefix = fnLower.includes("cedar") ? "cedar" : fnLower.includes("meridian") ? "meridian" : fileId;
  const pythonBin = detectPythonBin(opts);

  let stdout;
  try {
    const res = await execFileAsync(
      pythonBin,
      [EXTRACTOR_PATH, absPath, "--pages-dir", pagesDir, "--doc-id", docPrefix],
      { maxBuffer: 20 * 1024 * 1024, timeout: 60000 }
    );
    stdout = res.stdout;
  } catch (err) {
    return {
      status: "error",
      documentId: null,
      filename,
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      message: `PDF extraction failed: ${err?.stderr || err?.message || String(err)}`,
    };
  }

  let extracted;
  try {
    extracted = JSON.parse(stdout);
  } catch (err) {
    return {
      status: "error",
      documentId: null,
      filename,
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      message: `Malformed JSON from PDF extractor: ${err.message}`,
    };
  }

  if (extracted.status === "error") {
    return {
      status: "error",
      documentId: null,
      filename,
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      message: extracted.error || "PDF extraction failed",
    };
  }

  if (extracted.status === "needs_vlm_extraction") {
    const imagePaths = (extracted.pagesRendered || []).map(p => p.path).filter(Boolean);
    return {
      status: "needs_vlm_extraction",
      documentId: null,
      fileId,
      filename,
      sourcePath: absPath,
      sha256,
      provider: null,
      orderNumber: null,
      reportStatus: null,
      collectedAt: null,
      observationsCount: 0,
      findingsCount: 0,
      reviewItemsCount: 0,
      supersededDocumentIds: [],
      skipReason: null,
      imagePaths: imagePaths.length ? imagePaths : [absPath],
      schemaHint: VLM_EXTRACTION_SCHEMA,
      message: extracted.reason || `Scanned PDF "${filename}" needs VLM vision extraction.`,
    };
  }

  // Attach synthetic fixture delivery metadata if importing from repo fixtures/manifest.json
  if (extracted.isSyntheticDemo && !extracted.deliveries) {
    const manifestPath = path.join(path.dirname(absPath), "manifest.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        const matchDoc = (manifest.documents || []).find(d => d.file === filename);
        if (matchDoc) {
          extracted.documentId = matchDoc.id;
          extracted.deliveries = (manifest.deliveries || [])
            .filter(d => d.document === matchDoc.id)
            .map(d => ({ id: d.id, received: d.date, channel: d.channel }));
          if (extracted.deliveries.length) {
            extracted.receivedAt = extracted.deliveries[0].received;
          }
        }
      } catch {
        // Ignore malformed optional manifest
      }
    }
  }

  return commitExtractedDocument(extracted, opts);
}

export async function ingestDirectory(dirPath, opts = {}) {
  const absDir = path.resolve(dirPath);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    throw new Error(`Directory not found: ${absDir}`);
  }
  const entries = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter(ent => ent.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(ent.name).toLowerCase()))
    .map(ent => path.join(absDir, ent.name))
    .sort();

  const results = [];
  let ingested = 0;
  let skipped = 0;
  let duplicates = 0;
  let needsVlm = 0;
  let errors = 0;

  for (const file of entries) {
    const res = await ingestFile(file, opts);
    results.push(res);
    if (res.status === "ingested") ingested += 1;
    else if (res.status === "skipped") skipped += 1;
    else if (res.status === "duplicate") duplicates += 1;
    else if (res.status === "needs_vlm_extraction") needsVlm += 1;
    else errors += 1;
  }

  return {
    directory: absDir,
    processed: entries.length,
    ingested,
    skipped,
    duplicates,
    needsVlm,
    errors,
    results,
  };
}
