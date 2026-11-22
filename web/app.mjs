const byId = id => document.getElementById(id);

const dateMed = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });
const dateShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" });
const dateCompact = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

// Authentic Atlassian Design System Data-Viz Palette
const PROVIDER_PALETTE = [
  "#0C66E4", // ADS Brand Blue (Médica Sur / primary)
  "#6E5DC6", // ADS Discovery Purple (LAPI)
  "#1F845A", // ADS Success Green
  "#D97706", // ADS Amber
  "#008299", // ADS Teal
  "#C9372C", // ADS Red
];

const state = {
  dashboard: null,
  guidelines: null,
  selectedPanel: "All",
  searchQuery: "",
  selectedKey: null,
  selectedTrend: null,
  selectedObsId: null,
  selectedDocId: null,
  providerFilter: "all",
  evidenceState: null,
  obsById: new Map(),
  obsByDoc: new Map(),
  docById: new Map(),
  providerColors: new Map(),
  trendCache: new Map(),
  chartObserver: null,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function svgIcon(kind) {
  const wrap = document.createElement("span");
  wrap.setAttribute("aria-hidden", "true");
  if (kind === "warning") {
    wrap.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><path d="M10 2.6L18 16.5H2L10 2.6Z" fill="#CF9F02"/><path d="M10 7.5v4.2M10 14h.01" stroke="#172B4D" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  } else if (kind === "danger") {
    wrap.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><circle cx="10" cy="10" r="8" fill="#CA3521"/><path d="M7.2 7.2l5.6 5.6M12.8 7.2l-5.6 5.6" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  } else if (kind === "discovery") {
    wrap.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><circle cx="10" cy="10" r="8" fill="#6E5DC6"/><path d="M10 9v4.5M10 6.5h.01" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  } else {
    wrap.innerHTML = `<svg viewBox="0 0 20 20" width="18" height="18" fill="none"><circle cx="10" cy="10" r="8" fill="#0C66E4"/><path d="M10 9v4.5M10 6.5h.01" stroke="#FFFFFF" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  }
  return wrap;
}

function parseIsoDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const datePart = str.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    const ts = Date.parse(datePart + "T00:00:00Z");
    return Number.isNaN(ts) ? null : ts;
  }
  const ts = Date.parse(str);
  return Number.isNaN(ts) ? null : ts;
}

function formatDate(raw, fmt = dateMed) {
  const ts = parseIsoDate(raw);
  if (ts === null) return "Not recorded";
  return fmt.format(new Date(ts));
}

function formatNum(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "—";
  const num = Number(value);
  const abs = Math.abs(num);
  if (Number.isInteger(num) || abs >= 100) return Math.round(num).toString();
  if (abs >= 10) return Number(num.toFixed(1)).toString();
  return Number(num.toFixed(2)).toString();
}

function formatSignedDelta(value, unit = "") {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "";
  const num = Number(value);
  const sign = num > 0 ? "+" : "";
  return `${sign}${formatNum(num)}${unit ? " " + unit : ""}`;
}

function getInitials(name) {
  if (!name) return "HT";
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function getProviderColor(provider) {
  const key = provider || "Unknown";
  if (!state.providerColors.has(key)) {
    if (/lapi/i.test(key)) {
      state.providerColors.set(key, "#6E5DC6"); // ADS Discovery Purple
    } else if (/m[eé]dica\s+sur|cedar/i.test(key)) {
      state.providerColors.set(key, "#0C66E4"); // ADS Brand Blue
    } else {
      const used = new Set(state.providerColors.values());
      const next = PROVIDER_PALETTE.find(c => !used.has(c)) || PROVIDER_PALETTE[state.providerColors.size % PROVIDER_PALETTE.length];
      state.providerColors.set(key, next);
    }
  }
  return state.providerColors.get(key);
}

function getProviderLozengeClass(provider) {
  if (/lapi/i.test(provider || "")) return "lozenge lozenge-discovery";
  if (/m[eé]dica\s+sur|cedar/i.test(provider || "")) return "lozenge lozenge-info";
  return "lozenge lozenge-neutral";
}

function isAbnormalFlag(flag) {
  const f = String(flag || "").toLowerCase();
  return f === "high" || f === "low" || f === "abnormal" || f === "critical";
}

function flagLabel(flag) {
  const f = String(flag || "").toLowerCase();
  if (f === "high") return "High";
  if (f === "low") return "Low";
  if (f === "abnormal" || f === "critical") return "Abnormal";
  if (f === "normal") return "Normal";
  return "";
}

function flagLozengeClass(flag) {
  const f = String(flag || "").toLowerCase();
  if (f === "high" || f === "low" || f === "abnormal" || f === "critical") return "lozenge lozenge-danger";
  if (f === "normal") return "lozenge lozenge-success";
  return "lozenge lozenge-neutral";
}

function normalizeTargetBand(target) {
  if (!target) return null;
  const low = target.targetLow ?? target.low ?? target.min ?? null;
  const high = target.targetHigh ?? target.high ?? target.max ?? null;
  const text = target.targetText || target.text || target.range || (
    low !== null && high !== null ? `${low}–${high}` :
    high !== null ? `< ${high}` :
    low !== null ? `>= ${low}` : ""
  );
  const unit = target.unit || "";
  const shortBound = (low !== null && high !== null)
    ? `${formatNum(low)}–${formatNum(high)}${unit ? " " + unit : ""}`
    : high !== null
      ? `< ${formatNum(high)}${unit ? " " + unit : ""}`
      : low !== null
        ? `>= ${formatNum(low)}${unit ? " " + unit : ""}`
        : text;
  const citation = [target.guidelineId, target.population, target.note]
    .filter(Boolean)
    .join(" · ") || target.citation || target.source || target.sourceTitle || target.label || "";
  const url = target.sourceUrl || target.url || "";
  return {
    low: low !== null && low !== "" && !Number.isNaN(Number(low)) ? Number(low) : null,
    high: high !== null && high !== "" && !Number.isNaN(Number(high)) ? Number(high) : null,
    text,
    shortBound,
    unit,
    guidelineId: target.guidelineId || "",
    citation,
    url,
    raw: target,
  };
}

function indexDashboard(data) {
  state.obsById.clear();
  state.obsByDoc.clear();
  state.docById.clear();
  state.trendCache.clear();

  const events = data?.timeline?.events || [];
  for (const ev of events) {
    state.docById.set(ev.documentId, ev);
    getProviderColor(ev.provider);
  }

  const trendsByKey = data?.trendsByKey || {};
  for (const [key, trend] of Object.entries(trendsByKey)) {
    state.trendCache.set(key, trend);
    const allPoints = [...(trend.points || []), ...(trend.omitted || [])];
    for (const pt of allPoints) {
      const enriched = {
        ...pt,
        canonicalKey: pt.canonicalKey || trend.canonicalKey || key,
        displayName: pt.displayName || trend.displayName || key,
        specimen: pt.specimen || trend.specimen || "",
        panel: pt.panel || trend.panel || "",
        regionalTarget: trend.regionalTarget || null,
      };
      if (enriched.observationId) {
        state.obsById.set(String(enriched.observationId), enriched);
      }
      if (enriched.documentId) {
        if (!state.obsByDoc.has(enriched.documentId)) state.obsByDoc.set(enriched.documentId, []);
        const list = state.obsByDoc.get(enriched.documentId);
        if (!list.some(item => item.observationId === enriched.observationId)) {
          list.push(enriched);
        }
      }
    }
  }
}

function getAllBiomarkers() {
  const panels = state.dashboard?.biomarkers?.panels || [];
  const list = [];
  for (const group of panels) {
    for (const bio of group.biomarkers || []) {
      list.push({ ...bio, panel: bio.panel || group.panel || "Other" });
    }
  }
  return list;
}

function renderTopbar(data) {
  const profile = data.profile;
  const chip = byId("patient-chip");
  const chipText = byId("patient-chip-text");
  const avatar = byId("patient-avatar");

  if (profile?.fullName) {
    const bits = [profile.fullName];
    if (profile.country) bits.push(profile.country);
    chipText.textContent = bits.join(" · ");
    chip.title = chipText.textContent;
    avatar.textContent = getInitials(profile.fullName);
    chip.hidden = false;
  } else {
    chipText.textContent = "Synthetic Demo";
    chip.title = chipText.textContent;
    avatar.textContent = "SD";
    chip.hidden = false;
  }

  const g = data.guidelines || data.overview?.guidelinesSummary || {};
  const dot = byId("guideline-dot");
  const label = byId("guideline-btn-label");
  dot.className = "status-dot";

  const country = g.country || g.frontmatter?.country || profile?.country || "";
  if (g.exists) {
    const mode = g.sourceMode || g.frontmatter?.source_mode || g.frontmatter?.sourceMode || "live";
    if (g.stale || mode === "fallback_snapshot") {
      dot.classList.add("is-fallback");
      label.textContent = `${country ? country + " · " : ""}Guidelines (${g.stale ? "Stale" : "Snapshot"})`;
    } else {
      label.textContent = `${country ? country + " · " : ""}Official Guidelines Synced`;
    }
  } else {
    dot.classList.add("is-missing");
    label.textContent = `${country ? country + " · " : ""}Guidelines Not Synced`;
  }
}

function renderOverview(data) {
  const overview = data.overview || {};
  const profile = data.profile;
  const counts = overview.counts || {};
  const activeDocs = counts.activeDocuments ?? data.timeline?.activeDocuments ?? (data.timeline?.events || []).filter(e => !e.isSuperseded).length;
  const supersededDocs = counts.supersededDocuments ?? data.timeline?.supersededDocuments ?? 0;
  const providersCount = (overview.providers || []).length || new Set((data.timeline?.events || []).map(e => e.provider)).size;
  const bioCount = data.biomarkers?.totalBiomarkers ?? getAllBiomarkers().length;
  const obsCount = counts.activeObservations ?? data.biomarkers?.totalActiveObservations ?? 0;
  const flags = overview.abnormalFlags || [];
  const skippedDocs = data.skippedDocuments || overview.skippedDocuments || [];

  byId("overview-eyebrow").textContent = profile?.fullName
    ? `Personal Clinical Record / ${profile.fullName}`
    : "Personal Clinical Record / Longitudinal Overview";

  const changes = overview.recentChanges || [];
  if (activeDocs === 0) {
    byId("overview-headline").textContent = "No lab reports ingested yet";
    byId("overview-summary").textContent = "Upload a lab PDF or photo above to build your evidence-linked personal health timeline.";
  } else {
    byId("overview-headline").textContent = profile?.fullName
      ? `${profile.fullName.split(/\s+/)[0]}’s Health Timeline`
      : "Longitudinal Health Timeline";

    const span = overview.earliestCollectionDate && overview.latestCollectionDate
      ? overview.earliestCollectionDate === overview.latestCollectionDate
        ? `Recorded on ${formatDate(overview.latestCollectionDate)}`
        : `${formatDate(overview.earliestCollectionDate)} – ${formatDate(overview.latestCollectionDate)}`
      : `${activeDocs} active ${activeDocs === 1 ? "study" : "studies"}`;

    const leadParts = [
      `${span} across ${providersCount} ${providersCount === 1 ? "provider" : "providers"} · ${bioCount} normalized biomarkers.`,
    ];
    if (changes.length > 0) {
      const top = changes[0];
      const deltaStr = formatSignedDelta(top.absoluteChange ?? top.delta, top.unit || top.normalizedUnit || "");
      if (deltaStr) {
        leadParts.push(`Latest shift: ${top.displayName || top.canonicalKey} (${deltaStr}).`);
      }
    }
    byId("overview-summary").textContent = leadParts.join(" ");
  }

  // 4 ADS KPI Metric Cards
  byId("stat-studies").textContent = String(activeDocs);
  byId("stat-providers").textContent = String(providersCount);
  byId("kpi-providers-badge").textContent = `${providersCount} ${providersCount === 1 ? "provider" : "providers"}`;
  byId("kpi-studies-foot").textContent = supersededDocs > 0
    ? `${supersededDocs} PARCIAL superseded by FINAL · collection-date sorted`
    : "Ordered strictly by sample collection date";

  byId("stat-biomarkers").textContent = String(bioCount);
  byId("kpi-obs-badge").textContent = `${obsCount} pts`;

  byId("stat-flagged").textContent = String(flags.length);
  const flagsCard = byId("kpi-flags-card");
  const flagsBadge = byId("kpi-flags-badge");
  flagsCard.classList.toggle("has-flags", flags.length > 0);
  flagsBadge.textContent = flags.length > 0 ? "ATTENTION" : "IN RANGE";
  flagsBadge.className = flags.length > 0 ? "lozenge lozenge-danger" : "lozenge lozenge-success";

  byId("stat-skipped").textContent = String(skippedDocs.length);
  const gateCard = byId("stat-skipped-box");
  const gateBadge = byId("kpi-gate-badge");
  gateCard.classList.toggle("has-skipped", skippedDocs.length > 0);
  gateBadge.textContent = skippedDocs.length > 0 ? "0 STORED" : "PROTECTED";
  gateBadge.className = skippedDocs.length > 0 ? "lozenge lozenge-danger" : "lozenge lozenge-success";
  byId("kpi-gate-foot").textContent = skippedDocs.length > 0
    ? `${skippedDocs.length} non-owner report blocked · 0 observations stored`
    : "All imported reports verified against patient profile";

  byId("stat-strip").hidden = false;

  // Section Message 1: Recent Changes
  const changesList = byId("changes-list");
  changesList.replaceChildren();
  byId("changes-count").textContent = String(changes.length);
  if (!changes.length) {
    changesList.append(el("li", "msg-empty", "Two or more dated readings per biomarker are needed to compute longitudinal deltas."));
  } else {
    for (const ch of changes.slice(0, 3)) {
      const li = el("li");
      const btn = el("button", "msg-item-btn");
      btn.type = "button";
      const left = el("span", "msg-item-title", ch.displayName || ch.canonicalKey);
      const fromV = formatNum(ch.fromValue ?? ch.previousValue);
      const toV = formatNum(ch.toValue ?? ch.latestValue);
      const unit = ch.unit || ch.normalizedUnit || "";
      left.append(el("span", "msg-item-sub", `${fromV} → ${toV} ${unit}`.trim()));
      const deltaText = formatSignedDelta(ch.absoluteChange ?? ch.delta, unit);
      btn.append(left, el("span", "msg-item-metric", deltaText));
      btn.addEventListener("click", () => {
        if (ch.canonicalKey) selectBiomarker(ch.canonicalKey, true);
      });
      li.append(btn);
      changesList.append(li);
    }
  }

  // Section Message 2: Out-of-Range Flags
  const flagsList = byId("flags-list");
  flagsList.replaceChildren();
  const flagsCountEl = byId("flags-count");
  flagsCountEl.textContent = String(flags.length);
  flagsCountEl.className = flags.length ? "lozenge lozenge-danger" : "lozenge lozenge-success";
  byId("flags-msg-card").className = flags.length
    ? "section-msg section-msg-danger"
    : "section-msg section-msg-success";

  if (!flags.length) {
    flagsList.append(el("li", "msg-empty", "No active out-of-range measurements flagged against printed lab reference ranges."));
  } else {
    for (const fl of flags.slice(0, 3)) {
      const li = el("li");
      const btn = el("button", "msg-item-btn");
      btn.type = "button";
      const title = fl.specimen && fl.specimen !== "serum" && fl.specimen !== "blood"
        ? `${fl.displayName || fl.canonicalKey} (${fl.specimen})`
        : (fl.displayName || fl.canonicalKey);
      const left = el("span", "msg-item-title", title);
      left.append(el("span", "msg-item-sub", `${formatDate(fl.collectedAt)} · Lab ref ${fl.refText || "—"}`));
      const valText = `${fl.valueText || formatNum(fl.normalizedValue ?? fl.valueNum)} ${fl.unitRaw || fl.normalizedUnit || ""}`.trim();
      const metric = el("span", `msg-item-metric is-${String(fl.flag || "high").toLowerCase()}`, `${valText} · ${flagLabel(fl.flag)}`);
      btn.append(left, metric);
      btn.addEventListener("click", () => {
        if (fl.canonicalKey) {
          selectBiomarker(fl.canonicalKey, false).then(() => {
            if (fl.observationId) selectObservation(fl.observationId, true);
          });
        } else if (fl.observationId) {
          selectObservation(fl.observationId, true);
        }
      });
      li.append(btn);
      flagsList.append(li);
    }
  }

  // Section Message 3: Findings & Follow-ups
  const followups = overview.followups || [];
  const findings = data.findings || [];
  const combined = [...followups, ...findings.filter(f => !followups.some(u => u.id && u.id === f.id))];
  const findingsList = byId("findings-list");
  findingsList.replaceChildren();
  byId("findings-count").textContent = String(combined.length);

  if (!followups.length) {
    findingsList.append(
      el("li", "msg-empty", overview.followupsNote || "No documented follow-up plan found in imported records.")
    );
  }
  for (const item of combined.slice(0, 3)) {
    const li = el("li");
    const box = el("button", "msg-item-btn");
    box.type = "button";
    const left = el("span", "msg-item-title", item.title || item.findingType || "Documented finding");
    const sub = item.followupPlan || item.summary || "";
    left.append(el("span", "msg-item-sub", `${formatDate(item.collectedAt)}${sub ? " · " + sub : ""}`));
    box.append(left, el("span", "lozenge lozenge-success", item.followupPlan ? "Follow-up" : "Finding"));
    box.addEventListener("click", () => {
      inspectDocumentEvidence(item.documentId, item.page || 1, {
        title: item.title || "Documented finding",
        excerpt: item.excerpt || item.summary || "",
        bbox: item.bbox || null,
      }, true);
    });
    li.append(box);
    findingsList.append(li);
  }

  byId("summary-grid").hidden = false;
}

function renderPanelTabs() {
  const container = byId("panel-tabs");
  container.replaceChildren();
  const panels = state.dashboard?.biomarkers?.panels || [];
  const allCount = getAllBiomarkers().length;

  const tabs = [{ panel: "All", count: allCount }];
  for (const p of panels) {
    tabs.push({ panel: p.panel || "Other", count: (p.biomarkers || []).length });
  }

  for (const tab of tabs) {
    const btn = el("button", "panel-tab");
    btn.type = "button";
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(state.selectedPanel === tab.panel));
    btn.append(
      el("span", "", tab.panel),
      el("span", "panel-tab-count", String(tab.count))
    );
    btn.addEventListener("click", () => {
      state.selectedPanel = tab.panel;
      renderPanelTabs();
      renderBiomarkerList();
    });
    container.append(btn);
  }
}

function renderBiomarkerList() {
  const container = byId("biomarker-list");
  container.replaceChildren();

  const all = getAllBiomarkers();
  const nameCounts = new Map();
  for (const b of all) {
    const norm = (b.displayName || "").toLowerCase();
    nameCounts.set(norm, (nameCounts.get(norm) || 0) + 1);
  }

  const query = state.searchQuery.trim().toLowerCase();
  const filtered = all.filter(bio => {
    if (state.selectedPanel !== "All" && (bio.panel || "Other") !== state.selectedPanel) {
      return false;
    }
    if (!query) return true;
    return (
      (bio.displayName || "").toLowerCase().includes(query) ||
      (bio.canonicalKey || "").toLowerCase().includes(query) ||
      (bio.specimen || "").toLowerCase().includes(query) ||
      (bio.panel || "").toLowerCase().includes(query)
    );
  });

  if (!filtered.length) {
    container.append(el("span", "msg-empty", "No matching biomarkers in this panel."));
    return;
  }

  for (const bio of filtered) {
    const btn = el("button", "bio-chip");
    btn.type = "button";
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(state.selectedKey === bio.canonicalKey));

    const dotClass = isAbnormalFlag(bio.latestFlag)
      ? "bio-dot is-abnormal"
      : String(bio.latestFlag || "").toLowerCase() === "normal"
        ? "bio-dot is-normal"
        : "bio-dot";
    const dot = el("span", dotClass);
    if (bio.latestFlag && bio.latestFlag !== "unknown") {
      dot.title = `Latest status: ${bio.latestFlag}`;
    }
    btn.append(dot);

    btn.append(el("span", "", bio.displayName || bio.canonicalKey));

    const showSpecimen = (nameCounts.get((bio.displayName || "").toLowerCase()) || 0) > 1
      || bio.specimen === "urine";
    if (showSpecimen && bio.specimen) {
      btn.append(el("span", "lozenge lozenge-neutral", bio.specimen));
    }

    const latestVal = bio.latestNormalizedValue !== null && bio.latestNormalizedValue !== undefined
      ? `${formatNum(bio.latestNormalizedValue)} ${bio.latestNormalizedUnit || bio.latestUnit || ""}`.trim()
      : (bio.latestValueText ? String(bio.latestValueText).slice(0, 14) : "");
    if (latestVal) {
      btn.append(el("span", "bio-val", latestVal));
    }

    if (bio.count) {
      btn.append(el("span", "bio-count", String(bio.count)));
    }

    btn.addEventListener("click", () => selectBiomarker(bio.canonicalKey, false));
    container.append(btn);
  }
}

async function selectBiomarker(canonicalKey, scrollIntoView = false) {
  if (!canonicalKey) return;
  state.selectedKey = canonicalKey;
  renderBiomarkerList();

  let trend = state.trendCache.get(canonicalKey);
  if (!trend) {
    try {
      const res = await fetch(`/api/trend?key=${encodeURIComponent(canonicalKey)}`);
      if (res.ok) {
        trend = await res.json();
        state.trendCache.set(canonicalKey, trend);
      }
    } catch (err) {
      console.error("Failed to fetch trend:", err);
    }
  }

  state.selectedTrend = trend || null;
  if (trend) {
    for (const pt of [...(trend.points || []), ...(trend.omitted || [])]) {
      if (pt.observationId && !state.obsById.has(String(pt.observationId))) {
        state.obsById.set(String(pt.observationId), {
          ...pt,
          canonicalKey: trend.canonicalKey,
          displayName: trend.displayName,
          specimen: trend.specimen,
          panel: trend.panel,
          regionalTarget: trend.regionalTarget || null,
        });
      }
    }
    renderTrend(trend);

    const trendPoints = trend.points || [];
    if (trendPoints.length && !trendPoints.some(p => String(p.observationId) === String(state.selectedObsId))) {
      await selectObservation(trendPoints.at(-1).observationId, false);
    }
  }

  if (scrollIntoView) {
    document.querySelector(".explorer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function niceAxisBounds(minVal, maxVal) {
  if (!Number.isFinite(minVal) || !Number.isFinite(maxVal)) return { lowest: 0, highest: 100, step: 25 };
  let low = minVal;
  let high = maxVal;
  if (low === high) {
    const pad = Math.max(Math.abs(low) * 0.2, 1);
    low -= pad;
    high += pad;
  } else {
    const pad = (high - low) * 0.16;
    low -= pad;
    high += pad;
  }
  if (minVal >= 0 && low < 0) low = 0;

  const span = high - low;
  const rawStep = span / 4;
  const mag = 10 ** Math.floor(Math.log10(rawStep || 1));
  const norm = rawStep / mag;
  const niceNorm = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  const step = niceNorm * mag;

  const lowest = Math.floor(low / step) * step;
  const highest = Math.ceil(high / step) * step;
  return { lowest: minVal >= 0 ? Math.max(0, lowest) : lowest, highest, step };
}

function renderTrend(trend) {
  byId("trend-title").textContent = trend.displayName || trend.canonicalKey;
  const specEl = byId("trend-specimen");
  if (trend.specimen) {
    specEl.textContent = trend.specimen;
    specEl.hidden = false;
  } else {
    specEl.hidden = true;
  }

  const points = trend.points || [];
  const numericPoints = points
    .filter(p => p.normalizedValue !== null && p.normalizedValue !== undefined && !Number.isNaN(Number(p.normalizedValue)) && parseIsoDate(p.collectedAt) !== null)
    .sort((a, b) => parseIsoDate(a.collectedAt) - parseIsoDate(b.collectedAt));

  const providers = [...new Set(points.map(p => p.provider).filter(Boolean))];
  const unitLabel = trend.normalizedUnit || points.at(-1)?.unitRaw || "";
  byId("trend-subtitle").textContent = [
    trend.panel || "Biomarker",
    unitLabel || "Qualitative",
    `${points.length} ${points.length === 1 ? "result" : "results"}`,
    providers.length ? `${providers.length} ${providers.length === 1 ? "provider" : "providers"}` : "",
  ].filter(Boolean).join(" · ");

  const latestEl = byId("trend-latest");
  const deltaEl = byId("trend-delta");
  const latestPt = numericPoints.at(-1) || points.at(-1);
  if (latestPt) {
    const valStr = latestPt.normalizedValue !== null && latestPt.normalizedValue !== undefined
      ? `${formatNum(latestPt.normalizedValue)} ${latestPt.normalizedUnit || unitLabel}`.trim()
      : `${latestPt.valueText || "—"} ${latestPt.unitRaw || ""}`.trim();
    latestEl.textContent = valStr;
    latestEl.hidden = false;
  } else {
    latestEl.hidden = true;
  }

  if (trend.change && trend.change.absolute !== null && trend.change.absolute !== undefined) {
    const abs = Number(trend.change.absolute);
    deltaEl.textContent = formatSignedDelta(abs, unitLabel);
    deltaEl.className = "lozenge delta-lozenge " + (abs > 0 ? "lozenge-warning" : abs < 0 ? "lozenge-success" : "lozenge-neutral");
    deltaEl.hidden = false;
  } else {
    deltaEl.hidden = true;
  }

  const latestWithRef = [...numericPoints].reverse().find(p => p.refLow !== null || p.refHigh !== null);
  const labRange = latestWithRef
    ? { low: latestWithRef.refLow, high: latestWithRef.refHigh, text: latestWithRef.refText }
    : null;
  const regTarget = normalizeTargetBand(trend.regionalTarget);

  // Legend
  const legend = byId("chart-legend");
  legend.replaceChildren();
  for (const prov of providers) {
    const item = el("span", "legend-item");
    const dot = el("span", "legend-dot");
    dot.style.background = getProviderColor(prov);
    item.append(dot, document.createTextNode(prov));
    legend.append(item);
  }
  if (labRange && (labRange.low !== null || labRange.high !== null)) {
    const item = el("span", "legend-item");
    item.append(el("span", "legend-swatch legend-swatch-lab"), document.createTextNode(`Lab reference (${labRange.text || "assay range"})`));
    legend.append(item);
  }
  if (regTarget && (regTarget.low !== null || regTarget.high !== null || regTarget.text)) {
    const item = el("span", "legend-item");
    const shortTag = regTarget.guidelineId
      ? `${regTarget.guidelineId.split("-").slice(0, 2).join("-")} ${regTarget.shortBound}`
      : `Regional target ${regTarget.shortBound}`;
    const citeBtn = el("button", "legend-cite-btn", shortTag);
    citeBtn.type = "button";
    citeBtn.addEventListener("click", openGuidelinesModal);
    item.append(el("span", "legend-swatch legend-swatch-regional"), citeBtn);
    legend.append(item);
  }
  legend.hidden = legend.childNodes.length === 0;

  // Plot
  const root = byId("chart");
  root.replaceChildren();
  if (state.chartObserver) {
    state.chartObserver.disconnect();
    state.chartObserver = null;
  }

  if (!numericPoints.length) {
    const msg = points.length
      ? `Qualitative result: ${points.map(p => `${formatDate(p.collectedAt)}: ${p.valueText}`).join(" · ")}. Inspect the study row below to verify source evidence.`
      : "No comparable numeric measurements with a verified collection date.";
    root.append(el("div", "chart-empty", msg));
  } else {
    const plot = el("div", "plot");
    root.append(plot);

    const boundValues = numericPoints.map(p => Number(p.normalizedValue));
    if (labRange?.low !== null && labRange?.low !== undefined) boundValues.push(Number(labRange.low));
    if (labRange?.high !== null && labRange?.high !== undefined) boundValues.push(Number(labRange.high));
    if (regTarget?.low !== null && regTarget?.low !== undefined) boundValues.push(Number(regTarget.low));
    if (regTarget?.high !== null && regTarget?.high !== undefined) boundValues.push(Number(regTarget.high));

    const { lowest, highest, step } = niceAxisBounds(Math.min(...boundValues), Math.max(...boundValues));
    const yPos = v => {
      const ratio = (highest - v) / (highest - lowest || 1);
      return Math.max(0, Math.min(1, ratio));
    };

    for (let tickVal = lowest; tickVal <= highest + step * 0.001; tickVal += step) {
      const axis = el("div", "axis");
      axis.setAttribute("aria-hidden", "true");
      axis.style.top = (yPos(tickVal) * 100) + "%";
      axis.append(el("span", "tick", formatNum(tickVal)));
      plot.append(axis);
    }

    // Lab Reference Range Band (subtle translucent green)
    if (labRange && (labRange.low !== null || labRange.high !== null)) {
      const bandLow = labRange.low !== null ? Number(labRange.low) : lowest;
      const bandHigh = labRange.high !== null ? Number(labRange.high) : highest;
      const topPct = yPos(bandHigh) * 100;
      const bottomPct = yPos(bandLow) * 100;
      const heightPct = Math.max(0.8, bottomPct - topPct);
      const band = el("div", "band band-lab");
      band.style.top = `${topPct}%`;
      band.style.height = `${heightPct}%`;
      band.append(el("span", "band-tag", `Lab ref: ${labRange.text || `${formatNum(bandLow)}–${formatNum(bandHigh)}`}`));
      plot.append(band);
    }

    // Regional Clinical Target Line / Band (ADS Discovery Purple #6E5DC6)
    let regPillTag = null;
    let regLineY = null;
    if (regTarget && (regTarget.low !== null || regTarget.high !== null)) {
      const shortGuideline = regTarget.guidelineId
        ? regTarget.guidelineId.split("-").slice(0, 2).join("-")
        : (state.dashboard?.guidelines?.frontmatter?.country || state.dashboard?.profile?.country || "Regional");
      const tagText = `${shortGuideline} ${regTarget.shortBound}`;

      if (regTarget.low !== null && regTarget.high !== null) {
        regLineY = yPos(regTarget.high);
        const topPct = regLineY * 100;
        const bottomPct = yPos(regTarget.low) * 100;
        const band = el("div", "band band-regional-area");
        band.style.top = `${topPct}%`;
        band.style.height = `${Math.max(1, bottomPct - topPct)}%`;
        regPillTag = el("span", "regional-pill-tag", tagText);
        band.append(regPillTag);
        plot.append(band);
      } else {
        const threshold = regTarget.high !== null ? regTarget.high : regTarget.low;
        regLineY = yPos(threshold);
        const line = el("div", "band-regional-line");
        line.style.top = `${regLineY * 100}%`;
        regPillTag = el("span", "regional-pill-tag", tagText);
        line.append(regPillTag);
        plot.append(line);
      }
    }

    const canvas = el("canvas");
    canvas.setAttribute("aria-hidden", "true");
    plot.append(canvas);

    const timestamps = numericPoints.map(p => parseIsoDate(p.collectedAt));
    const minTs = timestamps[0];
    const maxTs = timestamps.at(-1);
    const spanTs = maxTs - minTs;

    const dateTags = [];
    const coords = numericPoints.map((pt, idx) => {
      let x;
      if (numericPoints.length === 1) {
        x = 0.5;
      } else if (spanTs > 0) {
        x = 0.08 + 0.84 * ((timestamps[idx] - minTs) / spanTs);
      } else {
        x = 0.14 + 0.72 * (idx / (numericPoints.length - 1));
      }
      const y = yPos(Number(pt.normalizedValue));

      // Smart label placement to avoid clipping at top edge
      const placeBelow = y < 0.12;

      const btn = el("button", "point" + (isAbnormalFlag(pt.flag) ? " is-abnormal" : "") + (placeBelow ? " label-below" : ""));
      btn.type = "button";
      btn.dataset.obs = String(pt.observationId);
      btn.style.left = `${x * 100}%`;
      btn.style.top = `${y * 100}%`;
      btn.style.setProperty("--point-color", getProviderColor(pt.provider));
      btn.setAttribute("aria-controls", "evidence");
      btn.setAttribute("aria-pressed", String(String(pt.observationId) === String(state.selectedObsId)));
      const prefix = pt.conversionFactor && pt.conversionFactor !== 1 ? "≈" : "";
      const valDisplay = `${prefix}${formatNum(pt.normalizedValue)}`;
      btn.setAttribute(
        "aria-label",
        `${formatDate(pt.collectedAt)}, ${pt.provider}, ${valDisplay} ${pt.normalizedUnit || unitLabel}`
      );
      btn.append(el("span", "point-value", valDisplay));
      btn.addEventListener("click", () => selectObservation(pt.observationId, true));

      const dateTag = el("span", "point-date", formatDate(pt.collectedAt, dateShort));
      dateTag.setAttribute("aria-hidden", "true");
      dateTag.style.left = `${x * 100}%`;
      dateTags.push({ el: dateTag, x, collectedAt: pt.collectedAt });

      plot.append(btn, dateTag);
      return { x, y, pt };
    });

    const layoutChartAnnotations = () => {
      const plotW = Math.max(1, plot.clientWidth);
      const isNarrow = plotW < 420;
      const minGap = isNarrow ? 64 : 78;

      // 1. Collision-free X-axis date labels (prioritize first & last)
      for (const item of dateTags) {
        item.el.textContent = formatDate(item.collectedAt, isNarrow ? dateCompact : dateShort);
        item.el.hidden = false;
        const px = item.x * plotW;
        if (px < 26) {
          item.el.style.left = "0%";
          item.el.style.transform = "translateX(0)";
        } else if (plotW - px < 26) {
          item.el.style.left = "100%";
          item.el.style.transform = "translateX(-100%)";
        } else {
          item.el.style.left = `${item.x * 100}%`;
          item.el.style.transform = "translateX(-50%)";
        }
      }

      if (dateTags.length > 1) {
        const lastIdx = dateTags.length - 1;
        const lastPx = dateTags[lastIdx].x * plotW;
        let lastShownPx = dateTags[0].x * plotW;
        for (let i = 1; i < lastIdx; i++) {
          const px = dateTags[i].x * plotW;
          if (px - lastShownPx < minGap || lastPx - px < minGap) {
            dateTags[i].el.hidden = true;
          } else {
            lastShownPx = px;
          }
        }
        if (lastPx - dateTags[0].x * plotW < minGap * 0.8) {
          dateTags[lastIdx].el.hidden = true;
        }
      }

      // 2. Keep regional target pill from colliding with dots (hide inline pill on narrow <520px since legend + callout display it cleanly)
      if (regPillTag && regLineY !== null) {
        if (plotW < 460) {
          regPillTag.hidden = true;
        } else {
          regPillTag.hidden = false;
          const leftCollision = coords.some(c => c.x < 0.34 && Math.abs(c.y - regLineY) < 0.18);
          regPillTag.classList.toggle("align-right-tag", leftCollision);
        }
      }
    };

    const drawLines = () => {
      layoutChartAnnotations();
      const ratio = window.devicePixelRatio || 1;
      const w = Math.max(1, plot.clientWidth);
      const h = Math.max(1, plot.clientHeight);
      canvas.width = Math.round(w * ratio);
      canvas.height = Math.round(h * ratio);
      const ctx = canvas.getContext("2d");
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (coords.length < 2) return;

      // Subtle translucent ADS Blue fill under curve
      ctx.save();
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, "rgba(12, 102, 228, 0.10)");
      grad.addColorStop(1, "rgba(12, 102, 228, 0.0)");
      ctx.beginPath();
      ctx.moveTo(coords[0].x * canvas.width, coords[0].y * canvas.height);
      for (let i = 1; i < coords.length; i++) {
        ctx.lineTo(coords[i].x * canvas.width, coords[i].y * canvas.height);
      }
      ctx.lineTo(coords.at(-1).x * canvas.width, canvas.height);
      ctx.lineTo(coords[0].x * canvas.width, canvas.height);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.restore();

      for (let i = 1; i < coords.length; i++) {
        const a = coords[i - 1];
        const b = coords[i];
        const methodChanged = a.pt.method && b.pt.method && a.pt.method !== b.pt.method;
        const providerChanged = a.pt.provider !== b.pt.provider;
        ctx.save();
        ctx.strokeStyle = "#0C66E4";
        ctx.lineWidth = 2.4 * ratio;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        if (methodChanged || providerChanged) {
          ctx.setLineDash([6 * ratio, 5 * ratio]);
        }
        ctx.beginPath();
        ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
        ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
        ctx.stroke();
        ctx.restore();
      }
    };

    state.chartObserver = new ResizeObserver(drawLines);
    state.chartObserver.observe(plot);
    drawLines();
  }

  // ADS Section Message Callouts
  const callouts = byId("chart-callouts");
  callouts.replaceChildren();

  const methods = [...new Set(numericPoints.map(p => p.method).filter(Boolean))];
  if (methods.length > 1) {
    const box = el("div", "callout-msg callout-msg-warning");
    const txt = el("div");
    txt.append(
      el("strong", "", "Method shift detected: "),
      document.createTextNode(`${methods.join(" → ")}. Interpret cross-period deltas alongside each report’s assay method.`)
    );
    box.append(svgIcon("warning"), txt);
    callouts.append(box);
  }

  const converted = numericPoints.filter(p => p.conversionFactor && p.conversionFactor !== 1);
  if (converted.length) {
    const sample = converted[0];
    const box = el("div", "callout-msg callout-msg-info");
    const txt = el("div");
    txt.append(
      el("strong", "", "Cross-lab unit conversion: "),
      document.createTextNode(`${sample.valueText || sample.valueNum} ${sample.unitRaw} × ${sample.conversionFactor} = ${formatNum(sample.normalizedValue)} ${sample.normalizedUnit}.`)
    );
    box.append(svgIcon("info"), txt);
    callouts.append(box);
  }

  if (regTarget && (regTarget.text || regTarget.citation)) {
    const box = el("div", "callout-msg callout-msg-discovery");
    const txt = el("div");
    const cleanCite = regTarget.citation ? regTarget.citation.replace(/\.+$/, "") : "";
    const summaryText = `${regTarget.text}${regTarget.unit && !regTarget.text.includes(regTarget.unit) ? " " + regTarget.unit : ""}${cleanCite ? " — " + cleanCite : ""}`.replace(/\.+$/, "");
    txt.append(
      el("strong", "", "Regional clinical target: "),
      document.createTextNode(`${summaryText}. `)
    );
    const link = el("button", "legend-cite-btn", "View official guidelines");
    link.type = "button";
    link.addEventListener("click", openGuidelinesModal);
    txt.append(link);
    box.append(svgIcon("discovery"), txt);
    callouts.append(box);
  }

  if ((trend.omitted || []).length) {
    const box = el("div", "callout-msg callout-msg-warning");
    const txt = el("div", "", `${trend.omitted.length} record${trend.omitted.length === 1 ? "" : "s"} excluded from this chart due to missing collection date or non-comparable ratio/unit.`);
    box.append(svgIcon("warning"), txt);
    callouts.append(box);
  }
}

function renderTimeline(data) {
  const events = data?.timeline?.events || [];
  const selectEl = byId("provider-filter");
  const existingProviders = [...new Set(events.map(e => e.provider).filter(Boolean))];
  selectEl.replaceChildren(el("option", "", "All providers"));
  selectEl.firstChild.value = "all";
  for (const prov of existingProviders) {
    const opt = el("option", "", prov);
    opt.value = prov;
    selectEl.append(opt);
  }
  selectEl.value = existingProviders.includes(state.providerFilter) ? state.providerFilter : "all";

  const filtered = state.providerFilter === "all"
    ? events
    : events.filter(e => e.provider === state.providerFilter);

  byId("timeline-total").textContent = `${filtered.length} ${filtered.length === 1 ? "report" : "reports"}`;

  const list = byId("timeline-list");
  list.replaceChildren();

  if (!filtered.length) {
    list.append(el("li", "study-row msg-empty", "No studies match the current provider filter."));
  } else {
    const supersededByMap = new Map();
    for (const ev of events) {
      if (ev.supersededBy) {
        if (!supersededByMap.has(ev.supersededBy)) supersededByMap.set(ev.supersededBy, []);
        supersededByMap.get(ev.supersededBy).push(ev);
      }
    }

    for (const ev of filtered) {
      const li = el("li", "study-row" + (ev.documentId === state.selectedDocId ? " is-selected" : ""));
      li.dataset.doc = ev.documentId;

      const main = el("div", "study-row-main");

      // Col 1: Collection date + printed date
      const dateCol = el("div", "study-date-col");
      dateCol.append(
        el("strong", "", ev.collectedAt ? formatDate(ev.collectedAt) : "Date missing"),
        el("small", "", ev.reportedAt ? `Issued ${formatDate(ev.reportedAt, dateShort)}` : "Issue date N/A")
      );

      // Col 2: Provider Lozenge + order + filename
      const provCol = el("div", "study-provider-col");
      const provTop = el("div", "study-provider-top");
      provTop.append(el("span", getProviderLozengeClass(ev.provider), ev.provider || "Unknown lab"));
      if (ev.orderNumber) {
        provTop.append(el("span", "lozenge lozenge-neutral", `#${ev.orderNumber}`));
      }
      provCol.append(provTop);
      provCol.append(el("span", "study-filename", ev.filename || ev.docType || ""));

      // Col 3: Status Lozenges
      const statusCol = el("div", "study-status-col");
      if (ev.reportStatus) {
        const statusNorm = String(ev.reportStatus).toUpperCase();
        const cls = ev.isSuperseded
          ? "lozenge lozenge-superseded"
          : statusNorm === "PARCIAL" ? "lozenge lozenge-warning" : "lozenge lozenge-success";
        statusCol.append(el("span", cls, ev.isSuperseded ? `${statusNorm} · SUPERSEDED` : statusNorm));
      }
      if (supersededByMap.has(ev.documentId)) {
        statusCol.append(el("span", "lozenge lozenge-info", "SUPERSEDES PARCIAL"));
      }

      // Col 4: Measurements & Flags
      const resCol = el("div", "study-results-col");
      if (ev.observationsCount) {
        resCol.append(el("span", "lozenge lozenge-neutral", `${ev.observationsCount} markers`));
      }
      if (ev.abnormalCount > 0) {
        resCol.append(el("span", "lozenge lozenge-danger", `${ev.abnormalCount} flagged`));
      }

      // Col 5: Action
      const actCol = el("div", "study-action-col");
      const inspectBtn = el("button", "ads-btn ads-btn-subtle ads-btn-sm", "Inspect PDF");
      inspectBtn.type = "button";
      inspectBtn.addEventListener("click", () => {
        const docObs = state.obsByDoc.get(ev.documentId) || [];
        if (docObs.length) {
          selectObservation(docObs[0].observationId, true);
        } else {
          inspectDocumentEvidence(ev.documentId, 1, { title: ev.filename || ev.provider }, true);
        }
      });
      actCol.append(inspectBtn);

      main.append(dateCol, provCol, statusCol, resCol, actCol);
      li.append(main);

      // Expandable measurements
      const docObs = state.obsByDoc.get(ev.documentId) || [];
      if (docObs.length) {
        const details = el("details", "study-obs-details");
        details.append(el("summary", "", `View ${docObs.length} extracted measurement${docObs.length === 1 ? "" : "s"}`));
        const grid = el("div", "study-obs-grid");
        for (const obs of docObs) {
          const chip = el("button", "obs-chip-btn" + (isAbnormalFlag(obs.flag) ? " is-abnormal" : ""));
          chip.type = "button";
          chip.dataset.obs = String(obs.observationId);
          chip.setAttribute("aria-pressed", String(String(obs.observationId) === String(state.selectedObsId)));
          const label = obs.specimen === "urine" ? `${obs.displayName} (urine)` : obs.displayName;
          const val = obs.valueText || `${formatNum(obs.normalizedValue ?? obs.valueNum)} ${obs.unitRaw || obs.normalizedUnit || ""}`.trim();
          chip.append(
            el("span", "obs-chip-name", label),
            el("span", "obs-chip-val", `${val}${obs.unitRaw && !String(val).includes(obs.unitRaw) ? " " + obs.unitRaw : ""}`.trim())
          );
          chip.addEventListener("click", () => {
            if (obs.canonicalKey && obs.canonicalKey !== state.selectedKey) {
              selectBiomarker(obs.canonicalKey, false);
            }
            selectObservation(obs.observationId, true);
          });
          grid.append(chip);
        }
        details.append(grid);
        li.append(details);
      }

      list.append(li);
    }
  }

  // Receipt vs collection order comparison
  const receiptEntries = [];
  for (const ev of events) {
    if (ev.deliveries && ev.deliveries.length) {
      for (const del of ev.deliveries) {
        receiptEntries.push({
          date: del.received,
          label: `${formatDate(del.received)} · ${ev.provider} · ${del.channel || "delivery"} (collected ${formatDate(ev.collectedAt)})`,
        });
      }
    } else if (ev.receivedAt || ev.reportedAt) {
      const dt = ev.receivedAt || ev.reportedAt;
      const kind = ev.receivedAt ? "received" : "reported/printed";
      receiptEntries.push({
        date: dt,
        label: `${formatDate(dt)} (${kind}) · ${ev.provider} · ${ev.filename} (collected ${formatDate(ev.collectedAt)})`,
      });
    }
  }
  receiptEntries.sort((a, b) => (parseIsoDate(a.date) || 0) - (parseIsoDate(b.date) || 0));

  const receiptsDetails = byId("receipts-details");
  const receiptList = byId("receipt-list");
  receiptList.replaceChildren();
  for (const entry of receiptEntries) {
    receiptList.append(el("li", "", entry.label));
  }
  receiptsDetails.hidden = receiptEntries.length === 0;
}

function renderIntegrityCards(data) {
  // 1. Patient Identity Gate (Skipped Docs)
  const skipped = data.skippedDocuments || data.overview?.skippedDocuments || [];
  const skippedList = byId("skipped-list");
  skippedList.replaceChildren();
  const badge = byId("skipped-badge");

  if (!skipped.length) {
    badge.textContent = "0 BLOCKED · PROTECTED";
    badge.className = "lozenge lozenge-success";
    skippedList.append(
      el("li", "integrity-item", "No non-owner documents detected. Every imported document matched the configured patient profile.")
    );
  } else {
    badge.textContent = `${skipped.length} BLOCKED · 0 STORED`;
    badge.className = "lozenge lozenge-danger";
    for (const doc of skipped) {
      const li = el("li", "integrity-item integrity-item-skipped");
      const content = el("div");
      const head = el("div", "integrity-item-head");
      head.append(
        el("strong", "", doc.filename || "Unnamed file"),
        el("span", "lozenge lozenge-danger", "BLOCKED · 0 STORED")
      );
      const rawPatient = String(doc.patientNameRaw || doc.patient_name_raw || "Unrecognized")
        .replace(/\s*FECHA[\s\S]*$/i, "")
        .trim();
      content.append(
        head,
        el("small", "", `Provider: ${doc.provider || "Unknown lab"} · Detected patient: ${rawPatient || "Unrecognized"}`),
        el("small", "", `Reason: ${doc.reason || "Patient identity mismatch"}`)
      );
      li.append(svgIcon("danger"), content);
      skippedList.append(li);
    }
  }

  // 2. Needs Review Queue
  const reviewItems = data.reviewItems || data.overview?.reviewItems || [];
  const reviewList = byId("review-list");
  reviewList.replaceChildren();
  const revCount = byId("review-count");
  revCount.textContent = String(reviewItems.length);
  revCount.className = reviewItems.length ? "lozenge lozenge-warning" : "lozenge lozenge-success";

  if (!reviewItems.length) {
    reviewList.append(
      el("li", "integrity-item", "No open review items. All extracted records passed normalization, unit, and date checks.")
    );
  } else {
    for (const item of reviewItems) {
      const li = el("li");
      const btn = el("button", "integrity-item integrity-item-btn");
      btn.type = "button";
      const code = String(item.code || "REVIEW").replace(/_/g, " ");
      const doc = item.documentId ? state.docById.get(item.documentId) : null;
      const head = el("div", "integrity-item-head");
      head.append(el("span", "lozenge lozenge-warning", code));
      if (doc?.provider) head.append(el("span", getProviderLozengeClass(doc.provider), doc.provider));
      btn.append(head, el("small", "", item.message || "Requires review"));
      btn.addEventListener("click", () => {
        if (item.observationId) {
          selectObservation(item.observationId, true);
        } else if (item.documentId) {
          inspectDocumentEvidence(item.documentId, item.details?.page || 1, {
            title: code,
            excerpt: item.message,
          }, true);
        }
      });
      li.append(btn);
      reviewList.append(li);
    }
  }
}

function updateEvidencePageDisplay() {
  const ev = state.evidenceState;
  if (!ev) return;

  const img = byId("ev-page-image");
  const fallback = byId("ev-image-fallback");
  const marker = byId("ev-line-marker");
  const pageNav = byId("ev-page-nav");
  const pageInd = byId("ev-page-indicator");
  const prevBtn = byId("ev-page-prev");
  const nextBtn = byId("ev-page-next");
  const sourceLink = byId("ev-source-link");
  const sourceLinkTop = byId("ev-source-link-top");
  const labelEl = byId("ev-source-label");

  const page = Math.max(1, Number(ev.page || 1));
  const totalPages = Math.max(1, Number(ev.pageCount || 1));

  labelEl.textContent = ev.lineIndex !== null && ev.lineIndex !== undefined && page === ev.highlightPage
    ? `${ev.label || "Evidence"} · Page ${page}, line ${ev.lineIndex}`
    : `${ev.label || "Report preview"} · Page ${page} of ${totalPages}`;

  pageNav.hidden = totalPages <= 1;
  pageInd.textContent = `${page} / ${totalPages}`;
  prevBtn.disabled = page <= 1;
  nextBtn.disabled = page >= totalPages;

  const pageImgUrl = `/evidence/${encodeURIComponent(ev.docId)}/page/${page}.png`;
  fallback.hidden = true;
  img.hidden = false;
  img.alt = `${ev.provider || "Lab"} report, page ${page} of ${totalPages}`;
  img.onerror = () => {
    img.hidden = true;
    marker.hidden = true;
    fallback.hidden = false;
  };
  img.onload = () => {
    img.hidden = false;
    fallback.hidden = true;
    const showBox = page === ev.highlightPage && Array.isArray(ev.bbox) && ev.bbox.length === 4;
    marker.hidden = !showBox;
    if (showBox) {
      const [left, top, width, height] = ev.bbox;
      Object.assign(marker.style, {
        left: `${left * 100}%`,
        top: `${top * 100}%`,
        width: `${width * 100}%`,
        height: `${height * 100}%`,
      });
    }
  };
  if (img.getAttribute("src") !== pageImgUrl) {
    marker.hidden = true;
    img.src = pageImgUrl;
  } else if (img.complete && img.naturalWidth > 0) {
    img.onload();
  }

  const excerptEl = byId("ev-excerpt");
  if (ev.excerpt) {
    excerptEl.textContent = ev.excerpt;
    excerptEl.hidden = false;
  } else {
    excerptEl.hidden = true;
  }

  if (ev.docId) {
    const href = `/evidence/${encodeURIComponent(ev.docId)}/source#page=${page}`;
    sourceLink.href = href;
    sourceLink.hidden = false;
    sourceLinkTop.href = href;
    sourceLinkTop.hidden = false;
  } else {
    sourceLink.hidden = true;
    sourceLinkTop.hidden = true;
  }
}

function updateSelectedHighlights() {
  for (const btn of document.querySelectorAll("button[data-obs]")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.obs === String(state.selectedObsId)));
  }
  for (const row of document.querySelectorAll(".study-row[data-doc]")) {
    row.classList.toggle("is-selected", row.dataset.doc === state.selectedDocId);
  }
}

function renderEvidenceMetadata(doc, obs) {
  const dl = byId("ev-dates");
  dl.replaceChildren();

  const addRow = (term, value, sub) => {
    const row = el("div", "date-row");
    const dd = el("dd", "", value || "Not recorded");
    if (sub) dd.append(el("span", "", sub));
    row.append(el("dt", "", term), dd);
    dl.append(row);
  };

  addRow("Collected", formatDate(obs?.collectedAt || doc?.collectedAt), "Primary timeline sort date");
  addRow("Reported", formatDate(obs?.reportedAt || doc?.reportedAt), "Lab issue / print timestamp");
  addRow("Received", formatDate(doc?.receivedAt || doc?.deliveries?.[0]?.received), doc?.deliveries?.[0]?.channel || "Inbox import timestamp");
  if (obs?.method) addRow("Method", obs.method);
  if (obs?.orderNumber || doc?.orderNumber) addRow("Order #", obs?.orderNumber || doc?.orderNumber);
  if (doc?.filename) addRow("File", doc.filename);
}

async function selectObservation(obsId, interact = false) {
  let obs = state.obsById.get(String(obsId));
  if (!obs || (obs.page === undefined && !obs.excerpt)) {
    try {
      const res = await fetch(`/api/evidence?obs=${encodeURIComponent(obsId)}`);
      if (res.ok) {
        const ev = await res.json();
        if (ev?.observation) {
          obs = {
            ...(obs || {}),
            ...ev.observation,
            provider: ev.document?.provider || obs?.provider,
            orderNumber: ev.document?.orderNumber || obs?.orderNumber,
            reportStatus: ev.document?.reportStatus || obs?.reportStatus,
            reportedAt: ev.document?.reportedAt || obs?.reportedAt,
            page: ev.page,
            lineIndex: ev.lineIndex,
            bbox: ev.bbox,
            excerpt: ev.excerpt,
          };
          state.obsById.set(String(obsId), obs);
        }
      }
    } catch {
      // Proceed with local obs if available.
    }
  }
  if (!obs) return;

  state.selectedObsId = String(obs.observationId);
  state.selectedDocId = obs.documentId || null;
  const doc = obs.documentId ? state.docById.get(obs.documentId) : null;

  byId("evidence-empty").hidden = true;
  byId("evidence-body").hidden = false;

  byId("ev-provider").textContent = obs.provider || doc?.provider || "Unknown lab";
  const statusPill = byId("ev-status-pill");
  const statusText = obs.reportStatus || doc?.reportStatus;
  if (statusText) {
    statusPill.textContent = statusText;
    statusPill.className = "lozenge " + (String(statusText).toUpperCase() === "PARCIAL" ? "lozenge-warning" : "lozenge-success");
    statusPill.hidden = false;
  } else {
    statusPill.hidden = true;
  }

  const specPill = byId("ev-specimen");
  if (obs.specimen) {
    specPill.textContent = obs.specimen;
    specPill.hidden = false;
  } else {
    specPill.hidden = true;
  }

  byId("ev-analyte-name").textContent = obs.displayName || obs.canonicalKey || "Measurement";
  const flagEl = byId("ev-flag-badge");
  const flLabel = flagLabel(obs.flag);
  if (flLabel) {
    flagEl.textContent = flLabel;
    flagEl.className = flagLozengeClass(obs.flag);
    flagEl.hidden = false;
  } else {
    flagEl.hidden = true;
  }

  const reportedText = obs.valueText
    ? `${obs.valueText}${obs.unitRaw && !String(obs.valueText).includes(obs.unitRaw) ? " " + obs.unitRaw : ""}`
    : (obs.valueNum !== null && obs.valueNum !== undefined ? `${formatNum(obs.valueNum)} ${obs.unitRaw || ""}`.trim() : "—");
  byId("ev-reported").textContent = reportedText;

  const normText = obs.normalizedValue !== null && obs.normalizedValue !== undefined
    ? `${formatNum(obs.normalizedValue)} ${obs.normalizedUnit || ""}`.trim()
    : reportedText;
  byId("ev-normalized").textContent = normText;
  byId("ev-lab-range").textContent = obs.refText
    ? `${obs.refText}${obs.unitRaw && !String(obs.refText).includes(obs.unitRaw) ? " " + obs.unitRaw : ""}`
    : "Not listed";

  const regTarget = normalizeTargetBand(obs.regionalTarget || state.selectedTrend?.regionalTarget);
  const regDd = byId("ev-regional-target");
  regDd.replaceChildren();
  if (regTarget && regTarget.shortBound) {
    regDd.append(document.createTextNode(`${regTarget.shortBound} `));
    const citeBtn = el("button", "legend-cite-btn", regTarget.guidelineId ? regTarget.guidelineId.split("-").slice(0, 2).join("-") : "Source");
    citeBtn.type = "button";
    citeBtn.addEventListener("click", openGuidelinesModal);
    regDd.append(citeBtn);
  } else {
    regDd.textContent = "No regional target";
  }

  const convEl = byId("ev-conversion");
  if (obs.conversionFactor && obs.conversionFactor !== 1 && obs.valueNum !== null) {
    convEl.textContent = `Unit conversion: ${obs.valueNum} ${obs.unitRaw} × ${obs.conversionFactor} = ${Number(obs.normalizedValue).toFixed(2)} ${obs.normalizedUnit}.`;
    convEl.hidden = false;
  } else if (obs.method) {
    convEl.textContent = `Assay method: ${obs.method}`;
    convEl.hidden = false;
  } else {
    convEl.hidden = true;
  }

  const pageNum = Number(obs.page || 1);
  state.evidenceState = {
    docId: obs.documentId,
    provider: obs.provider || doc?.provider,
    page: pageNum,
    pageCount: Number(doc?.pageCount || pageNum || 1),
    highlightPage: pageNum,
    lineIndex: obs.lineIndex,
    bbox: Array.isArray(obs.bbox) ? obs.bbox : null,
    excerpt: obs.excerpt || "",
    label: obs.displayName || "Result",
  };
  updateEvidencePageDisplay();
  renderEvidenceMetadata(doc, obs);
  updateSelectedHighlights();

  if (interact) {
    history.replaceState(null, "", `/?obs=${encodeURIComponent(obs.observationId)}#evidence`);
    if (matchMedia("(max-width: 1120px)").matches) {
      byId("evidence").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

function inspectDocumentEvidence(docId, page = 1, info = {}, interact = false) {
  const doc = state.docById.get(docId);
  state.selectedObsId = null;
  state.selectedDocId = docId;

  byId("evidence-empty").hidden = true;
  byId("evidence-body").hidden = false;

  byId("ev-provider").textContent = doc?.provider || "Lab document";
  const statusPill = byId("ev-status-pill");
  if (doc?.reportStatus) {
    statusPill.textContent = doc.reportStatus;
    statusPill.className = "lozenge lozenge-success";
    statusPill.hidden = false;
  } else {
    statusPill.hidden = true;
  }
  byId("ev-specimen").hidden = true;
  byId("ev-analyte-name").textContent = info.title || doc?.filename || "Report preview";
  byId("ev-flag-badge").hidden = true;
  byId("ev-reported").textContent = "—";
  byId("ev-normalized").textContent = "—";
  byId("ev-lab-range").textContent = "—";
  byId("ev-regional-target").textContent = "—";
  byId("ev-conversion").hidden = true;

  state.evidenceState = {
    docId,
    provider: doc?.provider,
    page: Number(page || 1),
    pageCount: Number(doc?.pageCount || page || 1),
    highlightPage: Number(page || 1),
    lineIndex: null,
    bbox: Array.isArray(info.bbox) ? info.bbox : null,
    excerpt: info.excerpt || "",
    label: info.title || "Report",
  };
  updateEvidencePageDisplay();
  renderEvidenceMetadata(doc, null);
  updateSelectedHighlights();

  if (interact && matchMedia("(max-width: 1120px)").matches) {
    byId("evidence").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

async function openGuidelinesModal() {
  const dialog = byId("guidelines-dialog");
  if (!dialog.open) dialog.showModal();

  try {
    const res = await fetch("/api/guidelines");
    const g = res.ok ? await res.json() : (state.dashboard?.guidelines || {});
    state.guidelines = g;

    const fm = g.frontmatter || {};
    const metaParts = [];
    if (fm.country || g.country) metaParts.push(`Country: ${fm.country || g.country}`);
    if (fm.source_mode || fm.sourceMode || g.sourceMode) metaParts.push(`Mode: ${fm.source_mode || fm.sourceMode || g.sourceMode}`);
    if (fm.fetched_at || fm.fetchedAt || g.fetchedAt) metaParts.push(`Synced: ${formatDate(fm.fetched_at || fm.fetchedAt || g.fetchedAt)}`);
    if (g.stale) metaParts.push("Refresh recommended");
    byId("guidelines-meta").textContent = g.exists
      ? (metaParts.join(" · ") || "Official guidelines loaded")
      : "No regional-guidelines.md file found yet. Run onboarding/guidelines sync to fetch official ministry guidelines.";

    const targets = Array.isArray(g.targets) ? g.targets : [];
    const targetsSection = byId("guidelines-targets-section");
    const targetsBody = byId("guidelines-targets-body");
    targetsBody.replaceChildren();
    for (const raw of targets) {
      const t = normalizeTargetBand(raw);
      const tr = el("tr");
      const citeCell = el("td");
      citeCell.append(document.createTextNode(t.citation || "Official regional standard"));
      if (t.url && /^https?:\/\//i.test(t.url)) {
        citeCell.append(document.createTextNode(" "));
        const a = el("a", "ads-link-compact", "↗");
        a.href = t.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.title = t.url;
        citeCell.append(a);
      }
      tr.append(
        el("td", "", raw.displayName || raw.canonicalKey || raw.biomarker || "—"),
        el("td", "", `${t.text}${t.unit && !t.text.includes(t.unit) ? " " + t.unit : ""}`.trim() || "—"),
        citeCell
      );
      targetsBody.append(tr);
    }
    targetsSection.hidden = targets.length === 0;

    const sources = Array.isArray(g.sources) ? g.sources : [];
    const sourcesSection = byId("guidelines-sources-section");
    const sourcesList = byId("guidelines-sources-list");
    sourcesList.replaceChildren();
    for (const src of sources) {
      const url = typeof src === "string" ? src : (src.url || "");
      const title = typeof src === "string"
        ? src
        : ([src.id, src.topic || src.title || src.name].filter(Boolean).join(" — ") || src.url || "Official source");
      const li = el("li");
      if (url && /^https?:\/\//i.test(url)) {
        const a = el("a", "", title);
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        li.append(a);
      } else {
        li.textContent = title;
      }
      if (typeof src === "object" && src?.fetchStatus) {
        li.append(document.createTextNode(" "));
        const badgeCls = src.fetchStatus === "live" ? "lozenge lozenge-success" : "lozenge lozenge-warning";
        li.append(el("span", badgeCls, src.fetchStatus));
      }
      sourcesList.append(li);
    }
    sourcesSection.hidden = sources.length === 0;

    byId("guidelines-markdown").textContent = g.markdown || "No regional-guidelines.md synced yet.";
  } catch (err) {
    byId("guidelines-meta").textContent = "Could not load regional guidelines.";
    byId("guidelines-markdown").textContent = String(err.message || err);
  }
}

function setupUploadModal() {
  const dialog = byId("upload-dialog");
  const form = byId("upload-form");
  const input = byId("upload-file-input");
  const dropzone = byId("upload-dropzone");
  const dropTitle = byId("upload-dropzone-title");
  const submitBtn = byId("upload-submit-btn");
  const statusText = byId("upload-status-text");
  const resultBox = byId("upload-result");

  let selectedFile = null;

  const setFile = file => {
    selectedFile = file || null;
    submitBtn.disabled = !selectedFile;
    if (selectedFile) {
      const kb = Math.max(1, Math.round(selectedFile.size / 1024));
      dropTitle.textContent = `Selected: ${selectedFile.name} (${kb} KB)`;
    } else {
      dropTitle.textContent = "Drop a PDF or lab photo here, or click to browse";
    }
  };

  input.addEventListener("change", () => setFile(input.files?.[0]));

  for (const evt of ["dragenter", "dragover"]) {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.add("is-dragover");
    });
  }
  for (const evt of ["dragleave", "drop"]) {
    dropzone.addEventListener(evt, e => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
    });
  }
  dropzone.addEventListener("drop", e => {
    const file = e.dataTransfer?.files?.[0];
    if (file) setFile(file);
  });

  byId("open-upload-btn").addEventListener("click", () => {
    resultBox.hidden = true;
    statusText.textContent = "";
    dialog.showModal();
  });

  form.addEventListener("submit", async e => {
    e.preventDefault();
    if (!selectedFile) return;

    submitBtn.disabled = true;
    statusText.textContent = "Uploading and running ingestion pipeline…";
    resultBox.hidden = true;

    try {
      const formData = new FormData();
      formData.append("file", selectedFile, selectedFile.name);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();

      resultBox.hidden = false;
      resultBox.replaceChildren();
      resultBox.className = "upload-result";

      if (!res.ok || data.status === "error") {
        resultBox.classList.add("is-error");
        resultBox.append(
          el("strong", "", "Ingestion failed"),
          el("p", "", data.error || data.message || "Could not ingest this file.")
        );
      } else if (data.status === "skipped") {
        resultBox.classList.add("is-skipped");
        resultBox.append(
          el("strong", "", "Blocked by Patient Identity Gate (0 measurements stored)"),
          el("p", "", `${data.filename || selectedFile.name}: ${data.skipReason || data.message || "Patient identity did not match your profile."}`)
        );
        await loadDashboard();
      } else if (data.status === "needs_vlm_extraction") {
        resultBox.classList.add("is-vlm");
        resultBox.append(
          el("strong", "", "Photo / scanned report queued for VLM extraction"),
          el("p", "", `Saved securely as ${data.uploadedFilename || selectedFile.name}. Ask your OpenClaw Health Bot (or MCP agent) to inspect the image and commit structured JSON via health_commit_extracted.`),
          data.fileId ? el("small", "", `File ID: ${data.fileId}`) : ""
        );
        await loadDashboard();
      } else if (data.status === "duplicate") {
        resultBox.append(
          el("strong", "", "Already imported (idempotent)"),
          el("p", "", `${data.filename || selectedFile.name} matches an existing document in your timeline. No duplicates were created.`)
        );
      } else {
        resultBox.append(
          el("strong", "", "Report ingested successfully"),
          el("p", "", `${data.provider || "Lab"} · ${data.observationsCount ?? 0} measurements extracted${data.supersededDocumentIds?.length ? " · Superseded earlier PARCIAL report" : ""}.`)
        );
        await loadDashboard();
      }
      statusText.textContent = "";
      setFile(null);
      form.reset();
    } catch (err) {
      resultBox.hidden = false;
      resultBox.className = "upload-result is-error";
      resultBox.replaceChildren(
        el("strong", "", "Upload error"),
        el("p", "", String(err.message || err))
      );
      statusText.textContent = "";
    } finally {
      submitBtn.disabled = !selectedFile;
    }
  });
}

function wireControls() {
  byId("open-guidelines-btn").addEventListener("click", openGuidelinesModal);

  for (const btn of document.querySelectorAll("[data-close-dialog]")) {
    btn.addEventListener("click", () => {
      const dlg = byId(btn.dataset.closeDialog);
      if (dlg?.open) dlg.close();
    });
  }

  for (const dlg of document.querySelectorAll("dialog.modal")) {
    dlg.addEventListener("click", e => {
      if (e.target === dlg) dlg.close();
    });
  }

  byId("biomarker-search").addEventListener("input", e => {
    state.searchQuery = e.target.value || "";
    renderBiomarkerList();
  });

  byId("provider-filter").addEventListener("change", e => {
    state.providerFilter = e.target.value || "all";
    renderTimeline(state.dashboard);
  });

  byId("ev-page-prev").addEventListener("click", () => {
    if (state.evidenceState && state.evidenceState.page > 1) {
      state.evidenceState.page -= 1;
      updateEvidencePageDisplay();
    }
  });

  byId("ev-page-next").addEventListener("click", () => {
    if (state.evidenceState && state.evidenceState.page < state.evidenceState.pageCount) {
      state.evidenceState.page += 1;
      updateEvidencePageDisplay();
    }
  });

  byId("ev-copy-link").addEventListener("click", async () => {
    const btn = byId("ev-copy-link");
    const deepUrl = state.selectedObsId
      ? `${location.origin}/?obs=${encodeURIComponent(state.selectedObsId)}#evidence`
      : location.href;
    try {
      await navigator.clipboard.writeText(deepUrl);
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy deep link"; }, 1600);
    } catch {
      history.replaceState(null, "", deepUrl);
      btn.textContent = "URL updated";
      setTimeout(() => { btn.textContent = "Copy deep link"; }, 1600);
    }
  });

  setupUploadModal();
}

async function loadDashboard() {
  const errBanner = byId("error-banner");
  errBanner.hidden = true;

  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
    const data = await response.json();
    state.dashboard = data;
    indexDashboard(data);

    renderTopbar(data);
    renderOverview(data);
    renderPanelTabs();
    renderTimeline(data);
    renderIntegrityCards(data);

    byId("workspace").hidden = false;

    const params = new URL(location.href).searchParams;
    const requestedObs = params.get("obs");
    const requestedResult = params.get("result");
    const requestedKey = params.get("key");

    const allBios = getAllBiomarkers();
    let initialKey = requestedKey && allBios.some(b => b.canonicalKey === requestedKey)
      ? requestedKey
      : (state.selectedKey && allBios.some(b => b.canonicalKey === state.selectedKey)
          ? state.selectedKey
          : (data.defaultBiomarkerKey || allBios[0]?.canonicalKey || null));

    if (requestedObs && state.obsById.has(requestedObs)) {
      const targetObs = state.obsById.get(requestedObs);
      if (targetObs.canonicalKey) initialKey = targetObs.canonicalKey;
    }

    if (initialKey) {
      await selectBiomarker(initialKey, false);
    } else {
      renderBiomarkerList();
    }

    if (requestedObs && state.obsById.has(requestedObs)) {
      await selectObservation(requestedObs, false);
    } else if (requestedResult) {
      const docObs = state.obsByDoc.get(requestedResult) || [];
      if (docObs.length) {
        await selectObservation(docObs[0].observationId, false);
      } else if (state.docById.has(requestedResult)) {
        inspectDocumentEvidence(requestedResult, 1, {}, false);
      }
    } else if (!state.selectedObsId && state.selectedTrend?.points?.length) {
      await selectObservation(state.selectedTrend.points.at(-1).observationId, false);
    } else if (!state.selectedObsId && data.timeline?.events?.length) {
      inspectDocumentEvidence(data.timeline.events[0].documentId, 1, {}, false);
    }
  } catch (error) {
    console.error(error);
    errBanner.textContent = "The Health Timeline dashboard could not load. Ensure the local server is running and data has been initialized.";
    errBanner.hidden = false;
    byId("overview-summary").textContent = "Unable to connect to local Health Timeline API.";
  }
}

wireControls();
await loadDashboard();
