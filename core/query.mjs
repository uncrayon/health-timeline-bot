import fs from "node:fs";
import path from "node:path";

import { getAnalyteDefinition } from "./analytes.mjs";
import { dbExists, isLegacySchema, openDb, resolveDataDir, resolvePagesDir, resolveSourcesDir } from "./db.mjs";
import { readRegionalGuidelines } from "./guidelines.mjs";
import { normalizeDob } from "./patient_gate.mjs";

function parseJsonSafe(raw, fallback) {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function mapProfileRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: row.full_name,
    aliases: parseJsonSafe(row.aliases_json, []),
    dob: row.dob || null,
    biologicalSex: row.biological_sex || null,
    country: row.country || "US",
    ethnicity: row.ethnicity || null,
    pregnancyStatus: row.pregnancy_status || null,
    conditions: parseJsonSafe(row.conditions_json, []),
    updatedAt: row.updated_at,
  };
}

function resolvePageImagePath(documentId, page, opts = {}) {
  if (!documentId || !page) return null;
  const pagesDir = resolvePagesDir(opts);
  const primary = path.join(pagesDir, `${documentId}-${page}.png`);
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(resolveDataDir(opts), `${documentId}-${page}.png`);
  if (fs.existsSync(legacy)) return legacy;
  // Photo uploads stored in sources/
  const sourcesDir = resolveSourcesDir(opts);
  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    const img = path.join(sourcesDir, `${documentId}${ext}`);
    if (fs.existsSync(img)) return img;
  }
  return primary;
}

function resolveDocSourcePath(docRow, opts = {}) {
  if (!docRow) return null;
  const sourcesDir = resolveSourcesDir(opts);
  if (docRow.filename) {
    const ext = path.extname(docRow.filename).toLowerCase();
    const staged = path.join(sourcesDir, `${docRow.id}${ext}`);
    if (fs.existsSync(staged)) return staged;
    const legacy = path.join(resolveDataDir(opts), docRow.filename);
    if (fs.existsSync(legacy)) return legacy;
  }
  if (docRow.source_path && fs.existsSync(docRow.source_path)) {
    return docRow.source_path;
  }
  return null;
}

export function getProfile(opts = {}) {
  if (!dbExists(opts)) return null;
  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) return null;
    const row = db.prepare("SELECT * FROM patient_profile WHERE id = 1").get();
    return mapProfileRow(row);
  } finally {
    db.close();
  }
}

export function saveProfile(input = {}, opts = {}) {
  const fullName = String(input.fullName ?? input.full_name ?? "").trim();
  if (!fullName) {
    throw new Error("Patient profile requires fullName / full_name");
  }
  const aliases = Array.isArray(input.aliases)
    ? input.aliases.map(a => String(a).trim()).filter(Boolean)
    : typeof input.aliases === "string"
      ? input.aliases.split(/[,;]/).map(s => s.trim()).filter(Boolean)
      : [];
  const dob = input.dob ? (normalizeDob(String(input.dob)) || String(input.dob).trim()) : null;
  const biologicalSex = (input.biologicalSex ?? input.biological_sex ?? null)
    ? String(input.biologicalSex ?? input.biological_sex).trim()
    : null;
  const country = String(input.country || "US").trim().toUpperCase();
  const ethnicity = input.ethnicity ? String(input.ethnicity).trim() : null;
  const pregnancyStatus = (input.pregnancyStatus ?? input.pregnancy_status ?? null)
    ? String(input.pregnancyStatus ?? input.pregnancy_status).trim()
    : null;
  const conditions = Array.isArray(input.conditions)
    ? input.conditions.map(c => String(c).trim()).filter(Boolean)
    : [];
  const updatedAt = new Date().toISOString();

  const db = openDb(opts);
  try {
    db.prepare(
      `INSERT INTO patient_profile
       (id, full_name, aliases_json, dob, biological_sex, country, ethnicity, pregnancy_status, conditions_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         full_name = excluded.full_name,
         aliases_json = excluded.aliases_json,
         dob = excluded.dob,
         biological_sex = excluded.biological_sex,
         country = excluded.country,
         ethnicity = excluded.ethnicity,
         pregnancy_status = excluded.pregnancy_status,
         conditions_json = excluded.conditions_json,
         updated_at = excluded.updated_at`
    ).run(
      fullName,
      JSON.stringify(aliases),
      dob,
      biologicalSex,
      country,
      ethnicity,
      pregnancyStatus,
      JSON.stringify(conditions),
      updatedAt
    );
    return mapProfileRow(db.prepare("SELECT * FROM patient_profile WHERE id = 1").get());
  } finally {
    db.close();
  }
}

export function listBiomarkers(opts = {}) {
  if (!dbExists(opts)) {
    return { panels: [], totalBiomarkers: 0, totalActiveObservations: 0 };
  }
  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) {
      return { panels: [], totalBiomarkers: 0, totalActiveObservations: 0 };
    }
    const rows = db
      .prepare(
        `SELECT o.canonical_key, o.display_name, o.specimen, o.panel,
                o.value_num, o.value_text, o.unit_raw, o.normalized_value, o.normalized_unit,
                o.ref_text, o.flag, o.collected_at, d.provider
         FROM observations o
         JOIN documents d ON d.id = o.document_id
         WHERE o.is_active = 1
         ORDER BY o.collected_at IS NULL, o.collected_at ASC, o.id ASC`
      )
      .all();

    const byKey = new Map();
    for (const r of rows) {
      let item = byKey.get(r.canonical_key);
      if (!item) {
        item = {
          canonicalKey: r.canonical_key,
          displayName: r.display_name,
          specimen: r.specimen,
          panel: r.panel,
          count: 0,
          numericCount: 0,
          latestValue: null,
          latestValueText: null,
          latestUnit: null,
          latestNormalizedValue: null,
          latestNormalizedUnit: null,
          latestFlag: "unknown",
          latestCollectedAt: null,
          latestRefText: null,
          providers: new Set(),
        };
        byKey.set(r.canonical_key, item);
      }
      item.count += 1;
      if (r.normalized_value !== null) item.numericCount += 1;
      item.latestValue = r.value_num;
      item.latestValueText = r.value_text;
      item.latestUnit = r.unit_raw;
      item.latestNormalizedValue = r.normalized_value;
      item.latestNormalizedUnit = r.normalized_unit;
      item.latestFlag = r.flag;
      item.latestCollectedAt = r.collected_at;
      item.latestRefText = r.ref_text;
      item.providers.add(r.provider);
    }

    const panelMap = new Map();
    for (const item of byKey.values()) {
      const normalized = { ...item, providers: [...item.providers] };
      if (!panelMap.has(item.panel)) panelMap.set(item.panel, []);
      panelMap.get(item.panel).push(normalized);
    }

    const panelOrder = [
      "Lipids",
      "Glucose & Metabolic",
      "Complete Blood Count",
      "Liver & Pancreas",
      "Kidney & Electrolytes",
      "Thyroid",
      "Iron & Vitamins",
      "Inflammation",
      "Endocrine",
      "Vitals & Anthropometrics",
      "Urinalysis",
      "Serology",
    ];
    const panels = [...panelMap.entries()]
      .sort(([a], [b]) => {
        const ia = panelOrder.indexOf(a);
        const ib = panelOrder.indexOf(b);
        if (ia !== -1 && ib !== -1) return ia - ib;
        if (ia !== -1) return -1;
        if (ib !== -1) return 1;
        return a.localeCompare(b);
      })
      .map(([panel, biomarkers]) => ({
        panel,
        biomarkers: biomarkers.sort((a, b) => b.count - a.count || a.displayName.localeCompare(b.displayName)),
      }));

    return {
      panels,
      totalBiomarkers: byKey.size,
      totalActiveObservations: rows.length,
    };
  } finally {
    db.close();
  }
}

export function getTrend(canonicalKey, opts = {}) {
  const key = String(canonicalKey || "").trim();
  const def = getAnalyteDefinition(key);
  const guidelines = readRegionalGuidelines(opts);
  const regionalTarget = guidelines.targetsByKey?.[key] || null;
  const guidelineStatus = {
    synced: guidelines.exists,
    country: guidelines.frontmatter?.country || null,
    fetchedAt: guidelines.frontmatter?.fetched_at || null,
    stale: guidelines.stale,
  };

  const empty = {
    canonicalKey: key,
    displayName: def?.displayName || key,
    specimen: def?.specimen || (key.includes(":") ? key.split(":")[0] : "serum"),
    panel: def?.panel || "Other Labs",
    normalizedUnit: def?.defaultUnit || null,
    points: [],
    omitted: [],
    change: { absolute: null, percent: null, direction: null, fromDate: null, toDate: null },
    regionalTarget,
    guidelineStatus,
    reviewItems: [],
  };

  if (!key || !dbExists(opts)) return empty;

  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) return empty;
    const rows = db
      .prepare(
        `SELECT o.*, d.provider, d.order_number, d.report_status, d.reported_at, d.filename
         FROM observations o
         JOIN documents d ON d.id = o.document_id
         WHERE o.canonical_key = ? AND o.is_active = 1
         ORDER BY o.collected_at IS NULL, o.collected_at ASC, o.id ASC`
      )
      .all(key);

    if (!rows.length) return empty;

    const points = [];
    const omitted = [];
    const obsIds = rows.map(r => r.id);

    for (const r of rows) {
      const meta = parseJsonSafe(r.meta_json, {});
      const bbox = parseJsonSafe(r.bbox_json, null);
      const evidencePath = `/?obs=${r.id}#evidence`;
      const imageUrl = r.page ? `/evidence/${r.document_id}/page/${r.page}.png` : null;
      const sourceUrl = `/evidence/${r.document_id}/source`;

      if (r.normalized_value === null || !r.collected_at) {
        const reason = !r.collected_at
          ? "Missing collection date"
          : meta.conversionReason || "Non-numeric or non-comparable value";
        omitted.push({
          observationId: r.id,
          documentId: r.document_id,
          provider: r.provider,
          collectedAt: r.collected_at,
          valueText: r.value_text,
          unitRaw: r.unit_raw,
          refText: r.ref_text,
          flag: r.flag,
          reason,
          evidencePath,
          imageUrl,
          sourceUrl,
        });
        continue;
      }

      points.push({
        observationId: r.id,
        documentId: r.document_id,
        filename: r.filename,
        provider: r.provider,
        orderNumber: r.order_number,
        reportStatus: r.report_status,
        collectedAt: r.collected_at,
        reportedAt: r.reported_at,
        valueNum: r.value_num,
        valueText: r.value_text,
        unitRaw: r.unit_raw,
        normalizedValue: r.normalized_value,
        normalizedUnit: r.normalized_unit,
        conversionFactor: meta.conversionFactor ?? 1,
        refLow: r.ref_low,
        refHigh: r.ref_high,
        refText: r.ref_text,
        flag: r.flag,
        method: r.method,
        page: r.page,
        lineIndex: r.line_index,
        bbox,
        excerpt: r.excerpt,
        evidencePath,
        imageUrl,
        sourceUrl,
      });
    }

    let change = { absolute: null, percent: null, direction: null, fromDate: null, toDate: null };
    if (points.length >= 2) {
      const first = points[0];
      const last = points[points.length - 1];
      const abs = Number((last.normalizedValue - first.normalizedValue).toFixed(4));
      const pct = first.normalizedValue !== 0
        ? Number((((last.normalizedValue - first.normalizedValue) / Math.abs(first.normalizedValue)) * 100).toFixed(2))
        : null;
      change = {
        absolute: abs,
        percent: pct,
        direction: abs > 0 ? "up" : abs < 0 ? "down" : "flat",
        fromDate: first.collectedAt,
        toDate: last.collectedAt,
      };
    }

    const placeholders = obsIds.map(() => "?").join(",");
    const reviewRows = obsIds.length
      ? db
          .prepare(
            `SELECT * FROM review_items
             WHERE observation_id IN (${placeholders})
                OR (document_id IN (SELECT DISTINCT document_id FROM observations WHERE canonical_key = ? AND is_active = 1)
                    AND code = 'method_change_notice')`
          )
          .all(...obsIds, key)
      : [];

    return {
      canonicalKey: key,
      displayName: rows[0].display_name || empty.displayName,
      specimen: rows[0].specimen || empty.specimen,
      panel: rows[0].panel || empty.panel,
      normalizedUnit: points[0]?.normalizedUnit || rows[0].normalized_unit || empty.normalizedUnit,
      points,
      omitted,
      change,
      regionalTarget,
      guidelineStatus,
      reviewItems: reviewRows.map(rv => ({
        id: rv.id,
        documentId: rv.document_id,
        observationId: rv.observation_id,
        code: rv.code,
        severity: rv.severity,
        message: rv.message,
        details: parseJsonSafe(rv.details_json, {}),
        resolved: Boolean(rv.resolved),
      })),
    };
  } finally {
    db.close();
  }
}

export function getTimeline(filters = {}, opts = {}) {
  if (!dbExists(opts)) {
    return { events: [], totalDocuments: 0, activeDocuments: 0, supersededDocuments: 0 };
  }
  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) {
      return { events: [], totalDocuments: 0, activeDocuments: 0, supersededDocuments: 0 };
    }
    const where = [];
    const params = [];
    if (filters.from) {
      where.push("d.collected_at >= ?");
      params.push(filters.from);
    }
    if (filters.to) {
      where.push("d.collected_at <= ?");
      params.push(filters.to);
    }
    if (filters.provider) {
      where.push("LOWER(d.provider) LIKE ?");
      params.push(`%${String(filters.provider).toLowerCase()}%`);
    }
    if (filters.docType) {
      where.push("d.doc_type = ?");
      params.push(filters.docType);
    }
    if (filters.includeSuperseded === false) {
      where.push("d.superseded_by IS NULL");
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const docs = db
      .prepare(
        `SELECT d.*,
                (SELECT COUNT(*) FROM observations o WHERE o.document_id = d.id) AS obs_total,
                (SELECT COUNT(*) FROM observations o WHERE o.document_id = d.id AND o.is_active = 1) AS obs_active,
                (SELECT COUNT(*) FROM observations o WHERE o.document_id = d.id AND o.is_active = 1 AND o.flag IN ('low', 'high', 'abnormal')) AS abnormal_count,
                (SELECT COUNT(*) FROM findings f WHERE f.document_id = d.id) AS findings_count
         FROM documents d
         ${whereSql}
         ORDER BY d.collected_at IS NULL, d.collected_at ASC, d.reported_at ASC, d.id ASC`
      )
      .all(...params);

    const allFindings = db.prepare("SELECT * FROM findings ORDER BY collected_at ASC, id ASC").all();
    const allDeliveries = db.prepare("SELECT * FROM deliveries ORDER BY received ASC, id ASC").all();

    const events = docs.map(d => ({
      documentId: d.id,
      filename: d.filename,
      provider: d.provider,
      orderNumber: d.order_number,
      reportStatus: d.report_status,
      docType: d.doc_type,
      collectedAt: d.collected_at,
      reportedAt: d.reported_at,
      receivedAt: d.received_at,
      importedAt: d.imported_at,
      pageCount: d.page_count,
      supersededBy: d.superseded_by,
      isSuperseded: Boolean(d.superseded_by),
      observationsCount: d.obs_total,
      activeObservationsCount: d.obs_active,
      abnormalCount: d.abnormal_count,
      findingsCount: d.findings_count,
      findings: allFindings
        .filter(f => f.document_id === d.id)
        .map(f => ({
          id: f.id,
          findingType: f.finding_type,
          title: f.title,
          summary: f.summary,
          followupPlan: f.followup_plan,
          collectedAt: f.collected_at,
          page: f.page,
          bbox: parseJsonSafe(f.bbox_json, null),
          excerpt: f.excerpt,
        })),
      deliveries: allDeliveries
        .filter(del => del.document_id === d.id)
        .map(del => ({ id: del.id, received: del.received, channel: del.channel })),
      sourceUrl: `/evidence/${d.id}/source`,
      firstPageImageUrl: `/evidence/${d.id}/page/1.png`,
    }));

    const supersededDocuments = events.filter(e => e.isSuperseded).length;
    return {
      events,
      totalDocuments: events.length,
      activeDocuments: events.length - supersededDocuments,
      supersededDocuments,
    };
  } finally {
    db.close();
  }
}

export function getEvidence(idOrFilter, opts = {}) {
  if (!idOrFilter || !dbExists(opts)) return null;
  const filter = typeof idOrFilter === "string" ? { observationId: idOrFilter } : idOrFilter;

  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) return null;

    if (filter.observationId) {
      const obs = db.prepare("SELECT * FROM observations WHERE id = ?").get(filter.observationId);
      if (!obs) return null;
      const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(obs.document_id);
      const page = obs.page || 1;
      return {
        observation: {
          observationId: obs.id,
          documentId: obs.document_id,
          canonicalKey: obs.canonical_key,
          displayName: obs.display_name,
          specimen: obs.specimen,
          panel: obs.panel,
          valueNum: obs.value_num,
          valueText: obs.value_text,
          unitRaw: obs.unit_raw,
          normalizedValue: obs.normalized_value,
          normalizedUnit: obs.normalized_unit,
          refLow: obs.ref_low,
          refHigh: obs.ref_high,
          refText: obs.ref_text,
          flag: obs.flag,
          method: obs.method,
          collectedAt: obs.collected_at,
        },
        document: doc
          ? {
              documentId: doc.id,
              filename: doc.filename,
              provider: doc.provider,
              orderNumber: doc.order_number,
              reportStatus: doc.report_status,
              collectedAt: doc.collected_at,
              reportedAt: doc.reported_at,
              pageCount: doc.page_count,
            }
          : null,
        page,
        lineIndex: obs.line_index,
        bbox: parseJsonSafe(obs.bbox_json, null),
        excerpt: obs.excerpt,
        imagePath: resolvePageImagePath(obs.document_id, page, opts),
        imageUrl: `/evidence/${obs.document_id}/page/${page}.png`,
        sourcePath: resolveDocSourcePath(doc, opts),
        sourceUrl: `/evidence/${obs.document_id}/source`,
        evidencePath: `/?obs=${obs.id}#evidence`,
      };
    }

    if (filter.documentId) {
      const doc = db.prepare("SELECT * FROM documents WHERE id = ?").get(filter.documentId);
      if (!doc) return null;
      const page = Number(filter.page || 1);
      return {
        observation: null,
        document: {
          documentId: doc.id,
          filename: doc.filename,
          provider: doc.provider,
          orderNumber: doc.order_number,
          reportStatus: doc.report_status,
          collectedAt: doc.collected_at,
          reportedAt: doc.reported_at,
          pageCount: doc.page_count,
        },
        page,
        lineIndex: null,
        bbox: null,
        excerpt: null,
        imagePath: resolvePageImagePath(doc.id, page, opts),
        imageUrl: `/evidence/${doc.id}/page/${page}.png`,
        sourcePath: resolveDocSourcePath(doc, opts),
        sourceUrl: `/evidence/${doc.id}/source`,
        evidencePath: `/?doc=${doc.id}&page=${page}#evidence`,
      };
    }

    return null;
  } finally {
    db.close();
  }
}

export function getOverview(opts = {}) {
  const profile = getProfile(opts);
  const guidelines = readRegionalGuidelines(opts);
  const guidelinesSummary = {
    exists: guidelines.exists,
    country: guidelines.frontmatter?.country || null,
    countryName: guidelines.frontmatter?.country_name || null,
    authority: guidelines.frontmatter?.authority || null,
    fetchedAt: guidelines.frontmatter?.fetched_at || null,
    sourceMode: guidelines.frontmatter?.source_mode || null,
    stale: guidelines.stale,
    targetsCount: guidelines.targets.length,
    sourcesCount: guidelines.sources.length,
  };

  if (!dbExists(opts)) {
    return {
      profile,
      counts: {
        documents: 0,
        activeDocuments: 0,
        supersededDocuments: 0,
        skippedDocuments: 0,
        activeObservations: 0,
        biomarkers: 0,
        abnormalCount: 0,
        findingsCount: 0,
        openReviewItems: 0,
      },
      latestCollectionDate: null,
      earliestCollectionDate: null,
      providers: [],
      recentChanges: [],
      abnormalFlags: [],
      followups: [],
      followupsNote: "No documented follow-up plan found in imported records.",
      skippedDocuments: [],
      reviewItems: [],
      recordGaps: ["No lab documents imported yet."],
      guidelinesSummary,
    };
  }

  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) {
      return {
        profile: null,
        counts: { documents: 0, activeDocuments: 0, supersededDocuments: 0, skippedDocuments: 0, activeObservations: 0, biomarkers: 0, abnormalCount: 0, findingsCount: 0, openReviewItems: 0 },
        latestCollectionDate: null,
        earliestCollectionDate: null,
        providers: [],
        recentChanges: [],
        abnormalFlags: [],
        followups: [],
        followupsNote: "Legacy SQLite schema detected; re-ingest with core engine.",
        skippedDocuments: [],
        reviewItems: [],
        recordGaps: [],
        guidelinesSummary,
      };
    }

    const docs = db.prepare("SELECT * FROM documents ORDER BY collected_at ASC").all();
    const skipped = db.prepare("SELECT * FROM skipped_documents ORDER BY detected_at DESC").all();
    const findings = db.prepare("SELECT f.*, d.provider, d.filename FROM findings f JOIN documents d ON d.id = f.document_id ORDER BY f.collected_at DESC").all();
    const reviews = db.prepare("SELECT * FROM review_items WHERE resolved = 0 ORDER BY id ASC").all();
    const activeObs = db
      .prepare(
        `SELECT o.*, d.provider, d.filename
         FROM observations o
         JOIN documents d ON d.id = o.document_id
         WHERE o.is_active = 1
         ORDER BY o.collected_at IS NULL, o.collected_at ASC, o.id ASC`
      )
      .all();

    const byKey = new Map();
    for (const o of activeObs) {
      if (!byKey.has(o.canonical_key)) byKey.set(o.canonical_key, []);
      byKey.get(o.canonical_key).push(o);
    }

    const recentChanges = [];
    const abnormalFlags = [];

    for (const [key, list] of byKey.entries()) {
      const latest = list[list.length - 1];
      if (["low", "high", "abnormal"].includes(latest.flag)) {
        abnormalFlags.push({
          observationId: latest.id,
          documentId: latest.document_id,
          canonicalKey: key,
          displayName: latest.display_name,
          panel: latest.panel,
          specimen: latest.specimen,
          valueText: latest.value_text,
          unitRaw: latest.unit_raw,
          normalizedValue: latest.normalized_value,
          normalizedUnit: latest.normalized_unit,
          refText: latest.ref_text,
          flag: latest.flag,
          collectedAt: latest.collected_at,
          provider: latest.provider,
          page: latest.page,
          excerpt: latest.excerpt,
          evidencePath: `/?obs=${latest.id}#evidence`,
        });
      }

      const numericPoints = list.filter(o => o.normalized_value !== null && o.collected_at);
      if (numericPoints.length >= 2) {
        const prev = numericPoints[numericPoints.length - 2];
        const curr = numericPoints[numericPoints.length - 1];
        const delta = Number((curr.normalized_value - prev.normalized_value).toFixed(4));
        const pct = prev.normalized_value !== 0
          ? Number(((delta / Math.abs(prev.normalized_value)) * 100).toFixed(2))
          : null;
        if (delta !== 0) {
          recentChanges.push({
            canonicalKey: key,
            displayName: curr.display_name,
            panel: curr.panel,
            fromValue: prev.normalized_value,
            toValue: curr.normalized_value,
            unit: curr.normalized_unit || curr.unit_raw,
            delta,
            percentChange: pct,
            direction: delta > 0 ? "up" : "down",
            fromDate: prev.collected_at,
            toDate: curr.collected_at,
            latestFlag: curr.flag,
            observationId: curr.id,
            evidencePath: `/?obs=${curr.id}#evidence`,
          });
        }
      }
    }

    recentChanges.sort((a, b) => Math.abs(b.percentChange || 0) - Math.abs(a.percentChange || 0));

    const followups = findings
      .filter(f => f.followup_plan && f.followup_plan.trim())
      .map(f => ({
        id: f.id,
        documentId: f.document_id,
        provider: f.provider,
        title: f.title,
        followupPlan: f.followup_plan,
        collectedAt: f.collected_at,
        page: f.page,
        excerpt: f.excerpt,
      }));

    const dates = docs.map(d => d.collected_at).filter(Boolean).sort();
    const recordGaps = [];
    if (!profile) recordGaps.push("Patient identity profile not configured yet (run health_onboarding).");
    if (!guidelines.exists) recordGaps.push("Regional clinical guidelines not synced yet (run health_guidelines_sync).");
    if (guidelines.exists && guidelines.stale) recordGaps.push("Regional clinical guidelines are older than 12 months and should be refreshed.");
    if (followups.length === 0) recordGaps.push("No documented clinical follow-up plan appears in imported lab reports.");

    const supersededCount = docs.filter(d => d.superseded_by).length;
    return {
      profile,
      counts: {
        documents: docs.length,
        activeDocuments: docs.length - supersededCount,
        supersededDocuments: supersededCount,
        skippedDocuments: skipped.length,
        activeObservations: activeObs.length,
        biomarkers: byKey.size,
        abnormalCount: abnormalFlags.length,
        findingsCount: findings.length,
        openReviewItems: reviews.length,
      },
      latestCollectionDate: dates.length ? dates[dates.length - 1] : null,
      earliestCollectionDate: dates.length ? dates[0] : null,
      providers: [...new Set(docs.map(d => d.provider))],
      recentChanges: recentChanges.slice(0, 15),
      abnormalFlags,
      followups,
      followupsNote: followups.length
        ? `${followups.length} documented follow-up item(s) found.`
        : "No documented follow-up plan found in imported records.",
      skippedDocuments: skipped.map(s => ({
        id: s.id,
        filename: s.filename,
        provider: s.provider,
        patientNameRaw: s.patient_name_raw,
        reason: s.reason,
        detectedAt: s.detected_at,
      })),
      reviewItems: reviews.map(r => ({
        id: r.id,
        documentId: r.document_id,
        observationId: r.observation_id,
        code: r.code,
        severity: r.severity,
        message: r.message,
        details: parseJsonSafe(r.details_json, {}),
        resolved: Boolean(r.resolved),
      })),
      recordGaps,
      guidelinesSummary,
    };
  } finally {
    db.close();
  }
}

export function getDashboardPayload(opts = {}) {
  const profile = getProfile(opts);
  const overview = getOverview(opts);
  const biomarkers = listBiomarkers(opts);
  const timeline = getTimeline({}, opts);
  const guidelines = readRegionalGuidelines(opts);

  // Pick smart default biomarker: prefer LDL or Glucose or first multi-point numeric biomarker
  const allBios = biomarkers.panels.flatMap(p => p.biomarkers);
  const preferredKeys = ["serum:ldl_direct", "serum:ldl", "serum:glucose", "serum:hba1c", "serum:triglycerides", "blood:hemoglobin"];
  let defaultBiomarkerKey = null;
  for (const k of preferredKeys) {
    if (allBios.some(b => b.canonicalKey === k && b.numericCount >= 2)) {
      defaultBiomarkerKey = k;
      break;
    }
  }
  if (!defaultBiomarkerKey) {
    const multi = allBios.find(b => b.numericCount >= 2);
    defaultBiomarkerKey = multi?.canonicalKey || allBios[0]?.canonicalKey || null;
  }

  const defaultTrend = defaultBiomarkerKey ? getTrend(defaultBiomarkerKey, opts) : null;

  // Include lightweight precomputed trends for top biomarkers (and on-demand /api/trend?key=... for any key)
  const trendsByKey = {};
  for (const b of allBios) {
    if (b.numericCount >= 1) {
      trendsByKey[b.canonicalKey] = getTrend(b.canonicalKey, opts);
    }
  }

  const findings = timeline.events.flatMap(ev =>
    ev.findings.map(f => ({ ...f, documentId: ev.documentId, provider: ev.provider, filename: ev.filename }))
  );

  return {
    generatedAt: new Date().toISOString(),
    profile,
    overview,
    biomarkers,
    timeline,
    findings,
    skippedDocuments: overview.skippedDocuments,
    reviewItems: overview.reviewItems,
    guidelines,
    defaultBiomarkerKey,
    defaultTrend,
    trendsByKey,
  };
}

/**
 * Backward-compatible reader matching the legacy timeline.mjs shape for verify_tool.mjs & legacy /timeline.json.
 */
export function readLegacyTimeline(opts = {}) {
  if (!dbExists(opts)) {
    return { results: [], review: [], change: null, deliveries: [] };
  }
  const db = openDb({ ...opts, readOnly: true });
  try {
    if (isLegacySchema(db)) {
      const entries = db
        .prepare(
          "SELECT d.id, d.provider, d.page_count AS pageCount, o.payload " +
            "FROM documents d JOIN observations o ON o.document_id = d.id " +
            "ORDER BY o.collected IS NULL, o.collected, d.id"
        )
        .all();
      const deliveries = db
        .prepare("SELECT document_id AS documentId, received, channel FROM deliveries ORDER BY received, id")
        .all();
      const records = entries.map(({ payload, ...document }) => ({
        ...document,
        ...JSON.parse(payload),
        deliveries: deliveries.filter(row => row.documentId === document.id),
      }));
      const results = records.filter(row => row.normalized !== null);
      const review = records.filter(row => row.reasons.length > 0);
      const change = results.length >= 2
        ? Number((results.at(-1).normalized - results[0].normalized).toFixed(4))
        : null;
      return { results, review, change, deliveries };
    }
  } finally {
    db.close();
  }

  // Adapt new multi-analyte DB into legacy shape for serum:ldl_direct
  const trend = getTrend("serum:ldl_direct", opts);
  const timeline = getTimeline({}, opts);
  const deliveries = timeline.events.flatMap(ev =>
    ev.deliveries.map(d => ({ documentId: ev.documentId, received: d.received, channel: d.channel }))
  );
  const results = trend.points.map(pt => ({
    id: pt.documentId,
    provider: pt.provider,
    pageCount: timeline.events.find(e => e.documentId === pt.documentId)?.pageCount || 1,
    collected: pt.collectedAt,
    reported: pt.reportedAt,
    specimen: pt.specimen,
    method: pt.method,
    result: { value: pt.valueText, unit: pt.unitRaw, range: pt.refText },
    source: { page: pt.page, line: pt.lineIndex, text: pt.excerpt, box: pt.bbox },
    factor: pt.conversionFactor,
    normalized: pt.normalizedValue,
    reasons: [],
    deliveries: deliveries.filter(d => d.documentId === pt.documentId),
  }));
  const review = trend.omitted.map(om => ({
    id: om.documentId,
    provider: om.provider,
    reasons: [om.reason],
  }));
  return {
    results,
    review,
    change: trend.change.absolute,
    deliveries,
  };
}
