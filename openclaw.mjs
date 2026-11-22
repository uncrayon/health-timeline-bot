import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTimeline } from "./timeline.mjs";
import {
  getProfile,
  saveProfile,
  listBiomarkers,
  getTrend,
  getTimeline,
  getEvidence,
  getOverview,
} from "./core/query.mjs";
import {
  ingestFile,
  ingestDirectory,
  commitExtractedDocument,
} from "./core/ingest.mjs";
import {
  syncRegionalGuidelines,
  readRegionalGuidelines,
} from "./core/guidelines.mjs";

const string = { type: "string" };
const number = { type: "number" };
const integer = { type: "integer", minimum: 1 };
const boolean = { type: "boolean" };
const nullableString = { anyOf: [string, { type: "null" }] };
const nullableNumber = { anyOf: [number, { type: "null" }] };
const stringArray = { type: "array", items: string };

const strictRecord = (properties, required = Object.keys(properties)) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

function expandHome(value) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return trimmed;
}

function resolveCoreOpts(pluginConfig = {}, toolArgs = {}) {
  const opts = {};
  const dataDir =
    expandHome(toolArgs?.dataDir) ??
    expandHome(pluginConfig?.dataDir) ??
    expandHome(process.env.HEALTH_TIMELINE_DATA_DIR);
  const inboxDir =
    expandHome(toolArgs?.inboxDir) ??
    expandHome(pluginConfig?.inboxDir) ??
    expandHome(process.env.HEALTH_TIMELINE_INBOX_DIR);
  const allowSyntheticDemo =
    toolArgs?.allowSyntheticDemo ?? pluginConfig?.allowSyntheticDemo;

  if (dataDir) opts.dataDir = dataDir;
  if (inboxDir) opts.inboxDir = inboxDir;
  if (typeof allowSyntheticDemo === "boolean") {
    opts.allowSyntheticDemo = allowSyntheticDemo;
  }
  return opts;
}

function toolResult(details) {
  return {
    content: [{ type: "text", text: JSON.stringify(details) }],
    details,
  };
}

function resolveInboxDocumentPath(inboxDir, documentId) {
  if (!inboxDir) {
    throw new Error(
      "Cannot resolve documentId without an inboxDir (configure inboxDir or pass path).",
    );
  }
  const cleanId = String(documentId || "").trim();
  if (
    !cleanId ||
    cleanId.includes("/") ||
    cleanId.includes("\\") ||
    cleanId.includes("..")
  ) {
    throw new Error("Invalid documentId: must be a plain filename or document stem.");
  }
  const resolvedRoot = path.resolve(inboxDir);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Inbox directory does not exist: ${resolvedRoot}`);
  }
  const entries = fs.readdirSync(resolvedRoot);
  const exact = entries.find((name) => name === cleanId);
  const byStem =
    exact ??
    entries.find(
      (name) => path.parse(name).name.toLowerCase() === cleanId.toLowerCase(),
    );
  if (!byStem) {
    throw new Error(`Document "${cleanId}" not found in inbox directory.`);
  }
  const fullPath = path.resolve(resolvedRoot, byStem);
  const rel = path.relative(resolvedRoot, fullPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error("Resolved document path escapes inbox directory.");
  }
  return fullPath;
}

function summarizeIngestOutput(mode, raw) {
  const results = Array.isArray(raw?.results) ? raw.results : [raw];
  const needsVlmItems = results
    .filter((item) => item?.status === "needs_vlm_extraction")
    .map((item) => ({
      fileId: item.fileId ?? item.documentId ?? item.filename,
      filename: item.filename,
      sourcePath: item.sourcePath ?? null,
      imagePaths: item.imagePaths ?? [],
      schemaHint: item.schemaHint ?? null,
      message: item.message ?? "Inspect imagePaths with VLM and call health_commit_extracted.",
    }));

  const skippedDocuments = results
    .filter((item) => item?.status === "skipped")
    .map((item) => ({
      filename: item.filename,
      provider: item.provider ?? null,
      reason: item.skipReason ?? item.message ?? "patient_mismatch",
    }));

  const supersededDocumentIds = results.flatMap((item) =>
    Array.isArray(item?.supersededDocumentIds) ? item.supersededDocumentIds : [],
  );

  const reviewItemsCount = results.reduce(
    (sum, item) => sum + (Number(item?.reviewItemsCount) || 0),
    0,
  );

  if (mode === "directory") {
    return {
      mode: "directory",
      directory: raw.directory,
      processed: raw.processed ?? results.length,
      ingested: raw.ingested ?? results.filter((r) => r?.status === "ingested").length,
      skipped: raw.skipped ?? skippedDocuments.length,
      duplicates: raw.duplicates ?? results.filter((r) => r?.status === "duplicate").length,
      needsVlm: raw.needsVlm ?? needsVlmItems.length,
      errors: raw.errors ?? results.filter((r) => r?.status === "error").length,
      supersededDocumentIds,
      skippedDocuments,
      reviewItemsCount,
      needs_vlm_extraction: needsVlmItems,
      results,
    };
  }

  return {
    mode: "file",
    processed: 1,
    ingested: raw?.status === "ingested" ? 1 : 0,
    skipped: raw?.status === "skipped" ? 1 : 0,
    duplicates: raw?.status === "duplicate" ? 1 : 0,
    needsVlm: needsVlmItems.length,
    errors: raw?.status === "error" ? 1 : 0,
    supersededDocumentIds,
    skippedDocuments,
    reviewItemsCount,
    needs_vlm_extraction: needsVlmItems,
    result: raw,
  };
}

function normalizeExtractedPayload(args = {}) {
  const sourcePath = args.sourcePath ?? args.source_path ?? undefined;
  const filename =
    args.filename ??
    (typeof sourcePath === "string" && sourcePath ? path.basename(sourcePath) : undefined);

  const rawPatient = args.patient && typeof args.patient === "object" ? args.patient : {};
  const patient = {
    nameRaw:
      rawPatient.nameRaw ??
      rawPatient.name_raw ??
      args.patient_name_raw ??
      args.patientNameRaw ??
      null,
    dobRaw:
      rawPatient.dobRaw ??
      rawPatient.dob_raw ??
      args.patient_dob_raw ??
      args.patientDobRaw ??
      null,
    sexRaw:
      rawPatient.sexRaw ??
      rawPatient.sex_raw ??
      args.patient_sex_raw ??
      args.patientSexRaw ??
      null,
  };

  const observations = Array.isArray(args.observations)
    ? args.observations.map((obs) => ({
        rawName: obs.rawName ?? obs.raw_name ?? obs.display_name ?? obs.displayName ?? obs.name,
        canonicalKey: obs.canonicalKey ?? obs.canonical_key ?? undefined,
        specimen: obs.specimen ?? undefined,
        panel: obs.panel ?? undefined,
        valueNum: obs.valueNum ?? obs.value_num ?? null,
        valueText: String(
          obs.valueText ??
            obs.value_text ??
            obs.value_raw ??
            obs.valueRaw ??
            obs.valueNum ??
            obs.value_num ??
            "",
        ),
        unitRaw: obs.unitRaw ?? obs.unit_raw ?? obs.unit ?? null,
        refText: obs.refText ?? obs.ref_text ?? obs.labRange ?? null,
        refLow: obs.refLow ?? obs.ref_low ?? null,
        refHigh: obs.refHigh ?? obs.ref_high ?? null,
        method: obs.method ?? null,
        collectedAt: obs.collectedAt ?? obs.collected_at ?? undefined,
        page: obs.page ?? 1,
        lineIndex: obs.lineIndex ?? obs.line_index ?? null,
        bbox: obs.bbox ?? null,
        excerpt: obs.excerpt ?? null,
        meta: obs.meta ?? undefined,
      }))
    : [];

  const findings = Array.isArray(args.findings)
    ? args.findings.map((f) => ({
        findingType: f.findingType ?? f.finding_type ?? "clinical_finding",
        title: f.title ?? "Finding",
        summary: f.summary ?? "",
        followupPlan: f.followupPlan ?? f.followup_plan ?? null,
        collectedAt: f.collectedAt ?? f.collected_at ?? undefined,
        page: f.page ?? 1,
        bbox: f.bbox ?? null,
        excerpt: f.excerpt ?? null,
      }))
    : [];

  const reviewItems = Array.isArray(args.reviewItems ?? args.review_items)
    ? (args.reviewItems ?? args.review_items)
    : [];

  const deliveries = Array.isArray(args.deliveries) ? args.deliveries : [];

  return {
    filename,
    sourcePath,
    sha256: args.sha256 ?? undefined,
    provider: args.provider,
    orderNumber: args.orderNumber ?? args.order_number ?? null,
    reportStatus: args.reportStatus ?? args.report_status ?? "UNKNOWN",
    docType: args.docType ?? args.doc_type ?? "lab_report",
    pageCount: args.pageCount ?? args.page_count ?? 1,
    patient,
    collectedAt: args.collectedAt ?? args.collected_at ?? null,
    reportedAt: args.reportedAt ?? args.reported_at ?? null,
    receivedAt: args.receivedAt ?? args.received_at ?? null,
    isSyntheticDemo: Boolean(args.isSyntheticDemo ?? args.is_synthetic_demo ?? false),
    pagesRendered: args.pagesRendered ?? args.pages_rendered ?? undefined,
    meta: args.meta ?? { ingestionSource: "vlm_extraction" },
    observations,
    findings,
    reviewItems,
    deliveries,
  };
}

// Backward-compatible synthetic LDL trend tool (exported for verify_tool.mjs)
export const trendTool = {
  name: "health_ldl_trend",
  label: "Read synthetic LDL trend",
  description:
    "Compare direct serum LDL in the staged synthetic Health Timeline reports, with collection dates and evidence. Report the observed change only.",
  parameters: strictRecord({
    measurement: { type: "string", enum: ["ldl_direct_serum"] },
  }),
  outputSchema: strictRecord({
    normalizedUnit: { type: "string", enum: ["mg/dL"] },
    change: nullableNumber,
    results: {
      type: "array",
      maxItems: 2,
      items: strictRecord({
        provider: string,
        collected: string,
        value: string,
        unit: string,
        labRange: string,
        normalized: number,
        conversionFactor: number,
        source: strictRecord({
          page: integer,
          line: integer,
          excerpt: string,
          evidencePath: string,
        }),
      }),
    },
    review: {
      type: "array",
      maxItems: 2,
      items: strictRecord({
        provider: string,
        reasons: stringArray,
        evidencePath: string,
      }),
    },
  }),
  async execute(_toolCallId, args) {
    if (
      !args ||
      typeof args !== "object" ||
      Object.keys(args).length !== 1 ||
      args.measurement !== "ldl_direct_serum"
    ) {
      throw new Error("Use only measurement = ldl_direct_serum.");
    }
    const { results, review, change } = readTimeline();
    const details = {
      normalizedUnit: "mg/dL",
      change,
      results: results.map((row) => ({
        provider: row.provider,
        collected: row.collected,
        value: row.result.value,
        unit: row.result.unit,
        labRange: row.result.range,
        normalized: row.normalized,
        conversionFactor: row.factor,
        source: {
          page: row.source.page,
          line: row.source.line,
          excerpt: row.source.text,
          evidencePath: "/?result=" + row.id + "#evidence",
        },
      })),
      review: review.map((row) => ({
        provider: row.provider,
        reasons: row.reasons,
        evidencePath: "/?result=" + row.id + "#evidence",
      })),
    };
    return toolResult(details);
  },
};

export function createHealthTools(pluginConfig = {}) {
  const onboardingTool = {
    name: "health_onboarding",
    label: "Health profile onboarding",
    description:
      "Get or update the personal health owner profile (full_name, lab aliases for patient-identity filtering, dob, biological_sex, country, ethnicity, pregnancy_status, conditions).",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["get", "set"],
          description: "Read ('get') or save ('set') the patient profile. Defaults to 'set' when profile fields are provided, else 'get'.",
        },
        full_name: { ...string, description: "Owner's full legal name." },
        fullName: { ...string, description: "Alias for full_name." },
        aliases: {
          ...stringArray,
          description: "Alternate lab-printed name formats (e.g., 'SURNAMES, FIRST MIDDLE', unaccented variants).",
        },
        dob: { ...nullableString, description: "Date of birth in YYYY-MM-DD format." },
        biological_sex: {
          type: "string",
          enum: ["male", "female", "intersex", "unspecified"],
          description: "Biological sex for sex-stratified clinical reference thresholds.",
        },
        biologicalSex: {
          type: "string",
          enum: ["male", "female", "intersex", "unspecified"],
        },
        country: {
          ...string,
          description: "ISO-3166 alpha-2 country code (e.g., MX, US, DE).",
        },
        ethnicity: {
          ...nullableString,
          description: "Optional ancestry/ethnicity used only where officially endorsed (never race-adjusted eGFR).",
        },
        pregnancy_status: {
          type: "string",
          enum: ["none", "pregnant", "postpartum", "lactating", "unknown"],
        },
        pregnancyStatus: {
          type: "string",
          enum: ["none", "pregnant", "postpartum", "lactating", "unknown"],
        },
        conditions: {
          ...stringArray,
          description: "Optional known chronic conditions (e.g., diabetes, hypertension, dyslipidemia).",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      const profileKeys = [
        "full_name",
        "fullName",
        "aliases",
        "dob",
        "biological_sex",
        "biologicalSex",
        "country",
        "ethnicity",
        "pregnancy_status",
        "pregnancyStatus",
        "conditions",
      ];
      const hasWriteFields = profileKeys.some((k) => args[k] !== undefined);
      const action = args.action ?? (hasWriteFields ? "set" : "get");

      if (action === "get") {
        const profile = getProfile(opts);
        return toolResult({
          configured: Boolean(profile && profile.fullName),
          profile,
        });
      }

      if (!hasWriteFields) {
        throw new Error(
          "Provide at least one profile field (e.g., full_name, country) when action='set'.",
        );
      }
      const saved = saveProfile(args, opts);
      return toolResult({
        configured: Boolean(saved && saved.fullName),
        profile: saved,
      });
    },
  };

  const guidelinesSyncTool = {
    name: "health_guidelines_sync",
    label: "Sync official regional clinical guidelines",
    description:
      "Live-scrape official national health ministry and WHO clinical guidelines for the user's profile (enforcing a fail-closed official-domain allowlist in code) and write regional-guidelines.md.",
    parameters: {
      type: "object",
      properties: {
        country: { ...string, description: "Optional ISO country code override (e.g., MX, US, DE)." },
        biological_sex: {
          type: "string",
          enum: ["male", "female", "intersex", "unspecified"],
        },
        biologicalSex: {
          type: "string",
          enum: ["male", "female", "intersex", "unspecified"],
        },
        dob: nullableString,
        ethnicity: nullableString,
        pregnancy_status: {
          type: "string",
          enum: ["none", "pregnant", "postpartum", "lactating", "unknown"],
        },
        pregnancyStatus: {
          type: "string",
          enum: ["none", "pregnant", "postpartum", "lactating", "unknown"],
        },
        conditions: stringArray,
        extraUrls: {
          ...stringArray,
          description: "Optional extra official ministry/WHO URLs to fetch (rejected if outside the official domain allowlist).",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      const override = {};
      if (args.country !== undefined) override.country = args.country;
      if (args.biological_sex !== undefined || args.biologicalSex !== undefined) {
        override.biologicalSex = args.biologicalSex ?? args.biological_sex;
      }
      if (args.dob !== undefined) override.dob = args.dob;
      if (args.ethnicity !== undefined) override.ethnicity = args.ethnicity;
      if (args.pregnancy_status !== undefined || args.pregnancyStatus !== undefined) {
        override.pregnancyStatus = args.pregnancyStatus ?? args.pregnancy_status;
      }
      if (args.conditions !== undefined) override.conditions = args.conditions;
      if (args.extraUrls !== undefined) override.extraUrls = args.extraUrls;

      const synced = await syncRegionalGuidelines(
        Object.keys(override).length > 0 ? override : undefined,
        opts,
      );
      return toolResult({
        guidelinesPath: synced.guidelinesPath,
        country: synced.country,
        fetchedAt: synced.fetchedAt,
        expiresAt: synced.expiresAt,
        sourceMode: synced.sourceMode,
        sources: synced.sources,
        targetsCount: Array.isArray(synced.targets) ? synced.targets.length : 0,
        targets: synced.targets,
        fetchErrors: synced.fetchErrors ?? [],
      });
    },
  };

  const guidelinesReadTool = {
    name: "health_guidelines_read",
    label: "Read regional clinical guidelines",
    description:
      "Read regional-guidelines.md, freshness metadata, official source URLs, and structured regional clinical target bands.",
    parameters: {
      type: "object",
      properties: {
        canonicalKey: {
          ...string,
          description: "Optional canonical biomarker key (e.g., 'serum:ldl_direct') to highlight its target band.",
        },
        includeMarkdown: {
          ...boolean,
          description: "Include raw regional-guidelines.md markdown body (default true).",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      const result = readRegionalGuidelines(opts);
      const includeMarkdown = args.includeMarkdown !== false;
      const details = {
        exists: result.exists,
        path: result.path,
        frontmatter: result.frontmatter,
        stale: result.stale,
        sources: result.sources,
        targets: result.targets,
        targetsByKey: result.targetsByKey,
        ...(args.canonicalKey
          ? { selectedTarget: result.targetsByKey?.[args.canonicalKey] ?? null }
          : {}),
        ...(includeMarkdown ? { markdown: result.markdown } : {}),
      };
      return toolResult(details);
    },
  };

  const importTool = {
    name: "health_import",
    label: "Import lab PDFs or photos",
    description:
      "Ingest a selected document ID, file path, or approved inbox directory of lab PDFs/photos. Returns counts, skipped non-owner docs, superseded partials, review items, and needs_vlm_extraction items with image paths and JSON schema when vision extraction is required.",
    parameters: {
      type: "object",
      properties: {
        path: {
          ...string,
          description: "Path to a single PDF/photo file or an approved inbox directory.",
        },
        documentId: {
          ...string,
          description: "Filename or stem of a document inside the configured inboxDir.",
        },
        allowSyntheticDemo: {
          ...boolean,
          description: "Allow ingesting built-in synthetic demo PDFs without profile match.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      let targetPath = expandHome(args.path);

      if (!targetPath && args.documentId) {
        targetPath = resolveInboxDocumentPath(opts.inboxDir, args.documentId);
      } else if (!targetPath && opts.inboxDir) {
        targetPath = opts.inboxDir;
      }

      if (!targetPath) {
        throw new Error(
          "Provide a file/directory 'path', a 'documentId', or configure inboxDir / HEALTH_TIMELINE_INBOX_DIR.",
        );
      }

      const resolved = path.resolve(targetPath);
      if (!fs.existsSync(resolved)) {
        throw new Error(`Import target not found: ${resolved}`);
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        const raw = await ingestDirectory(resolved, opts);
        return toolResult(summarizeIngestOutput("directory", raw));
      }
      const raw = await ingestFile(resolved, opts);
      return toolResult(summarizeIngestOutput("file", raw));
    },
  };

  const commitExtractedTool = {
    name: "health_commit_extracted",
    label: "Commit VLM-extracted lab JSON",
    description:
      "Validate and commit VLM-extracted structured JSON from a lab photo or scanned PDF through the deterministic patient-identity gate, analyte/unit normalizer, deduplication rules, and SQLite transaction.",
    parameters: {
      type: "object",
      properties: {
        filename: { ...string, description: "Original photo or PDF filename." },
        sourcePath: { ...string, description: "Original file path on disk." },
        source_path: string,
        sha256: string,
        provider: { ...string, description: "Laboratory or clinic name printed on the document." },
        orderNumber: nullableString,
        order_number: nullableString,
        reportStatus: {
          type: "string",
          enum: ["FINAL", "PARCIAL", "PARTIAL", "PRELIMINARY", "UNKNOWN"],
        },
        report_status: string,
        docType: string,
        doc_type: string,
        pageCount: integer,
        page_count: integer,
        patient: {
          type: "object",
          properties: {
            nameRaw: nullableString,
            name_raw: nullableString,
            dobRaw: nullableString,
            dob_raw: nullableString,
            sexRaw: nullableString,
            sex_raw: nullableString,
          },
        },
        patient_name_raw: nullableString,
        patient_dob_raw: nullableString,
        patient_sex_raw: nullableString,
        collectedAt: nullableString,
        collected_at: nullableString,
        reportedAt: nullableString,
        reported_at: nullableString,
        receivedAt: nullableString,
        received_at: nullableString,
        isSyntheticDemo: boolean,
        allowSyntheticDemo: boolean,
        observations: {
          type: "array",
          description: "Verbatim measurements read from the lab photo or scanned PDF.",
          items: {
            type: "object",
            properties: {
              rawName: string,
              display_name: string,
              canonicalKey: string,
              canonical_key: string,
              specimen: string,
              panel: string,
              valueNum: nullableNumber,
              value_num: nullableNumber,
              valueText: string,
              value_raw: string,
              unitRaw: nullableString,
              unit_raw: nullableString,
              refText: nullableString,
              ref_text: nullableString,
              refLow: nullableNumber,
              refHigh: nullableNumber,
              method: nullableString,
              collectedAt: nullableString,
              page: integer,
              lineIndex: { anyOf: [integer, { type: "null" }] },
              bbox: { anyOf: [{ type: "object" }, { type: "null" }] },
              excerpt: nullableString,
            },
          },
        },
        findings: {
          type: "array",
          description: "Verbatim clinical impressions, summaries, or documented follow-up plans.",
          items: {
            type: "object",
            properties: {
              findingType: string,
              finding_type: string,
              title: string,
              summary: string,
              followupPlan: nullableString,
              followup_plan: nullableString,
              collectedAt: nullableString,
              page: integer,
              bbox: { anyOf: [{ type: "object" }, { type: "null" }] },
              excerpt: nullableString,
            },
          },
        },
        reviewItems: { type: "array", items: { type: "object" } },
        deliveries: { type: "array", items: { type: "object" } },
      },
      required: ["provider"],
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      const payload = normalizeExtractedPayload(args);
      if (!payload.provider || !String(payload.provider).trim()) {
        throw new Error("provider is required when committing extracted document data.");
      }
      if (!payload.filename) {
        payload.filename = `vlm-upload-${Date.now()}.json`;
      }
      if (payload.observations.length === 0 && payload.findings.length === 0) {
        throw new Error(
          "Provide at least one observation or finding in the extracted payload.",
        );
      }
      const result = await commitExtractedDocument(payload, opts);
      return toolResult(result);
    },
  };

  const timelineTool = {
    name: "health_timeline",
    label: "Read chronological health timeline",
    description:
      "List health documents and studies ordered by collection date (not receipt date), filterable by date range, provider, or document type.",
    parameters: {
      type: "object",
      properties: {
        fromDate: { ...string, description: "Filter collection date >= YYYY-MM-DD." },
        toDate: { ...string, description: "Filter collection date <= YYYY-MM-DD." },
        provider: { ...string, description: "Case-insensitive provider name substring filter." },
        docType: { ...string, description: "Filter by document type (e.g., lab_report, imaging)." },
        includeSuperseded: {
          ...boolean,
          description: "Include superseded PARCIAL reports in timeline output (default true).",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      const filters = {
        ...(args.fromDate ? { fromDate: args.fromDate, from: args.fromDate } : {}),
        ...(args.toDate ? { toDate: args.toDate, to: args.toDate } : {}),
        ...(args.provider ? { provider: args.provider } : {}),
        ...(args.docType ? { docType: args.docType, type: args.docType } : {}),
        ...(typeof args.includeSuperseded === "boolean"
          ? { includeSuperseded: args.includeSuperseded }
          : {}),
      };
      const result = getTimeline(filters, opts);
      return toolResult(result);
    },
  };

  const biomarkerTrendTool = {
    name: "health_trend",
    label: "Read cross-lab biomarker trend",
    description:
      "Compare longitudinal values for any canonical biomarker (e.g., serum:ldl_direct, serum:glucose, serum:hba1c, blood:hemoglobin) with lab reference ranges, regional official clinical target overlay, and omitted/review reasons. Omit canonicalKey or set listAvailable=true to list all available biomarkers.",
    parameters: {
      type: "object",
      properties: {
        canonicalKey: {
          ...string,
          description: "Specimen-scoped canonical biomarker key (e.g., 'serum:ldl_direct', 'serum:glucose', 'urine:glucose').",
        },
        listAvailable: {
          ...boolean,
          description: "When true (or when canonicalKey is omitted), list all available biomarkers grouped by panel.",
        },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      if (args.listAvailable || !args.canonicalKey) {
        return toolResult(listBiomarkers(opts));
      }
      const trend = getTrend(args.canonicalKey, opts);
      return toolResult(trend);
    },
  };

  const evidenceTool = {
    name: "health_evidence",
    label: "Inspect source evidence",
    description:
      "Retrieve the exact verbatim excerpt, page number, line index, bounding box, rendered image URL, and source file path/URL for a cited observation.",
    parameters: {
      type: "object",
      properties: {
        observationId: { ...string, description: "Observation ID to inspect." },
        documentId: { ...string, description: "Optional document ID filter." },
        canonicalKey: { ...string, description: "Optional canonical biomarker key (used with documentId)." },
      },
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      if (!args.observationId && !args.documentId) {
        throw new Error("Provide observationId or documentId.");
      }
      const query = args.observationId
        ? args.observationId
        : { documentId: args.documentId, canonicalKey: args.canonicalKey };
      const evidence = getEvidence(query, opts);
      if (!evidence) {
        return toolResult({ found: false, evidence: null });
      }
      return toolResult({ found: true, ...evidence });
    },
  };

  const overviewTool = {
    name: "health_overview",
    label: "Read personal health overview",
    description:
      "Summarize recent biomarker changes, abnormal flags, documented follow-up plans, skipped non-owner documents, review items, record gaps, and regional guidelines status.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute(_toolCallId, args = {}) {
      const opts = resolveCoreOpts(pluginConfig, args);
      const overview = getOverview(opts);
      return toolResult(overview);
    },
  };

  return [
    onboardingTool,
    guidelinesSyncTool,
    guidelinesReadTool,
    importTool,
    commitExtractedTool,
    timelineTool,
    biomarkerTrendTool,
    evidenceTool,
    overviewTool,
    trendTool,
  ];
}

export default {
  id: "health-timeline",
  name: "Health Timeline",
  description:
    "Privacy-first personal health timeline, multi-lab biomarker tracker, official regional clinical guidelines, and evidence-cited PDF/photo ingestion.",
  register(api) {
    const pluginConfig = api?.pluginConfig ?? api?.config ?? {};
    const tools = createHealthTools(pluginConfig);
    for (const tool of tools) {
      if (tool.name === "health_ldl_trend") {
        api.registerTool(tool, { optional: true });
      } else {
        api.registerTool(tool);
      }
    }
  },
};
