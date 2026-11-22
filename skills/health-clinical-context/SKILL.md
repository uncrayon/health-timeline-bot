---
name: health-clinical-context
description: Always-consult clinical context skill: load regional-guidelines.md, separate lab ranges from national targets, and cite PDF pages and official URLs.
---

# Health Clinical Context (Always Consult)

Consult this skill **before** answering any personal health question, summarizing lab results, interpreting biomarker trends, or reviewing dashboard findings.

## 1. Load Regional Guidelines & Evidence First

1. Call `health_guidelines_read` to load `regional-guidelines.md`, metadata, freshness status, and structured clinical target bands.
   - If no profile or guidelines exist yet, inform the user and follow the `health-onboarding-guidelines` workflow first.
   - If the guidelines are marked stale (>12 months old), note this and offer to run `health_guidelines_sync`.
2. Ground every answer in tool outputs—never guess values from memory:
   - Use `health_overview` for high-level changes, out-of-range flags, documented follow-ups, skipped non-owner documents, review items, and record gaps.
   - Use `health_timeline` for chronological events ordered by **collection date**.
   - Use `health_trend` for longitudinal values of a specific canonical biomarker (with lab reference ranges + regional clinical target overlay + omitted/review reasons).
   - Use `health_evidence` to verify exact verbatim excerpts, page numbers, bounding boxes, and source paths before citing a measurement.

## 2. Mandatory Interpretation Rules

- **Lab Assay Reference Ranges Are Primary**:
  - Laboratory reference intervals depend on the specific analyzer, reagent, and method.
  - Always present each report's own printed value, unit, and lab reference range first.
  - Never overwrite, hide, or conflate a lab's assay reference interval with a national clinical guideline.
- **Regional Official Clinical Targets Are Secondary Overlays**:
  - Present synced national / WHO thresholds side-by-side and clearly labeled as **Regional Official Clinical Target** (e.g., LDL cardiovascular risk tier, HbA1c diagnostic cutoff, screening cadence).
  - Note when a statutory norm (e.g., Mexican NOM) is supplemented by a newer official clinical practice guideline (CENETEC GPC / WHO).
- **Specimen & Method Integrity**:
  - Never compare measurements across different specimens (e.g., `serum:glucose` vs. `urine:glucose`).
  - Never silently compare values across incompatible methods (e.g., Friedewald vs. Sampson calculated LDL, or calculated vs. direct LDL). Explicitly report any `review_items` or omitted points.
- **Chronology & Superseding Reports**:
  - Always reason by **collection date**, never receipt or print date.
  - Note when a `FINAL` report superseded an earlier `PARCIAL` report for the same lab order.
- **Dual-Citation Standard**:
  - Every lab value or finding cited must include its **source document, collection date, page number, and evidence reference**.
  - Every clinical target or screening threshold cited must include its **official source URL, document ID, and publication year** from `regional-guidelines.md`.

## 3. Clinical Safety Guardrails

- **Do not diagnose** medical conditions or declare a patient healthy/unhealthy.
- **Do not prescribe** medications, supplements, or dosing changes.
- **Do not invent follow-up plans**: Only state follow-ups explicitly documented in imported reports. If none are documented, state explicitly: *"No follow-up plan is documented in the imported records."*
- **Do not bypass patient filtering**: If non-owner documents were skipped by the patient gate, treat them as excluded and never include their values in the user's trends.
- Frame all interpretations as informational preparation for discussion with a qualified healthcare professional.
