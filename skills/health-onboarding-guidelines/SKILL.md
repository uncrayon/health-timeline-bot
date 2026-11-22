---
name: health-onboarding-guidelines
description: Onboard the patient profile (name, lab aliases, DOB, sex, country, pregnancy, ancestry) and sync official regional clinical guidelines.
---

# Health Onboarding & Official Regional Guidelines Sync

Use this skill during first-time setup, whenever the user asks to configure or update their health profile, or when `health_guidelines_read` reports that no patient profile or `regional-guidelines.md` exists (or that guidelines are stale).

## 1. Collect Patient Profile Interactively

Ask concise, clear questions (skip anything the user has already provided):

1. **Full legal name & lab report aliases** *(required for safety)*:
   - Ask for their full name plus any formatting variants labs print on PDFs (e.g., `SURNAMES, FIRST MIDDLE`, unaccented spellings, omitted middle name).
   - Explain clearly that these are used by the deterministic patient-identity gate to reject other people's lab reports and prevent cross-patient contamination.
2. **Date of birth** *(recommended)*:
   - Used for patient-identity corroboration and age-stratified clinical reference thresholds.
3. **Biological sex** (`male`, `female`, `intersex`, or `unspecified`):
   - Needed for sex-stratified clinical targets (hemoglobin, ferritin, HDL, uric acid, creatinine/eGFR).
4. **Country / region of residence** (ISO-3166 code such as `MX`, `US`, `DE`, `GB`, `CA`, `ES`, etc.):
   - Selects the official national health ministry / public-health guideline authorities.
5. **Pregnancy / lactation status** (`none`, `pregnant`, `postpartum`, `lactating`, `unknown`):
   - Critical because reference targets for hemoglobin, glucose, lipids, and thyroid shift significantly.
6. **Optional ancestry / ethnicity**:
   - Explicitly explain this is optional and used **only** where officially endorsed by public-health guidelines (e.g., lower Asian BMI screening cutoffs), never for deprecated race-adjusted eGFR.
7. **Optional known conditions** (e.g., diabetes, hypertension, dyslipidemia, CKD, thyroid disease):
   - Helps display the relevant risk-stratified clinical target tier alongside lab ranges.

## 2. Save Profile

Call `health_onboarding` with `action: "set"` and the collected fields:
- `full_name`
- `aliases` (array of lab name variants)
- `dob` (`YYYY-MM-DD`)
- `biological_sex`
- `country` (2-letter ISO code)
- `ethnicity` (optional)
- `pregnancy_status`
- `conditions` (array of strings, optional)

Confirm back what was saved without echoing unnecessary sensitive fields in shared channels.

## 3. Live-Sync Official Regional Guidelines

Immediately call `health_guidelines_sync` (passing the user's country/profile if needed; by default it reads the saved profile).

- The tool enforces a **strict official-domain allowlist in code** (national health ministries such as `gob.mx`, `dof.gob.mx`, `imss.gob.mx`, `cdc.gov`, `nih.gov`, `uspreventiveservicestaskforce.org`, `awmf.org`, `rki.de`, `who.int`, etc.) and rejects commercial or unofficial sites.
- It fetches live official pages where reachable and writes a cited local `regional-guidelines.md` file with YAML frontmatter, source URLs, document IDs, publication years, fetch timestamp, and structured target bands.

## 4. Summarize Sync Result

Report briefly to the user:
- Country and profile stratification applied.
- Which official sources were fetched live vs. which fell back to verified official snapshots (`source_mode`), including exact URLs and document IDs.
- Reminder: each laboratory's own printed assay reference range remains primary; synced regional guidelines provide educational clinical target overlays for discussion with a clinician.
