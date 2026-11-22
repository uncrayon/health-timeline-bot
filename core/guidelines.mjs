import fs from "node:fs";
import path from "node:path";
import { resolveGuidelinesPath } from "./db.mjs";

export const OFFICIAL_DOMAIN_ALLOWLIST = {
  MX: [
    "dof.gob.mx",
    "www.dof.gob.mx",
    "gob.mx",
    "www.gob.mx",
    "imss.gob.mx",
    "www.imss.gob.mx",
    "salud.gob.mx",
    "www.salud.gob.mx",
    "cenetec-difusion.com",
  ],
  US: [
    "uspreventiveservicestaskforce.org",
    "www.uspreventiveservicestaskforce.org",
    "cdc.gov",
    "www.cdc.gov",
    "nih.gov",
    "www.nih.gov",
    "nhlbi.nih.gov",
    "www.nhlbi.nih.gov",
    "medlineplus.gov",
    "www.medlineplus.gov",
    "niddk.nih.gov",
    "www.niddk.nih.gov",
  ],
  DE: [
    "awmf.org",
    "www.awmf.org",
    "register.awmf.org",
    "rki.de",
    "www.rki.de",
    "bundesgesundheitsministerium.de",
    "www.bundesgesundheitsministerium.de",
  ],
  GLOBAL: [
    "who.int",
    "www.who.int",
  ],
};

// Note: Strict exact hostnames (excluding non-gov domains like cenetec-difusion.com from code allowlist)
const STRICT_ALLOWED_HOSTS = new Set([
  "dof.gob.mx",
  "www.dof.gob.mx",
  "gob.mx",
  "www.gob.mx",
  "imss.gob.mx",
  "www.imss.gob.mx",
  "salud.gob.mx",
  "www.salud.gob.mx",
  "uspreventiveservicestaskforce.org",
  "www.uspreventiveservicestaskforce.org",
  "cdc.gov",
  "www.cdc.gov",
  "nih.gov",
  "www.nih.gov",
  "nhlbi.nih.gov",
  "www.nhlbi.nih.gov",
  "medlineplus.gov",
  "www.medlineplus.gov",
  "niddk.nih.gov",
  "www.niddk.nih.gov",
  "awmf.org",
  "www.awmf.org",
  "register.awmf.org",
  "rki.de",
  "www.rki.de",
  "bundesgesundheitsministerium.de",
  "www.bundesgesundheitsministerium.de",
  "who.int",
  "www.who.int",
]);

const OFFICIAL_GOV_SUFFIX_PATTERNS = [
  /\.gob\.[a-z]{2}$/i,
  /(^|\.)gov$/i,
  /\.gov\.[a-z]{2}$/i,
  /(^|\.)who\.int$/i,
];

export function isAllowedOfficialUrl(urlString) {
  if (!urlString || typeof urlString !== "string") {
    return { allowed: false, hostname: null, reason: "Empty or non-string URL" };
  }
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return { allowed: false, hostname: null, reason: "Malformed URL" };
  }
  if (parsed.protocol !== "https:") {
    return { allowed: false, hostname: parsed.hostname, reason: "Only HTTPS official endpoints are permitted" };
  }
  const host = parsed.hostname.toLowerCase();
  if (STRICT_ALLOWED_HOSTS.has(host)) {
    return { allowed: true, hostname: host, reason: "Exact match in official clinical guideline allowlist" };
  }
  if (OFFICIAL_GOV_SUFFIX_PATTERNS.some(re => re.test(host))) {
    return { allowed: true, hostname: host, reason: "Matches official national health ministry/government domain suffix" };
  }
  return {
    allowed: false,
    hostname: host,
    reason: `Blocked unofficial domain "${host}": only official health ministries (.gob.*, .gov, .gov.*), WHO, USPSTF, CDC, NIH, AWMF, and RKI are allowed`,
  };
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractHtmlTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripHtmlToText(m[1]).slice(0, 180) : null;
}

export async function fetchOfficialSource(url, opts = {}) {
  const check = isAllowedOfficialUrl(url);
  if (!check.allowed) {
    const err = new Error(check.reason);
    err.code = "OFFICIAL_ALLOWLIST_BLOCKED";
    err.hostname = check.hostname;
    throw err;
  }

  const timeoutMs = Number(opts.timeoutMs || 6500);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": "HealthTimeline/1.0 (+official-clinical-guideline-sync)",
        "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.9",
      },
    });
    // Re-validate final redirect destination against allowlist!
    if (response.url) {
      const finalCheck = isAllowedOfficialUrl(response.url);
      if (!finalCheck.allowed) {
        const err = new Error(`Redirected to blocked domain: ${finalCheck.reason}`);
        err.code = "OFFICIAL_ALLOWLIST_BLOCKED";
        throw err;
      }
    }
    const raw = await response.text();
    const title = extractHtmlTitle(raw);
    const text = stripHtmlToText(raw);
    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url,
      title,
      excerpt: text.slice(0, 800),
      fetchedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timer);
  }
}

const COUNTRY_CONFIGS = {
  MX: {
    countryCode: "MX",
    countryName: "Mexico",
    authority: "Secretaría de Salud / DOF / CENETEC / IMSS",
    sources: [
      {
        id: "NOM-037-SSA2-2012",
        topic: "Dyslipidemias & Cardiovascular Risk",
        url: "https://www.dof.gob.mx/nota_detalle.php?codigo=5259329&fecha=13/07/2012",
        year: 2012,
        note: "Mexican Official Standard for prevention, treatment, and control of dyslipidemias (supplemented by CENETEC GPC)",
      },
      {
        id: "NOM-015-SSA2-2010",
        topic: "Diabetes Mellitus",
        url: "https://www.dof.gob.mx/nota_detalle.php?codigo=5168074&fecha=23/11/2010",
        year: 2010,
        note: "Mexican Official Standard for prevention, treatment, and control of diabetes mellitus (updated by 2018 draft/CENETEC)",
      },
      {
        id: "NOM-030-SSA2-2009",
        topic: "Systemic Arterial Hypertension",
        url: "https://www.dof.gob.mx/nota_detalle.php?codigo=5144642&fecha=31/05/2010",
        year: 2010,
        note: "Mexican Official Standard for prevention, detection, diagnosis, treatment, and control of hypertension",
      },
      {
        id: "CENETEC-SALUD-MX",
        topic: "National Clinical Practice Guidelines Catalog (CENETEC)",
        url: "https://www.gob.mx/salud/cenetec",
        year: 2025,
        note: "Secretaría de Salud CENETEC Catálogo Maestro de Guías de Práctica Clínica",
      },
    ],
    buildTargets(ctx) {
      const hdlLow = ctx.sex === "F" ? 50 : 40;
      const waistHigh = ctx.sex === "F" ? 80 : 90;
      const targets = [
        {
          canonicalKey: "serum:ldl_direct",
          displayName: "LDL Cholesterol (Direct)",
          targetText: "< 100 mg/dL (optimal / low-risk); < 70 mg/dL if high CV risk",
          targetLow: null,
          targetHigh: 100,
          unit: "mg/dL",
          guidelineId: "NOM-037-SSA2-2012",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5259329&fecha=13/07/2012",
          population: "Adult general / primary prevention (MX)",
          note: "Clinical target; always compare alongside your lab assay reference range.",
        },
        {
          canonicalKey: "serum:ldl",
          displayName: "LDL Cholesterol",
          targetText: "< 100 mg/dL (optimal / low-risk); < 130 mg/dL borderline",
          targetLow: null,
          targetHigh: 100,
          unit: "mg/dL",
          guidelineId: "NOM-037-SSA2-2012",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5259329&fecha=13/07/2012",
          population: "Adult general (MX)",
          note: "Clinical target per NOM-037-SSA2-2012.",
        },
        {
          canonicalKey: "serum:total_cholesterol",
          displayName: "Total Cholesterol",
          targetText: "< 200 mg/dL desirable",
          targetLow: null,
          targetHigh: 200,
          unit: "mg/dL",
          guidelineId: "NOM-037-SSA2-2012",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5259329&fecha=13/07/2012",
          population: "Adult general (MX)",
          note: "Desirable total cholesterol threshold.",
        },
        {
          canonicalKey: "serum:triglycerides",
          displayName: "Triglycerides",
          targetText: "< 150 mg/dL desirable",
          targetLow: null,
          targetHigh: 150,
          unit: "mg/dL",
          guidelineId: "NOM-037-SSA2-2012",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5259329&fecha=13/07/2012",
          population: "Adult general (MX)",
          note: "Fasting triglycerides threshold.",
        },
        {
          canonicalKey: "serum:hdl",
          displayName: "HDL Cholesterol",
          targetText: `>= ${hdlLow} mg/dL (${ctx.sex === "F" ? "female" : "male"} minimum); >= 60 mg/dL protective`,
          targetLow: hdlLow,
          targetHigh: null,
          unit: "mg/dL",
          guidelineId: "NOM-037-SSA2-2012",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5259329&fecha=13/07/2012",
          population: ctx.sex === "F" ? "Adult female (MX)" : "Adult male (MX)",
          note: "Sex-stratified HDL protective floor.",
        },
        {
          canonicalKey: "serum:glucose",
          displayName: "Fasting Glucose (Serum)",
          targetText: ctx.pregnant ? "< 92 mg/dL (pregnancy fasting screening)" : "70 - 99 mg/dL normal fasting (100-125 prediabetes)",
          targetLow: ctx.pregnant ? 65 : 70,
          targetHigh: ctx.pregnant ? 92 : 99,
          unit: "mg/dL",
          guidelineId: "NOM-015-SSA2-2010",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5168074&fecha=23/11/2010",
          population: ctx.pregnant ? "Pregnant adult (MX)" : "Adult fasting (MX)",
          note: "Fasting venous plasma glucose threshold per NOM-015-SSA2.",
        },
        {
          canonicalKey: "serum:hba1c",
          displayName: "Hemoglobin A1c (HbA1c)",
          targetText: "< 5.7 % normal (5.7 - 6.4 % prediabetes; >= 6.5 % diabetes)",
          targetLow: null,
          targetHigh: 5.7,
          unit: "%",
          guidelineId: "NOM-015-SSA2-2010",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5168074&fecha=23/11/2010",
          population: "Adult general (MX)",
          note: "Glycemic diagnostic & monitoring threshold.",
        },
        {
          canonicalKey: "serum:egfr",
          displayName: "eGFR",
          targetText: ">= 90 mL/min/1.73m2 normal; < 60 warrants CKD evaluation",
          targetLow: 60,
          targetHigh: null,
          unit: "mL/min/1.73m2",
          guidelineId: "CENETEC-SALUD-MX",
          sourceUrl: "https://www.gob.mx/salud/cenetec",
          population: "Adult general (race-free CKD-EPI)",
          note: "Use race-free 2021 CKD-EPI interpretation.",
        },
        {
          canonicalKey: "vitals:systolic_bp",
          displayName: "Systolic Blood Pressure",
          targetText: "< 120 mmHg optimal; < 130 mmHg normal",
          targetLow: 90,
          targetHigh: 120,
          unit: "mmHg",
          guidelineId: "NOM-030-SSA2-2009",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5144642&fecha=31/05/2010",
          population: "Adult general (MX)",
          note: "Office blood pressure reference per NOM-030-SSA2.",
        },
        {
          canonicalKey: "vitals:waist_circumference",
          displayName: "Waist Circumference",
          targetText: `< ${waistHigh} cm (${ctx.sex === "F" ? "female" : "male"} Mexican metabolic threshold)`,
          targetLow: null,
          targetHigh: waistHigh,
          unit: "cm",
          guidelineId: "NOM-015-SSA2-2010",
          sourceUrl: "https://www.dof.gob.mx/nota_detalle.php?codigo=5168074&fecha=23/11/2010",
          population: ctx.sex === "F" ? "Adult female (MX)" : "Adult male (MX)",
          note: "Mexican Secretaría de Salud abdominal obesity cutoff.",
        },
      ];
      return targets;
    },
  },
  US: {
    countryCode: "US",
    countryName: "United States",
    authority: "USPSTF / CDC / NIH NHLBI / MedlinePlus",
    sources: [
      {
        id: "NIH-NHLBI-CHOLESTEROL",
        topic: "Blood Cholesterol Clinical Targets",
        url: "https://www.nhlbi.nih.gov/health/blood-cholesterol",
        year: 2024,
        note: "NIH National Heart, Lung, and Blood Institute cholesterol guidelines",
      },
      {
        id: "CDC-DIABETES-TESTING",
        topic: "Glucose & HbA1c Screening Thresholds",
        url: "https://www.cdc.gov/diabetes/diabetes-testing/index.html",
        year: 2024,
        note: "CDC diagnostic cutoffs for fasting plasma glucose and A1C",
      },
      {
        id: "USPSTF-PREVENTION",
        topic: "Preventive Screening Recommendations",
        url: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation-topics",
        year: 2025,
        note: "U.S. Preventive Services Task Force evidence-based screening guidance",
      },
      {
        id: "MEDLINEPLUS-LABS",
        topic: "Clinical Lab Test Context",
        url: "https://medlineplus.gov/lab-tests/",
        year: 2025,
        note: "NIH National Library of Medicine MedlinePlus lab references",
      },
    ],
    buildTargets(ctx) {
      const hdlLow = ctx.sex === "F" ? 50 : 40;
      const bmiHigh = ctx.isAsianAncestry ? 23 : 25;
      return [
        {
          canonicalKey: "serum:ldl_direct",
          displayName: "LDL Cholesterol (Direct)",
          targetText: "< 100 mg/dL optimal (NIH NHLBI)",
          targetLow: null,
          targetHigh: 100,
          unit: "mg/dL",
          guidelineId: "NIH-NHLBI-CHOLESTEROL",
          sourceUrl: "https://www.nhlbi.nih.gov/health/blood-cholesterol",
          population: "Adult general (US)",
          note: "Optimal clinical target; interpret with overall 10-year ASCVD risk.",
        },
        {
          canonicalKey: "serum:ldl",
          displayName: "LDL Cholesterol",
          targetText: "< 100 mg/dL optimal (NIH NHLBI)",
          targetLow: null,
          targetHigh: 100,
          unit: "mg/dL",
          guidelineId: "NIH-NHLBI-CHOLESTEROL",
          sourceUrl: "https://www.nhlbi.nih.gov/health/blood-cholesterol",
          population: "Adult general (US)",
          note: "Optimal clinical target per NIH NHLBI.",
        },
        {
          canonicalKey: "serum:total_cholesterol",
          displayName: "Total Cholesterol",
          targetText: "< 200 mg/dL desirable",
          targetLow: null,
          targetHigh: 200,
          unit: "mg/dL",
          guidelineId: "NIH-NHLBI-CHOLESTEROL",
          sourceUrl: "https://www.nhlbi.nih.gov/health/blood-cholesterol",
          population: "Adult general (US)",
          note: "Desirable total cholesterol.",
        },
        {
          canonicalKey: "serum:triglycerides",
          displayName: "Triglycerides",
          targetText: "< 150 mg/dL normal",
          targetLow: null,
          targetHigh: 150,
          unit: "mg/dL",
          guidelineId: "NIH-NHLBI-CHOLESTEROL",
          sourceUrl: "https://www.nhlbi.nih.gov/health/blood-cholesterol",
          population: "Adult general (US)",
          note: "Fasting normal triglycerides.",
        },
        {
          canonicalKey: "serum:hdl",
          displayName: "HDL Cholesterol",
          targetText: `>= ${hdlLow} mg/dL minimum; >= 60 mg/dL protective`,
          targetLow: hdlLow,
          targetHigh: null,
          unit: "mg/dL",
          guidelineId: "NIH-NHLBI-CHOLESTEROL",
          sourceUrl: "https://www.nhlbi.nih.gov/health/blood-cholesterol",
          population: ctx.sex === "F" ? "Adult female (US)" : "Adult male (US)",
          note: "Sex-stratified HDL cutoff.",
        },
        {
          canonicalKey: "serum:glucose",
          displayName: "Fasting Glucose (Serum)",
          targetText: ctx.pregnant ? "< 95 mg/dL fasting (pregnancy)" : "70 - 99 mg/dL normal fasting (CDC)",
          targetLow: 70,
          targetHigh: ctx.pregnant ? 95 : 99,
          unit: "mg/dL",
          guidelineId: "CDC-DIABETES-TESTING",
          sourceUrl: "https://www.cdc.gov/diabetes/diabetes-testing/index.html",
          population: ctx.pregnant ? "Pregnant adult (US)" : "Adult fasting (US)",
          note: "100-125 mg/dL indicates prediabetes per CDC.",
        },
        {
          canonicalKey: "serum:hba1c",
          displayName: "Hemoglobin A1c (HbA1c)",
          targetText: "< 5.7 % normal (5.7-6.4% prediabetes; >= 6.5% diabetes)",
          targetLow: null,
          targetHigh: 5.7,
          unit: "%",
          guidelineId: "CDC-DIABETES-TESTING",
          sourceUrl: "https://www.cdc.gov/diabetes/diabetes-testing/index.html",
          population: "Adult general (US)",
          note: "CDC A1C thresholds.",
        },
        {
          canonicalKey: "serum:egfr",
          displayName: "eGFR",
          targetText: ">= 60 mL/min/1.73m2 (race-free 2021 CKD-EPI)",
          targetLow: 60,
          targetHigh: null,
          unit: "mL/min/1.73m2",
          guidelineId: "MEDLINEPLUS-LABS",
          sourceUrl: "https://medlineplus.gov/lab-tests/",
          population: "Adult general (race-free)",
          note: "Race-free eGFR interpretation endorsed by NIH/NKF.",
        },
        {
          canonicalKey: "vitals:bmi",
          displayName: "Body Mass Index (BMI)",
          targetText: `18.5 - ${bmiHigh} kg/m2 (${ctx.isAsianAncestry ? "Asian-ancestry screening cutoff per USPSTF" : "standard adult"})`,
          targetLow: 18.5,
          targetHigh: bmiHigh,
          unit: "kg/m2",
          guidelineId: "USPSTF-PREVENTION",
          sourceUrl: "https://www.uspreventiveservicestaskforce.org/uspstf/recommendation-topics",
          population: ctx.isAsianAncestry ? "Asian-ancestry adult (US)" : "Adult general (US)",
          note: "USPSTF notes lower BMI screening cutoffs (>=23) for Asian-American adults for prediabetes/diabetes.",
        },
      ];
    },
  },
  DE: {
    countryCode: "DE",
    countryName: "Germany",
    authority: "AWMF / Robert Koch-Institut (RKI) / BMG",
    sources: [
      {
        id: "AWMF-LEITLINIEN",
        topic: "AWMF S1-S3 Clinical Practice Guidelines Registry",
        url: "https://register.awmf.org/de/start",
        year: 2025,
        note: "Arbeitsgemeinschaft der Wissenschaftlichen Medizinischen Fachgesellschaften (AWMF) guideline registry",
      },
      {
        id: "RKI-GESUNDHEIT",
        topic: "Robert Koch-Institut Public Health & NCD Surveillance",
        url: "https://www.rki.de/DE/Home/homepage_node.html",
        year: 2025,
        note: "Robert Koch-Institut (RKI) federal public health reference",
      },
      {
        id: "BMG-PRAEVENTION",
        topic: "Federal Ministry of Health Preventive Check-ups",
        url: "https://www.bundesgesundheitsministerium.de/",
        year: 2025,
        note: "Bundesministerium für Gesundheit (Check-up 35 & preventive guidance)",
      },
    ],
    buildTargets(ctx) {
      const hdlLow = ctx.sex === "F" ? 45 : 40;
      return [
        {
          canonicalKey: "serum:ldl_direct",
          displayName: "LDL Cholesterol (Direct)",
          targetText: "< 116 mg/dL (low CV risk ESC/AWMF); < 100 mg/dL moderate risk",
          targetLow: null,
          targetHigh: 116,
          unit: "mg/dL",
          guidelineId: "AWMF-LEITLINIEN",
          sourceUrl: "https://register.awmf.org/de/start",
          population: "Adult general (DE / ESC-aligned)",
          note: "Risk-stratified LDL targets per German/ESC cardiovascular prevention guidance.",
        },
        {
          canonicalKey: "serum:ldl",
          displayName: "LDL Cholesterol",
          targetText: "< 116 mg/dL (low CV risk); < 100 mg/dL moderate risk",
          targetLow: null,
          targetHigh: 116,
          unit: "mg/dL",
          guidelineId: "AWMF-LEITLINIEN",
          sourceUrl: "https://register.awmf.org/de/start",
          population: "Adult general (DE)",
          note: "ESC/AWMF aligned threshold.",
        },
        {
          canonicalKey: "serum:triglycerides",
          displayName: "Triglycerides",
          targetText: "< 150 mg/dL fasting",
          targetLow: null,
          targetHigh: 150,
          unit: "mg/dL",
          guidelineId: "AWMF-LEITLINIEN",
          sourceUrl: "https://register.awmf.org/de/start",
          population: "Adult general (DE)",
          note: "Fasting triglycerides threshold.",
        },
        {
          canonicalKey: "serum:hdl",
          displayName: "HDL Cholesterol",
          targetText: `>= ${hdlLow} mg/dL`,
          targetLow: hdlLow,
          targetHigh: null,
          unit: "mg/dL",
          guidelineId: "AWMF-LEITLINIEN",
          sourceUrl: "https://register.awmf.org/de/start",
          population: ctx.sex === "F" ? "Adult female (DE)" : "Adult male (DE)",
          note: "Sex-stratified HDL threshold.",
        },
        {
          canonicalKey: "serum:glucose",
          displayName: "Fasting Glucose (Serum)",
          targetText: "70 - 99 mg/dL normal fasting",
          targetLow: 70,
          targetHigh: 99,
          unit: "mg/dL",
          guidelineId: "AWMF-LEITLINIEN",
          sourceUrl: "https://register.awmf.org/de/start",
          population: "Adult fasting (DE)",
          note: "NVL Typ-2-Diabetes fasting plasma glucose threshold.",
        },
        {
          canonicalKey: "serum:hba1c",
          displayName: "Hemoglobin A1c (HbA1c)",
          targetText: "< 5.7 % normal (>= 6.5 % diabetes diagnostic threshold)",
          targetLow: null,
          targetHigh: 5.7,
          unit: "%",
          guidelineId: "AWMF-LEITLINIEN",
          sourceUrl: "https://register.awmf.org/de/start",
          population: "Adult general (DE)",
          note: "NVL Typ-2-Diabetes A1C threshold.",
        },
      ];
    },
  },
  GLOBAL: {
    countryCode: "GLOBAL",
    countryName: "Global (WHO)",
    authority: "World Health Organization (WHO)",
    sources: [
      {
        id: "WHO-HEARTS-CVD",
        topic: "WHO Cardiovascular Disease & Lipid Risk Guidance",
        url: "https://www.who.int/health-topics/cardiovascular-diseases",
        year: 2025,
        note: "WHO cardiovascular prevention guidance",
      },
      {
        id: "WHO-DIABETES",
        topic: "WHO Diabetes Diagnostic Thresholds",
        url: "https://www.who.int/health-topics/diabetes",
        year: 2025,
        note: "WHO fasting glucose and HbA1c reference guidance",
      },
    ],
    buildTargets() {
      return [
        {
          canonicalKey: "serum:ldl_direct",
          displayName: "LDL Cholesterol (Direct)",
          targetText: "< 100 mg/dL optimal",
          targetLow: null,
          targetHigh: 100,
          unit: "mg/dL",
          guidelineId: "WHO-HEARTS-CVD",
          sourceUrl: "https://www.who.int/health-topics/cardiovascular-diseases",
          population: "Adult general (WHO)",
          note: "Global clinical target.",
        },
        {
          canonicalKey: "serum:glucose",
          displayName: "Fasting Glucose (Serum)",
          targetText: "70 - 99 mg/dL normal (< 126 mg/dL diabetes cutoff)",
          targetLow: 70,
          targetHigh: 99,
          unit: "mg/dL",
          guidelineId: "WHO-DIABETES",
          sourceUrl: "https://www.who.int/health-topics/diabetes",
          population: "Adult fasting (WHO)",
          note: "WHO diagnostic threshold.",
        },
        {
          canonicalKey: "serum:hba1c",
          displayName: "Hemoglobin A1c (HbA1c)",
          targetText: "< 5.7 % normal (< 6.5 % diabetes cutoff)",
          targetLow: null,
          targetHigh: 5.7,
          unit: "%",
          guidelineId: "WHO-DIABETES",
          sourceUrl: "https://www.who.int/health-topics/diabetes",
          population: "Adult general (WHO)",
          note: "WHO HbA1c guidance.",
        },
      ];
    },
  },
};

function resolveCountryKey(countryRaw) {
  const s = String(countryRaw || "").trim().toUpperCase();
  if (["MX", "MEX", "MEXICO", "MÉXICO"].includes(s)) return "MX";
  if (["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"].includes(s)) return "US";
  if (["DE", "DEU", "GERMANY", "DEUTSCHLAND"].includes(s)) return "DE";
  return "GLOBAL";
}

function deriveContext(profile = {}) {
  const dob = profile.dob || null;
  let age = null;
  if (dob && /^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    const birth = new Date(`${dob}T00:00:00Z`);
    if (!Number.isNaN(birth.getTime())) {
      const now = new Date();
      age = now.getUTCFullYear() - birth.getUTCFullYear();
      const m = now.getUTCMonth() - birth.getUTCMonth();
      if (m < 0 || (m === 0 && now.getUTCDate() < birth.getUTCDate())) age -= 1;
    }
  }
  const sexRaw = String(profile.biologicalSex || profile.biological_sex || "").trim().toUpperCase();
  const sex = sexRaw.startsWith("F") ? "F" : sexRaw.startsWith("M") ? "M" : "UNKNOWN";
  const pregRaw = String(profile.pregnancyStatus || profile.pregnancy_status || "").trim().toLowerCase();
  const pregnant = ["pregnant", "yes", "true", "embarazada", "si", "sí"].includes(pregRaw);
  const ethRaw = String(profile.ethnicity || "").trim().toLowerCase();
  const isAsianAncestry = /(asian|east asian|south asian|asiat)/.test(ethRaw);
  return { age, sex, pregnant, ethnicity: profile.ethnicity || null, isAsianAncestry };
}

function escapeCell(val) {
  return String(val ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

export async function syncRegionalGuidelines(profileInput = {}, opts = {}) {
  const profile = profileInput || {};
  const countryKey = resolveCountryKey(profile.country || opts.country || "GLOBAL");
  const config = COUNTRY_CONFIGS[countryKey] || COUNTRY_CONFIGS.GLOBAL;
  const ctx = deriveContext(profile);

  // Validate any custom URLs passed in opts.customUrls (fail-closed!)
  const extraUrls = Array.isArray(opts.customUrls) ? opts.customUrls : [];
  for (const customUrl of extraUrls) {
    const check = isAllowedOfficialUrl(customUrl);
    if (!check.allowed) {
      const err = new Error(check.reason);
      err.code = "OFFICIAL_ALLOWLIST_BLOCKED";
      throw err;
    }
  }

  const candidateSources = [
    ...config.sources,
    ...extraUrls.map((url, idx) => ({
      id: `CUSTOM-OFFICIAL-${idx + 1}`,
      topic: "Additional Official Ministry Source",
      url,
      year: new Date().getUTCFullYear(),
      note: "User-specified allowlisted official URL",
    })),
  ];

  const fetchedSources = [];
  const fetchErrors = [];
  let liveSuccessCount = 0;

  await Promise.all(
    candidateSources.map(async src => {
      if (opts.skipNetwork === true) {
        fetchedSources.push({
          ...src,
          fetchStatus: "fallback_snapshot",
          httpStatus: null,
          pageTitle: null,
          liveExcerpt: null,
          error: "Network skipped by caller option",
        });
        fetchErrors.push({ id: src.id, url: src.url, error: "Network skipped by caller option" });
        return;
      }
      try {
        const res = await fetchOfficialSource(src.url, { timeoutMs: opts.timeoutMs || 6500 });
        if (res.ok) liveSuccessCount += 1;
        fetchedSources.push({
          ...src,
          url: res.url || src.url,
          fetchStatus: res.ok ? "live" : "http_error_fallback",
          httpStatus: res.status,
          pageTitle: res.title,
          liveExcerpt: res.excerpt ? res.excerpt.slice(0, 320) : null,
          error: res.ok ? null : `HTTP ${res.status}`,
        });
        if (!res.ok) {
          fetchErrors.push({ id: src.id, url: src.url, error: `HTTP ${res.status}` });
        }
      } catch (err) {
        if (err.code === "OFFICIAL_ALLOWLIST_BLOCKED") throw err;
        const msg = err?.name === "AbortError" ? "Request timed out" : (err?.message || String(err));
        fetchedSources.push({
          ...src,
          fetchStatus: "fallback_snapshot",
          httpStatus: null,
          pageTitle: null,
          liveExcerpt: null,
          error: msg,
        });
        fetchErrors.push({ id: src.id, url: src.url, error: msg });
      }
    })
  );

  const sourceMode =
    liveSuccessCount === fetchedSources.length && fetchedSources.length > 0
      ? "live"
      : liveSuccessCount > 0
        ? "mixed"
        : "fallback_snapshot";

  const now = new Date();
  const fetchedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const targets = config.buildTargets(ctx);

  const ageBand =
    ctx.age === null
      ? "adult (age unspecified)"
      : ctx.age < 18
        ? "pediatric (<18)"
        : ctx.age < 40
          ? "young adult (18-39)"
          : ctx.age < 65
            ? "adult (40-64)"
            : "older adult (65+)";

  const frontmatter = [
    "---",
    `country: ${config.countryCode}`,
    `country_name: "${config.countryName}"`,
    `authority: "${config.authority}"`,
    `age_band: "${ageBand}"`,
    `biological_sex: "${ctx.sex}"`,
    `pregnancy_status: "${ctx.pregnant ? "pregnant" : "not_pregnant"}"`,
    `ethnicity: "${ctx.ethnicity || "unspecified"}"`,
    `fetched_at: "${fetchedAt}"`,
    `expires_at: "${expiresAt}"`,
    `source_mode: "${sourceMode}"`,
    `live_sources_fetched: ${liveSuccessCount}`,
    `total_sources: ${fetchedSources.length}`,
    "---",
  ].join("\n");

  const sourceLines = fetchedSources.map(src => {
    const statusLabel = src.fetchStatus === "live"
      ? `LIVE HTTP ${src.httpStatus}${src.pageTitle ? ` — "${src.pageTitle}"` : ""}`
      : `FALLBACK SNAPSHOT (${src.error || "unavailable"})`;
    return `- **${src.id}** (${src.year}) — ${src.topic}: ${src.url}\n  - Status: ${statusLabel}\n  - Notes: ${src.note}${src.liveExcerpt ? `\n  - Live excerpt: ${src.liveExcerpt.slice(0, 220)}...` : ""}`;
  });

  const targetTableHeader = [
    "| Canonical Key | Biomarker | Target Low | Target High | Unit | Clinical Target | Guideline ID | Population | Source URL | Note |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const targetTableRows = targets.map(t =>
    `| ${escapeCell(t.canonicalKey)} | ${escapeCell(t.displayName)} | ${t.targetLow ?? ""} | ${t.targetHigh ?? ""} | ${escapeCell(t.unit)} | ${escapeCell(t.targetText)} | ${escapeCell(t.guidelineId)} | ${escapeCell(t.population)} | ${escapeCell(t.sourceUrl)} | ${escapeCell(t.note)} |`
  );

  const profileNotes = [
    `- **Lab Assay Reference Interval is Primary:** Regional guidelines represent *clinical decision targets*, not analyzer-specific laboratory reference intervals. Always compare results against the lab PDF's printed range first.`,
    `- **Profile Stratification:** Adapted for country **${config.countryName}**, sex **${ctx.sex}**, age band **${ageBand}**${ctx.pregnant ? ", **pregnancy-adjusted glycemic/clinical thresholds active**" : ""}${ctx.isAsianAncestry ? ", **Asian-ancestry metabolic/BMI screening threshold noted**" : ""}.`,
    `- **Kidney Function (eGFR):** Uses race-free 2021 CKD-EPI interpretation (deprecated race-adjusted coefficients are not used).`,
    `- **Safety Notice:** This file is strictly informational and educational to support discussion with a licensed clinician. It is not a medical diagnosis or treatment plan.`,
  ];

  const markdown = [
    frontmatter,
    "",
    `# Regional Clinical Reference Guidelines — ${config.countryName} (${config.countryCode})`,
    "",
    `> Synced on \`${fetchedAt}\` via **${config.authority}** (mode: \`${sourceMode}\`, live endpoints verified: ${liveSuccessCount}/${fetchedSources.length}).`,
    "",
    "## Clinical Interpretation Guardrails",
    ...profileNotes,
    "",
    "## Structured Clinical Target Thresholds",
    "",
    ...targetTableHeader,
    ...targetTableRows,
    "",
    "## Official Sources & Live Verification Log",
    "",
    ...sourceLines,
    "",
  ].join("\n");

  const guidelinesPath = resolveGuidelinesPath(opts);
  fs.mkdirSync(path.dirname(guidelinesPath), { recursive: true });
  fs.writeFileSync(guidelinesPath, markdown, "utf8");

  return {
    guidelinesPath,
    country: config.countryCode,
    countryName: config.countryName,
    authority: config.authority,
    fetchedAt,
    expiresAt,
    sourceMode,
    sources: fetchedSources,
    targets,
    markdown,
    fetchErrors,
  };
}

function parseFrontmatter(markdown) {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const result = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else if (/^\d+$/.test(val)) {
      val = Number(val);
    }
    result[key] = val;
  }
  return result;
}

function parseTargetsTable(markdown) {
  const lines = markdown.split(/\r?\n/);
  const targets = [];
  let inTable = false;
  for (const line of lines) {
    if (line.trim().startsWith("| Canonical Key |")) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith("|")) {
      if (targets.length > 0) break;
      continue;
    }
    if (/^\|\s*-+/.test(line.trim())) continue;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map(c => c.trim().replace(/\\\|/g, "|"));
    if (cells.length < 9) continue;
    const targetLow = cells[2] !== "" && Number.isFinite(Number(cells[2])) ? Number(cells[2]) : null;
    const targetHigh = cells[3] !== "" && Number.isFinite(Number(cells[3])) ? Number(cells[3]) : null;
    targets.push({
      canonicalKey: cells[0],
      displayName: cells[1],
      targetLow,
      targetHigh,
      unit: cells[4] || null,
      targetText: cells[5],
      guidelineId: cells[6],
      population: cells[7],
      sourceUrl: cells[8],
      note: cells[9] || "",
      label: `${cells[6]} (${cells[7]})`,
    });
  }
  return targets;
}

function parseSourcesList(markdown) {
  const sources = [];
  const regex = /^- \*\*([^*]+)\*\* \((\d{4})\) — ([^:]+): (https:\/\/\S+)/gm;
  let m;
  while ((m = regex.exec(markdown)) !== null) {
    sources.push({
      id: m[1].trim(),
      year: Number(m[2]),
      topic: m[3].trim(),
      url: m[4].trim(),
    });
  }
  return sources;
}

export function readRegionalGuidelines(opts = {}) {
  const guidelinesPath = resolveGuidelinesPath(opts);
  if (!fs.existsSync(guidelinesPath)) {
    return {
      exists: false,
      path: guidelinesPath,
      frontmatter: null,
      stale: true,
      sources: [],
      targets: [],
      targetsByKey: {},
      markdown: null,
    };
  }
  const markdown = fs.readFileSync(guidelinesPath, "utf8");
  const frontmatter = parseFrontmatter(markdown);
  const targets = parseTargetsTable(markdown);
  const sources = parseSourcesList(markdown);
  const targetsByKey = {};
  for (const t of targets) {
    targetsByKey[t.canonicalKey] = t;
  }
  let stale = false;
  if (frontmatter.expires_at) {
    const exp = Date.parse(frontmatter.expires_at);
    if (!Number.isNaN(exp) && Date.now() > exp) stale = true;
  } else if (frontmatter.fetched_at) {
    const fetched = Date.parse(frontmatter.fetched_at);
    if (!Number.isNaN(fetched) && Date.now() - fetched > 365 * 24 * 60 * 60 * 1000) stale = true;
  }
  return {
    exists: true,
    path: guidelinesPath,
    frontmatter,
    stale,
    sources,
    targets,
    targetsByKey,
    markdown,
  };
}
