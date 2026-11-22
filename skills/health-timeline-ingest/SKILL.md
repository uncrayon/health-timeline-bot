---
name: health-timeline-ingest
description: Ingest lab PDFs and photos into Health Timeline, inspect VLM-needed images with vision, and commit strict JSON through the patient gate.
---

# Health Timeline Document & Photo Ingestion

Use this skill whenever the user wants to import lab PDFs, diagnostic reports, or photos of printed lab sheets into their Health Timeline.

## 1. Verify Patient Profile First

Before ingesting real personal records, call `health_onboarding` (`action: "get"`) to confirm the patient's full name, lab aliases, and optional DOB are configured.
- If no profile exists yet, run the `health-onboarding-guidelines` skill first so the deterministic patient-identity gate can protect the timeline from other people's records.

## 2. Run Deterministic Ingestion

Call `health_import` with either:
- `path`: path to a single PDF/image file or an approved inbox directory, OR
- `documentId`: a selected document ID already staged in the inbox.

Inspect every section of the returned result:
- **Ingested documents & observations**: count of newly committed records and analytes.
- **Superseded / deduplicated**: e.g., `FINAL` report superseding `PARCIAL` for the same `(provider, order_number)`, or companion summary sheets deduplicating overlapping values while preserving unique findings.
- **Skipped non-owner documents**: documents rejected by the patient-identity gate (0 observations written). Report these transparently to the user.
- **Review items**: method shifts, missing dates, ambiguous units/ranges, or partial reports.
- **`needs_vlm_extraction`**: photos (`.jpg`, `.jpeg`, `.png`, `.webp`, `.heic`) or scanned/image-only PDFs that require your own multimodal VLM vision to read.

## 3. VLM Vision Extraction for Photos & Scanned PDFs

When `needs_vlm_extraction` is non-empty, process each item carefully:

1. Open and visually inspect every image listed in `item.imagePaths` using your built-in vision capability.
2. Read the `item.schemaHint` returned by `health_import` and extract strictly formatted JSON matching it:
   - `filename` and `sourcePath`: preserve exact values from `item`.
   - `patient`: `{ nameRaw, dobRaw, sexRaw }` — transcribe `nameRaw` **verbatim** exactly as printed on the page (never rewrite it to match the user's profile!). Use `null` for fields not printed.
   - `provider`, `orderNumber`, `reportStatus` (`FINAL`, `PARCIAL`, or `UNKNOWN`), `docType` (`lab_report`, `imaging`, `clinical_note`, etc.).
   - `collectedAt` (ISO `YYYY-MM-DD`, converting `DD/MM/YYYY` carefully!), `reportedAt` (ISO `YYYY-MM-DD` or `null`).
   - `observations[]`: every printed lab measurement with `rawName`, `specimen` (`serum`, `blood`, `urine`, `plasma`, `stool`, etc.), `panel`, `valueText` (exact printed string), `valueNum` (number or `null`), `unitRaw`, `refText`, `method` (if printed), `page` (1-based integer), and `excerpt` (short verbatim line).
   - `findings[]`: verbatim narrative impressions, metabolic summaries, or documented follow-up plans (`findingType`, `title`, `summary`, `followupPlan`, `page`, `excerpt`). Leave `followupPlan` `null` if none is printed.
3. **Never hallucinate**: If a digit, unit, or date is illegible or cut off, leave it `null` and note the ambiguity rather than guessing.
4. Call `health_commit_extracted` with the extracted JSON payload.

## 4. Respect the Deterministic Patient Gate

- `health_commit_extracted` runs the exact same deterministic patient-identity gate, analyte ontology, unit normalizer, and deduplication transaction as the PDF pipeline.
- If `health_commit_extracted` returns a **skipped / patient mismatch** result, accept it immediately and inform the user that the photo/scan belonged to a different patient and was safely excluded. **Never** alter `patient_name_raw` to force an import.
- After ingestion finishes, summarize the net changes clearly and link to the evidence pages.
