function cleanText(raw) {
  if (!raw || typeof raw !== "string") return "";
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9%+/.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-.\s]+|[-.\s]+$/g, "")
    .trim();
}

export function normalizeSpecimen(specimenHint = "serum", panelHint = "") {
  const combined = cleanText(`${specimenHint || ""} ${panelHint || ""}`);
  if (
    combined.includes("urin") ||
    combined.includes("orina") ||
    combined.includes("ego") ||
    combined.includes("examen general de orina") ||
    combined.includes("harn")
  ) {
    return "urine";
  }
  if (combined.includes("vital") || combined.includes("antropometr") || combined.includes("somatometr")) {
    return "vitals";
  }
  if (combined.includes("plasma") || combined.includes("plasmat")) {
    return "plasma";
  }
  if (
    combined.includes("sangre") ||
    combined.includes("blood") ||
    combined.includes("biometria") ||
    combined.includes("hemograma") ||
    combined.includes("cbc") ||
    combined.includes("blut")
  ) {
    return "blood";
  }
  return "serum";
}

export function normalizeUnit(unitRaw) {
  if (!unitRaw || typeof unitRaw !== "string") return null;
  let u = unitRaw.trim();
  if (!u || u === "-" || u === "---" || u === "/l.0") return null;
  // Strip stray out-of-range asterisk prefix (LAPI layout quirk: "* g/dL")
  u = u.replace(/^\*+\s*/, "").trim();
  if (!u) return null;

  const exactMap = new Map([
    ["mg/dl", "mg/dL"],
    ["mg/dL", "mg/dL"],
    ["mg / dl", "mg/dL"],
    ["mmol/l", "mmol/L"],
    ["mmol/L", "mmol/L"],
    ["mmol/mol", "mmol/mol"],
    ["umol/l", "umol/L"],
    ["µmol/l", "umol/L"],
    ["μmol/l", "umol/L"],
    ["ug/dl", "ug/dL"],
    ["µg/dl", "ug/dL"],
    ["μg/dl", "ug/dL"],
    ["mcg/dl", "ug/dL"],
    ["ug/l", "ug/L"],
    ["µg/l", "ug/L"],
    ["ng/ml", "ng/mL"],
    ["ng/dl", "ng/dL"],
    ["ng/l", "ng/L"],
    ["pg/ml", "pg/mL"],
    ["pg/dl", "pg/dL"],
    ["pmol/l", "pmol/L"],
    ["g/dl", "g/dL"],
    ["g/l", "g/L"],
    ["gr/dl", "g/dL"],
    ["mg/l", "mg/L"],
    ["u/l", "U/L"],
    ["ui/l", "U/L"],
    ["iu/l", "U/L"],
    ["u/ml", "U/mL"],
    ["ui/ml", "U/mL"],
    ["mu/l", "mIU/L"],
    ["mui/l", "mIU/L"],
    ["miu/l", "mIU/L"],
    ["uui/ml", "mIU/L"],
    ["µui/ml", "mIU/L"],
    ["μui/ml", "mIU/L"],
    ["uiu/ml", "mIU/L"],
    ["µiu/ml", "mIU/L"],
    ["meq/l", "mEq/L"],
    ["ml/min", "mL/min/1.73m2"],
    ["ml/min/1.73m2", "mL/min/1.73m2"],
    ["ml/min/1.73 m2", "mL/min/1.73m2"],
    ["ml/min/1.73m^2", "mL/min/1.73m2"],
    ["ml/min/1.73 m^2", "mL/min/1.73m2"],
    ["ml/min/1.73 m²", "mL/min/1.73m2"],
    ["ml/min/1.73m²", "mL/min/1.73m2"],
    ["%", "%"],
    ["fl", "fL"],
    ["pg", "pg"],
    ["10^3/ul", "10^3/uL"],
    ["10^3/µl", "10^3/uL"],
    ["x10^3/ul", "10^3/uL"],
    ["x10^3/µl", "10^3/uL"],
    ["x 10^3/ul", "10^3/uL"],
    ["x 10^3/µl", "10^3/uL"],
    ["x 10^3/μl", "10^3/uL"],
    ["10*3/ul", "10^3/uL"],
    ["10*3/µl", "10^3/uL"],
    ["10e3/ul", "10^3/uL"],
    ["k/ul", "10^3/uL"],
    ["k/µl", "10^3/uL"],
    ["miles/ul", "10^3/uL"],
    ["miles/µl", "10^3/uL"],
    ["miles/mm3", "10^3/uL"],
    ["10^6/ul", "10^6/uL"],
    ["10^6/µl", "10^6/uL"],
    ["x10^6/ul", "10^6/uL"],
    ["x10^6/µl", "10^6/uL"],
    ["x 10^6/ul", "10^6/uL"],
    ["x 10^6/µl", "10^6/uL"],
    ["x 10^6/μl", "10^6/uL"],
    ["10*6/ul", "10^6/uL"],
    ["10*6/µl", "10^6/uL"],
    ["10e6/ul", "10^6/uL"],
    ["m/ul", "10^6/uL"],
    ["m/µl", "10^6/uL"],
    ["millones/ul", "10^6/uL"],
    ["millones/µl", "10^6/uL"],
    ["millones/mm3", "10^6/uL"],
    ["cels/ul", "cells/uL"],
    ["cels/µl", "cells/uL"],
    ["cels/μl", "cells/uL"],
    ["cel/ul", "cells/uL"],
    ["cel/µl", "cells/uL"],
    ["/campo", "/hpf"],
    ["x campo", "/hpf"],
    ["mmhg", "mmHg"],
    ["mm/hg", "mmHg"],
    ["mm hg", "mmHg"],
    ["cm.", "cm"],
    ["cm", "cm"],
    ["kg", "kg"],
    ["kg.", "kg"],
    ["kg/m2", "kg/m2"],
    ["kg/m²", "kg/m2"],
    ["m", "m"],
    ["lpm", "bpm"],
    ["bpm", "bpm"],
    ["ng/ml/h", "ng/mL/h"],
    ["ng/ml/hr", "ng/mL/h"],
    ["nmol/l", "nmol/L"],
    ["cociente", "ratio"],
    ["indice", "ratio"],
    ["relacion", "ratio"],
    ["mm/h", "mm/h"],
    ["mm/hr", "mm/h"],
  ]);

  const lower = u.toLowerCase().replace(/\s+/g, " ");
  if (exactMap.has(lower)) return exactMap.get(lower);

  // Normalize micro symbol & casing cleanly
  return u
    .replace(/[µμ]/g, "u")
    .replace(/\/dl\b/gi, "/dL")
    .replace(/\/ml\b/gi, "/mL")
    .replace(/\/ul\b/gi, "/uL")
    .replace(/\/l\b/gi, "/L");
}

// Each entry: { canonicalKey, displayName, panel, specimen, defaultUnit, aliases, excludeSubstrings? }
export const ANALYTE_CATALOG = [
  // === LIPIDS ===
  {
    canonicalKey: "serum:ldl_direct",
    displayName: "LDL Cholesterol (Direct)",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "ldl cholesterol (direct)", "ldl cholesterol direct", "ldl-c, measured", "ldl-c measured",
      "ldl direct", "colesterol ldl directo", "ldl directo", "direktes ldl",
    ],
  },
  {
    canonicalKey: "serum:ldl",
    displayName: "LDL Cholesterol",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "colesterol ldl", "colesterol de baja densidad", "colesterol de baja densidad (ldl)",
      "c-ldl", "ldl-c", "ldl cholesterol", "ldl-cholesterin", "colesterol ldl calculado",
      "ldl calculado", "ldl", "l.d.l.", "l.d.l", "colesterol l.d.l.",
    ],
    excludeSubstrings: ["relacion", "indice", "cociente", "ldl/hdl"],
  },
  {
    canonicalKey: "serum:hdl",
    displayName: "HDL Cholesterol",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "colesterol hdl", "colesterol de alta densidad", "colesterol de alta densidad (hdl)",
      "c-hdl", "hdl-c", "hdl cholesterol", "hdl-cholesterin", "hdl", "h.d.l.", "h.d.l",
      "colesterol h.d.l.",
    ],
    excludeSubstrings: ["relacion", "indice", "cociente", "no hdl", "no-hdl", "ldl/hdl", "total/hdl"],
  },
  {
    canonicalKey: "serum:total_cholesterol",
    displayName: "Total Cholesterol",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "colesterol total", "colesterol", "total cholesterol", "gesamtcholesterin", "cholesterin",
    ],
    excludeSubstrings: ["relacion", "indice", "cociente", "ldl", "hdl", "vldl", "no hdl", "no-hdl"],
  },
  {
    canonicalKey: "serum:ldl_hdl_ratio",
    displayName: "LDL / HDL Ratio",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: [
      "relacion ldl/hdl", "relacion ldl / hdl", "relacion colesterol ldl/hdl",
      "relacion colesterol-ldl/colesterol", "relacion colesterol-ldl/colesterol-hdl",
      "colesterol ldl/hdl", "indice ldl/hdl", "ldl/hdl ratio", "ldl/hdl",
    ],
  },
  {
    canonicalKey: "serum:triglycerides",
    displayName: "Triglycerides",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "trigliceridos", "triglycerides", "triglyceride", "trig",
    ],
  },
  {
    canonicalKey: "serum:vldl",
    displayName: "VLDL Cholesterol",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "colesterol vldl", "colesterol de muy baja densidad", "vldl", "v.l.d.l.", "vldl cholesterol",
    ],
  },
  {
    canonicalKey: "serum:non_hdl_cholesterol",
    displayName: "Non-HDL Cholesterol",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "colesterol no hdl", "colesterol no-hdl", "non-hdl cholesterol", "non hdl cholesterol",
      "nicht-hdl-cholesterin",
    ],
  },
  {
    canonicalKey: "serum:atherogenic_index",
    displayName: "Atherogenic Index (Total/HDL)",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: [
      "indice aterogenico", "relacion colesterol total/hdl",
      "relacion colesterol total/colesterol", "relacion colesterol total/colesterol hdl",
      "indice de castelli", "atherogenic index", "total cholesterol/hdl ratio",
      "colesterol total / hdl",
    ],
  },
  {
    canonicalKey: "serum:apob",
    displayName: "Apolipoprotein B",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["apolipoproteina b", "apob", "apo b", "apolipoprotein b"],
  },
  {
    canonicalKey: "serum:lp_a",
    displayName: "Lipoprotein(a)",
    panel: "Lipids",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["lipoproteina (a)", "lipoproteina a", "lp(a)", "lipoprotein(a)"],
  },

  // === GLUCOSE & METABOLIC ===
  {
    canonicalKey: "serum:glucose",
    displayName: "Fasting Glucose (Serum)",
    panel: "Glucose & Metabolic",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "glucosa", "glucosa en ayuno", "glucosa serica", "glucosa en suero",
      "glucose", "fasting glucose", "blutzucker", "glukose",
    ],
  },
  {
    canonicalKey: "serum:hba1c",
    displayName: "Hemoglobin A1c (HbA1c)",
    panel: "Glucose & Metabolic",
    specimen: "serum",
    defaultUnit: "%",
    aliases: [
      "hemoglobina glucosilada", "hemoglobina glucosilada (hba1c)", "hemoglobina glucosilada a1c",
      "hemoglobina glicosilada", "hba1c", "hb a1c", "fraccion a1c", "fraccion a1c (hba1c)",
      "hemoglobin a1c", "glycated hemoglobin", "a1c",
    ],
  },
  {
    canonicalKey: "serum:eag",
    displayName: "Estimated Average Glucose (eAG)",
    panel: "Glucose & Metabolic",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "glucosa promedio estimada", "glucosa promedio estimada (gpe)", "gpe",
      "estimated average glucose", "eag",
    ],
  },
  {
    canonicalKey: "serum:insulin",
    displayName: "Fasting Insulin",
    panel: "Glucose & Metabolic",
    specimen: "serum",
    defaultUnit: "uIU/mL",
    aliases: ["insulina", "insulina basal", "insulin", "fasting insulin"],
  },
  {
    canonicalKey: "serum:tyg_index",
    displayName: "TyG Index",
    panel: "Glucose & Metabolic",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: ["indice tyg", "tyg index", "indice trigliceridos glucosa", "tyg"],
  },
  {
    canonicalKey: "serum:uric_acid",
    displayName: "Uric Acid",
    panel: "Glucose & Metabolic",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["acido urico", "acido urico en suero", "uric acid", "harnsaure"],
  },

  // === COMPLETE BLOOD COUNT (BLOOD) ===
  {
    canonicalKey: "blood:hemoglobin",
    displayName: "Hemoglobin (Blood)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "g/dL",
    aliases: ["hemoglobina", "hemoglobin", "hamoglobin", "hb"],
    excludeSubstrings: ["glucosilada", "glicosilada", "a1c", "corpuscular", "media"],
  },
  {
    canonicalKey: "blood:hematocrit",
    displayName: "Hematocrit",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: ["hematocrito", "hematocrit", "hamatokrit", "hto", "hct"],
  },
  {
    canonicalKey: "blood:rbc",
    displayName: "Red Blood Cells (Erythrocytes)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^6/uL",
    aliases: [
      "eritrocitos", "globulos rojos", "cuenta de eritrocitos", "recuento de eritrocitos",
      "red blood cells", "erythrocytes", "rbc", "erythrozyten",
    ],
  },
  {
    canonicalKey: "blood:mcv",
    displayName: "MCV (Mean Corpuscular Volume)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "fL",
    aliases: [
      "volumen globular medio", "volumen corpuscular medio", "vgm", "vcm", "mcv",
      "mean corpuscular volume",
    ],
  },
  {
    canonicalKey: "blood:mch",
    displayName: "MCH (Mean Corpuscular Hemoglobin)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "pg",
    aliases: [
      "hemoglobina corpuscular media", "hemoglobina globular media", "hcm", "hgm", "mch",
    ],
    excludeSubstrings: ["concentracion"],
  },
  {
    canonicalKey: "blood:mchc",
    displayName: "MCHC",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "g/dL",
    aliases: [
      "concentracion media de hemoglobina", "concentracion media de hemoglobina corpuscular",
      "concentracion media de hb", "concentracion media de", "cmhc", "cmhg", "chcm", "mchc",
    ],
  },
  {
    canonicalKey: "blood:rdw",
    displayName: "RDW (Red Cell Distribution Width)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: [
      "ancho de distribucion eritrocitaria", "amplitud de distribucion eritrocitaria",
      "indice de distribucion de eritrocitos", "rdw", "rdw-cv", "ide", "ade",
    ],
  },
  {
    canonicalKey: "blood:wbc",
    displayName: "White Blood Cells (Leukocytes)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: [
      "leucocitos", "globulos blancos", "cuenta de leucocitos", "recuento de leucocitos",
      "leucocitos totales", "white blood cells", "leukocytes", "wbc", "leukozyten",
    ],
  },
  {
    canonicalKey: "blood:platelets",
    displayName: "Platelets",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: [
      "plaquetas", "cuenta de plaquetas", "recuento de plaquetas", "platelets", "plt", "thrombozyten",
    ],
    excludeSubstrings: ["volumen"],
  },
  {
    canonicalKey: "blood:mpv",
    displayName: "Mean Platelet Volume (MPV)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "fL",
    aliases: ["volumen plaquetario medio", "vpm", "mpv", "mean platelet volume"],
  },
  {
    canonicalKey: "blood:neutrophils_pct",
    displayName: "Neutrophils (%)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: ["neutrofilos %", "neutrofilos (%)", "neutrofilos relativos", "neutrophils %", "neutrofilos segmentados %", "segmentados %"],
  },
  {
    canonicalKey: "blood:neutrophils_abs",
    displayName: "Neutrophils (Absolute)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: ["neutrofilos absolutos", "neutrofilos #", "neutrofilos totales", "neutrophils absolute", "neutrofilos"],
  },
  {
    canonicalKey: "blood:lymphocytes_pct",
    displayName: "Lymphocytes (%)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: ["linfocitos %", "linfocitos (%)", "linfocitos relativos", "lymphocytes %"],
  },
  {
    canonicalKey: "blood:lymphocytes_abs",
    displayName: "Lymphocytes (Absolute)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: ["linfocitos absolutos", "linfocitos #", "linfocitos totales", "lymphocytes absolute", "linfocitos"],
  },
  {
    canonicalKey: "blood:monocytes_pct",
    displayName: "Monocytes (%)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: ["monocitos %", "monocitos (%)", "monocitos relativos", "monocytes %"],
  },
  {
    canonicalKey: "blood:monocytes_abs",
    displayName: "Monocytes (Absolute)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: ["monocitos absolutos", "monocitos #", "monocitos totales", "monocytes absolute", "monocitos"],
  },
  {
    canonicalKey: "blood:eosinophils_pct",
    displayName: "Eosinophils (%)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: ["eosinofilos %", "eosinofilos (%)", "eosinofilos relativos", "eosinophils %"],
  },
  {
    canonicalKey: "blood:eosinophils_abs",
    displayName: "Eosinophils (Absolute)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: ["eosinofilos absolutos", "eosinofilos #", "eosinofilos totales", "eosinophils absolute", "eosinofilos"],
  },
  {
    canonicalKey: "blood:basophils_pct",
    displayName: "Basophils (%)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "%",
    aliases: ["basofilos %", "basofilos (%)", "basofilos relativos", "basophils %"],
  },
  {
    canonicalKey: "blood:basophils_abs",
    displayName: "Basophils (Absolute)",
    panel: "Complete Blood Count",
    specimen: "blood",
    defaultUnit: "10^3/uL",
    aliases: ["basofilos absolutos", "basofilos #", "basofilos totales", "basophils absolute", "basofilos"],
  },

  // === KIDNEY & ELECTROLYTES ===
  {
    canonicalKey: "serum:creatinine",
    displayName: "Creatinine (Serum)",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["creatinina", "creatinina en suero", "creatinina serica", "creatinine", "kreatinin"],
    excludeSubstrings: ["depuracion", "relacion", "bun", "orina"],
  },
  {
    canonicalKey: "serum:egfr",
    displayName: "eGFR (Estimated Glomerular Filtration Rate)",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mL/min/1.73m2",
    aliases: [
      "tfge", "tasa de filtracion glomerular", "tasa de filtracion glomerular estimada",
      "tasa filt. glomerular", "tasa filt glomerular",
      "depuracion de creatinina calculada", "filtracion glomerular", "egfr", "gfr",
      "ckd-epi", "tasa de filtrado glomerular",
    ],
  },
  {
    canonicalKey: "serum:bun",
    displayName: "BUN (Blood Urea Nitrogen)",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: [
      "nitrogeno ureico", "nitrogeno ureico en sangre", "nitrogeno ureico (bun)",
      "nitrogeno de urea", "bun", "blood urea nitrogen",
    ],
    excludeSubstrings: ["creatinina", "relacion"],
  },
  {
    canonicalKey: "serum:urea",
    displayName: "Urea",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["urea", "urea en suero", "urea serica", "harnstoff"],
    excludeSubstrings: ["nitrogeno"],
  },
  {
    canonicalKey: "serum:bun_creatinine_ratio",
    displayName: "BUN / Creatinine Ratio",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: [
      "relacion bun/creatinina", "relacion bun / creatinina", "bun/creatinine", "bun/creatinina",
      "relacion nitrogeno ureico/creatinina", "relacion nitrogeno",
    ],
  },
  {
    canonicalKey: "serum:sodium",
    displayName: "Sodium",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mEq/L",
    aliases: ["sodio", "sodio en suero", "sodium", "natrium", "na"],
  },
  {
    canonicalKey: "serum:potassium",
    displayName: "Potassium",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mEq/L",
    aliases: ["potasio", "potasio en suero", "potassium", "kalium"],
  },
  {
    canonicalKey: "serum:chloride",
    displayName: "Chloride",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mEq/L",
    aliases: ["cloro", "cloruro", "cloro en suero", "chloride", "chlorid"],
  },
  {
    canonicalKey: "serum:calcium",
    displayName: "Calcium",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["calcio", "calcio total", "calcio en suero", "calcium", "kalzium"],
  },
  {
    canonicalKey: "serum:phosphorus",
    displayName: "Phosphorus",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["fosforo", "fosforo en suero", "phosphorus", "phosphat"],
  },
  {
    canonicalKey: "serum:magnesium",
    displayName: "Magnesium",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["magnesio", "magnesio en suero", "magnesium"],
  },
  {
    canonicalKey: "serum:co2",
    displayName: "Bicarbonate (CO2)",
    panel: "Kidney & Electrolytes",
    specimen: "serum",
    defaultUnit: "mEq/L",
    aliases: ["bicarbonato", "co2", "co2 total", "bicarbonate", "dioxido de carbono"],
  },

  // === LIVER & PANCREAS ===
  {
    canonicalKey: "serum:ast",
    displayName: "AST (TGO)",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: [
      "aspartato aminotransferasa", "aspartato aminotransferasa tgo ast",
      "aspartato aminotransferasa (ast)", "aspartato aminotransferasa (tgo)",
      "aspartato", "tgo", "t.g.o.", "t.g.o. (ast)", "tgo (ast)", "ast", "ast (tgo)", "got",
    ],
  },
  {
    canonicalKey: "serum:alt",
    displayName: "ALT (TGP)",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: [
      "alanino aminotransferasa", "alanina aminotransferasa",
      "alanino aminotransferasa tgp alt", "alanina aminotransferasa (alt)",
      "tgp", "t.g.p.", "t.g.p. (alt)", "tgp (alt)", "alt", "alt (tgp)", "gpt",
    ],
  },
  {
    canonicalKey: "serum:ggt",
    displayName: "GGT (Gamma-Glutamyl Transferase)",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: [
      "gamma glutamil transferasa", "gama glutamil transferasa",
      "gamma-glutamil transferasa", "gama-glutamil transpeptidasa",
      "gamma glutamil transpeptidasa", "gamma-glutamil transpeptidasa",
      "ggt", "g.g.t.", "gamma-gt",
    ],
  },
  {
    canonicalKey: "serum:alkaline_phosphatase",
    displayName: "Alkaline Phosphatase (ALP)",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: ["fosfatasa alcalina", "alkaline phosphatase", "alkalische phosphatase", "alp"],
  },
  {
    canonicalKey: "serum:ldh",
    displayName: "LDH (Lactate Dehydrogenase)",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: [
      "deshidrogenasa lactica", "lactato deshidrogenasa", "dhl", "ldh", "d.h.l.",
    ],
  },
  {
    canonicalKey: "serum:total_bilirubin",
    displayName: "Total Bilirubin",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["bilirrubina total", "total bilirubin", "gesamtbilirubin"],
  },
  {
    canonicalKey: "serum:direct_bilirubin",
    displayName: "Direct Bilirubin",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["bilirrubina directa", "direct bilirubin", "direktes bilirubin"],
  },
  {
    canonicalKey: "serum:indirect_bilirubin",
    displayName: "Indirect Bilirubin",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["bilirrubina indirecta", "indirect bilirubin", "indirektes bilirubin"],
  },
  {
    canonicalKey: "serum:total_protein",
    displayName: "Total Protein",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "g/dL",
    aliases: ["proteinas totales", "total protein", "gesamteiweiss"],
  },
  {
    canonicalKey: "serum:albumin",
    displayName: "Albumin",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "g/dL",
    aliases: ["albumina", "albumina en suero", "albumin"],
    excludeSubstrings: ["relacion", "globulina"],
  },
  {
    canonicalKey: "serum:globulin",
    displayName: "Globulin",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "g/dL",
    aliases: ["globulina", "globulinas", "globulin"],
    excludeSubstrings: ["relacion", "albumina"],
  },
  {
    canonicalKey: "serum:ag_ratio",
    displayName: "Albumin / Globulin Ratio",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: [
      "relacion a/g", "relacion albumina/globulina", "relacion albumina/globulinas",
      "relacion a / g", "a/g ratio", "albumin/globulin ratio",
    ],
  },
  {
    canonicalKey: "serum:amylase",
    displayName: "Amylase",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: ["amilasa", "amilasa serica", "amylase"],
  },
  {
    canonicalKey: "serum:lipase",
    displayName: "Lipase",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: ["lipasa", "lipasa serica", "lipase"],
  },
  {
    canonicalKey: "serum:cpk",
    displayName: "Creatine Kinase (CPK / CK)",
    panel: "Liver & Pancreas",
    specimen: "serum",
    defaultUnit: "U/L",
    aliases: ["creatinfosfoquinasa", "creatinquinasa", "creatina cinasa", "cpk", "ck", "ck total", "creatine kinase"],
  },

  // === IRON & VITAMINS ===
  {
    canonicalKey: "serum:tibc",
    displayName: "TIBC (Total Iron Binding Capacity)",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "ug/dL",
    aliases: [
      "capacidad total de fijacion de hierro", "capacidad de fijacion de hierro",
      "capacidad de fijacion de transferrina", "capacidad total de fijacion de transferrina",
      "ctfh", "tibc", "total iron binding capacity",
    ],
  },
  {
    canonicalKey: "serum:uibc",
    displayName: "UIBC (Unsaturated Iron Binding Capacity)",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "ug/dL",
    aliases: [
      "capacidad latente de fijacion de hierro", "capacidad no saturada de fijacion de hierro",
      "uibc", "unsaturated iron binding capacity",
    ],
  },
  {
    canonicalKey: "serum:transferrin_saturation",
    displayName: "Transferrin Saturation (%)",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "%",
    aliases: [
      "saturacion de transferrina", "% saturacion de transferrina", "porcentaje de saturacion",
      "indice de saturacion de transferrina", "transferrin saturation", "saturacion de hierro",
    ],
  },
  {
    canonicalKey: "serum:transferrin",
    displayName: "Transferrin",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "mg/dL",
    aliases: ["transferrina", "transferrin"],
    excludeSubstrings: ["capacidad", "fijacion", "saturacion"],
  },
  {
    canonicalKey: "serum:iron",
    displayName: "Serum Iron",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "ug/dL",
    aliases: ["hierro", "hierro serico", "fierro", "fierro serico", "serum iron", "iron", "eisen"],
    excludeSubstrings: ["capacidad", "fijacion", "saturacion"],
  },
  {
    canonicalKey: "serum:ferritin",
    displayName: "Ferritin",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "ng/mL",
    aliases: ["ferritina", "ferritina serica", "ferritin"],
  },
  {
    canonicalKey: "serum:vitamin_b12",
    displayName: "Vitamin B12",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "pg/mL",
    aliases: ["vitamina b12", "vitamina b-12", "vitamina b 12", "vitamin b12", "cobalamina"],
  },
  {
    canonicalKey: "serum:folate",
    displayName: "Folate (Folic Acid)",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "ng/mL",
    aliases: ["acido folico", "folato", "folatos", "folate", "folic acid", "folsaure"],
  },
  {
    canonicalKey: "serum:vitamin_d",
    displayName: "Vitamin D (25-OH)",
    panel: "Iron & Vitamins",
    specimen: "serum",
    defaultUnit: "ng/mL",
    aliases: ["vitamina d", "25-oh vitamina d", "25 hidroxivitamina d", "vitamin d", "25-hydroxyvitamin d"],
  },

  // === THYROID ===
  {
    canonicalKey: "serum:tsh",
    displayName: "TSH (Thyroid Stimulating Hormone)",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "mIU/L",
    aliases: [
      "hormona estimulante de tiroides", "hormona estimulante de la tiroides",
      "hormona estimulante de", "tirotropina", "tsh", "tsh ultrasensible", "tsh (ultrasensible)",
    ],
  },
  {
    canonicalKey: "serum:t4_free",
    displayName: "Free T4 (FT4)",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "ng/dL",
    aliases: ["tiroxina libre", "t4 libre", "t4l", "free t4", "ft4", "freies t4"],
  },
  {
    canonicalKey: "serum:t4_total",
    displayName: "Total T4",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "ug/dL",
    aliases: ["tiroxina total", "t4 total", "total t4", "tiroxina"],
    excludeSubstrings: ["libre", "indice"],
  },
  {
    canonicalKey: "serum:t3_free",
    displayName: "Free T3 (FT3)",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "pg/mL",
    aliases: ["triyodotironina libre", "t3 libre", "t3l", "free t3", "ft3", "freies t3"],
  },
  {
    canonicalKey: "serum:t3_total",
    displayName: "Total T3",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "ng/dL",
    aliases: ["triyodotironina total", "t3 total", "total t3", "triyodotironina"],
    excludeSubstrings: ["libre", "captacion"],
  },
  {
    canonicalKey: "serum:t3_uptake",
    displayName: "T3 Uptake",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "%",
    aliases: ["captacion de t3", "t3 captacion", "t-uptake", "t3 uptake"],
  },
  {
    canonicalKey: "serum:free_thyroxine_index",
    displayName: "Free Thyroxine Index (FTI)",
    panel: "Thyroid",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: ["indice de tiroxina libre", "itl", "fti", "free thyroxine index"],
  },

  // === INFLAMMATION ===
  {
    canonicalKey: "serum:hs_crp",
    displayName: "hs-CRP (High-Sensitivity C-Reactive Protein)",
    panel: "Inflammation",
    specimen: "serum",
    defaultUnit: "mg/L",
    aliases: [
      "proteina c reactiva ultrasensible", "proteina c reactiva ultra sensible",
      "proteina c reactiva (ultra sensible)", "proteina c reactiva (ultrasensible)",
      "proteina c reactiva de alta sensibilidad",
      "pcr ultrasensible", "pcr ultra sensible", "pcr alta sensibilidad",
      "hs-crp", "hscrp", "high sensitivity crp",
    ],
  },
  {
    canonicalKey: "serum:crp",
    displayName: "C-Reactive Protein (CRP)",
    panel: "Inflammation",
    specimen: "serum",
    defaultUnit: "mg/L",
    aliases: ["proteina c reactiva", "pcr", "crp", "c-reactive protein"],
    excludeSubstrings: ["ultrasensible", "alta sensibilidad", "hs"],
  },
  {
    canonicalKey: "blood:esr",
    displayName: "ESR (Erythrocyte Sedimentation Rate)",
    panel: "Inflammation",
    specimen: "blood",
    defaultUnit: "mm/h",
    aliases: ["velocidad de sedimentacion globular", "vsg", "esr", "bsg"],
  },

  // === ENDOCRINE ===
  {
    canonicalKey: "serum:aldosterone",
    displayName: "Aldosterone (Serum)",
    panel: "Endocrine",
    specimen: "serum",
    defaultUnit: "ng/dL",
    aliases: ["aldosterona", "aldosterona suero", "aldosterona en suero", "aldosterone", "aldosterone serum"],
    excludeSubstrings: ["renina", "indice", "relacion"],
  },
  {
    canonicalKey: "plasma:renin_activity",
    displayName: "Plasma Renin Activity (PRA)",
    panel: "Endocrine",
    specimen: "plasma",
    defaultUnit: "ng/mL/h",
    aliases: [
      "renina plasmatica actividad", "actividad de renina plasmatica", "renina plasmatica",
      "renina", "plasma renin activity", "renin activity",
    ],
    excludeSubstrings: ["aldosterona", "indice", "relacion"],
  },
  {
    canonicalKey: "serum:aldosterone_renin_ratio",
    displayName: "Aldosterone / Renin Ratio (ARR)",
    panel: "Endocrine",
    specimen: "serum",
    defaultUnit: "ratio",
    aliases: [
      "indice aldosterona/renina", "relacion aldosterona/renina", "aldosterona/renina",
      "aldosterone/renin ratio", "aldosterone renin ratio", "arr",
    ],
  },
  {
    canonicalKey: "plasma:metanephrine",
    displayName: "Plasma Free Metanephrine",
    panel: "Endocrine",
    specimen: "plasma",
    defaultUnit: "nmol/L",
    aliases: ["metanefrina libre", "metanefrina plasmatica", "metanefrinas libres", "metanephrine", "metanefrina"],
    excludeSubstrings: ["normetanefrina"],
  },
  {
    canonicalKey: "plasma:normetanephrine",
    displayName: "Plasma Free Normetanephrine",
    panel: "Endocrine",
    specimen: "plasma",
    defaultUnit: "nmol/L",
    aliases: ["normetanefrina libre", "normetanefrina plasmatica", "normetanephrine", "normetanefrina"],
  },

  // === SEROLOGY & INFECTIOUS ===
  {
    canonicalKey: "serum:vdrl",
    displayName: "VDRL (Syphilis Screen)",
    panel: "Serology",
    specimen: "serum",
    defaultUnit: null,
    aliases: ["vdrl", "v.d.r.l.", "vdrl en suero", "reacciones lueticas"],
  },
  {
    canonicalKey: "serum:anti_hcv",
    displayName: "Anti-HCV (Hepatitis C Antibody)",
    panel: "Serology",
    specimen: "serum",
    defaultUnit: null,
    aliases: ["anti-hcv", "anti hvc", "anti-hvc", "anticuerpos anti hepatitis c", "hepatitis c", "anticuerpos virus hepatitis c", "anti hcv"],
  },
  {
    canonicalKey: "serum:anti_hiv",
    displayName: "Anti-HIV 1+2 (4th Gen)",
    panel: "Serology",
    specimen: "serum",
    defaultUnit: null,
    aliases: [
      "anti-vih", "vih", "hiv", "anti-hiv", "ac. anti - h.i.v.", "ac anti h i v",
      "ac. anti - h.i.v. 1 + 2", "anticuerpos anti vih",
      "anticuerpos anti-vih 1 y 2", "vih 1 y 2", "anti-vih 1+2", "antígeno p24",
    ],
  },

  // === URINALYSIS (URINE) ===
  {
    canonicalKey: "urine:glucose",
    displayName: "Glucose (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: "mg/dL",
    aliases: ["glucosa", "glucose", "glucosa en orina"],
  },
  {
    canonicalKey: "urine:proteins",
    displayName: "Proteins (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: "mg/dL",
    aliases: ["proteinas", "proteina", "proteins", "protein"],
  },
  {
    canonicalKey: "urine:hemoglobin",
    displayName: "Hemoglobin / Blood (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["hemoglobina", "sangre", "hemoglobin", "blood"],
  },
  {
    canonicalKey: "urine:bilirubin",
    displayName: "Bilirubin (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["bilirrubina", "bilirrubinas", "bilirubin"],
  },
  {
    canonicalKey: "urine:ketones",
    displayName: "Ketones (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: "mg/dL",
    aliases: ["cetonas", "cetona", "cuerpos cetonicos", "ketones"],
  },
  {
    canonicalKey: "urine:urobilinogen",
    displayName: "Urobilinogen (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: "mg/dL",
    aliases: ["urobilinogeno", "urobilinogen"],
  },
  {
    canonicalKey: "urine:nitrites",
    displayName: "Nitrites (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["nitritos", "nitrites"],
  },
  {
    canonicalKey: "urine:leukocyte_esterase",
    displayName: "Leukocyte Esterase (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["esterasa leucocitaria", "leucocitos (esterasa)", "leucocitos esterasa", "leukocyte esterase"],
  },
  {
    canonicalKey: "urine:wbc",
    displayName: "Leukocytes (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: "cells/uL",
    aliases: ["leucocitos", "leukocytes", "wbc"],
    excludeSubstrings: ["esterasa"],
  },
  {
    canonicalKey: "urine:rbc",
    displayName: "Erythrocytes (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: "cells/uL",
    aliases: ["eritrocitos", "hematies", "erythrocytes", "rbc"],
  },
  {
    canonicalKey: "urine:ph",
    displayName: "pH (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["ph", "p.h."],
  },
  {
    canonicalKey: "urine:specific_gravity",
    displayName: "Specific Gravity (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["densidad", "densidad urinaria", "gravedad especifica", "specific gravity"],
  },
  {
    canonicalKey: "urine:color",
    displayName: "Color (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["color"],
  },
  {
    canonicalKey: "urine:appearance",
    displayName: "Appearance (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["aspecto", "apariencia", "appearance"],
  },
  {
    canonicalKey: "urine:epithelial_cells",
    displayName: "Epithelial Cells (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["celulas epiteliales", "celulas epiteliales escamosas", "epithelial cells"],
  },
  {
    canonicalKey: "urine:bacteria",
    displayName: "Bacteria (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["bacterias", "bacteria"],
  },
  {
    canonicalKey: "urine:crystals",
    displayName: "Crystals (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["cristales", "crystals"],
  },
  {
    canonicalKey: "urine:casts",
    displayName: "Casts (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["cilindros", "casts"],
  },
  {
    canonicalKey: "urine:mucus",
    displayName: "Mucus Filaments (Urine)",
    panel: "Urinalysis",
    specimen: "urine",
    defaultUnit: null,
    aliases: ["filamento de mucina", "filamentos de moco", "filamento mucoide", "moco", "mucus"],
  },

  // === VITALS & ANTHROPOMETRICS ===
  {
    canonicalKey: "vitals:blood_pressure",
    displayName: "Blood Pressure",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "mmHg",
    aliases: [
      "presion arterial", "tension arterial", "t/a", "t.a.", "blood pressure", "blutdruck",
    ],
  },
  {
    canonicalKey: "vitals:systolic_bp",
    displayName: "Systolic Blood Pressure",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "mmHg",
    aliases: ["presion sistolica", "tension sistolica", "systolic bp", "systolic blood pressure"],
  },
  {
    canonicalKey: "vitals:diastolic_bp",
    displayName: "Diastolic Blood Pressure",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "mmHg",
    aliases: ["presion diastolica", "tension diastolica", "diastolic bp", "diastolic blood pressure"],
  },
  {
    canonicalKey: "vitals:weight",
    displayName: "Weight",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "kg",
    aliases: ["peso", "weight", "gewicht"],
  },
  {
    canonicalKey: "vitals:height",
    displayName: "Height",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "cm",
    aliases: ["talla", "estatura", "altura", "height", "grosse"],
  },
  {
    canonicalKey: "vitals:bmi",
    displayName: "Body Mass Index (BMI)",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "kg/m2",
    aliases: ["imc", "indice de masa corporal", "bmi", "body mass index"],
  },
  {
    canonicalKey: "vitals:waist_circumference",
    displayName: "Waist Circumference",
    panel: "Vitals & Anthropometrics",
    specimen: "vitals",
    defaultUnit: "cm",
    aliases: ["cintura", "perimetro abdominal", "perimetro de cintura", "circunferencia de cintura", "waist circumference"],
  },
];

const CATALOG_BY_KEY = new Map(ANALYTE_CATALOG.map(entry => [entry.canonicalKey, entry]));

export function getAnalyteDefinition(canonicalKey) {
  return CATALOG_BY_KEY.get(canonicalKey) || null;
}

export function resolveAnalyte(rawName, specimenHint = "serum", unitHint = "", panelHint = "", methodHint = "") {
  const cleaned = cleanText(rawName);
  const specimen = normalizeSpecimen(specimenHint, panelHint);
  const normUnit = normalizeUnit(unitHint);
  const cleanMethod = cleanText(methodHint);

  // Special disambiguation for CBC percentage vs absolute counts when rawName is just "Neutrófilos" / "Linfocitos"
  const isPctUnit = normUnit === "%";
  const isDirectLdlMethod = cleanMethod.includes("direct");

  // Search specimen-matched entries first, then cross-blood/serum (never mix urine with serum/blood!)
  const eligible = ANALYTE_CATALOG.filter(entry => {
    if (specimen === "urine") return entry.specimen === "urine";
    if (specimen === "vitals") return entry.specimen === "vitals";
    // Non-urine, non-vitals: never match urine or vitals unless rawName explicitly mentions it
    if (entry.specimen === "urine") return false;
    return true;
  });

  // 1. Exact alias match (preferring specimen match and unit-compatible CBC % vs abs)
  let bestExact = null;
  let bestExactScore = -1;
  for (const entry of eligible) {
    if (entry.excludeSubstrings?.some(ex => cleaned.includes(ex))) continue;
    for (const alias of entry.aliases) {
      const cleanAlias = cleanText(alias);
      if (cleaned === cleanAlias) {
        let score = 100;
        if (entry.specimen === specimen) score += 20;
        if (entry.canonicalKey.endsWith("_pct") && isPctUnit) score += 15;
        if (entry.canonicalKey.endsWith("_abs") && !isPctUnit && normUnit) score += 15;
        if (entry.canonicalKey === "serum:ldl_direct" && isDirectLdlMethod) score += 25;
        if (score > bestExactScore) {
          bestExactScore = score;
          bestExact = entry;
        }
      }
    }
  }
  if (bestExact) {
    // If matched serum:ldl but method is explicitly Direct, upgrade to serum:ldl_direct
    if (bestExact.canonicalKey === "serum:ldl" && isDirectLdlMethod) {
      const direct = CATALOG_BY_KEY.get("serum:ldl_direct");
      return { ...direct, isKnown: true };
    }
    return { ...bestExact, isKnown: true };
  }

  // 2. Substring / longest-alias match (guarded by excludeSubstrings and word boundaries)
  let bestSub = null;
  let bestSubScore = 0;
  for (const entry of eligible) {
    if (entry.excludeSubstrings?.some(ex => cleaned.includes(ex))) continue;
    for (const alias of entry.aliases) {
      const cleanAlias = cleanText(alias);
      if (cleanAlias.length < 3) continue;
      // Avoid matching short 3-letter aliases inside unrelated words
      const escaped = cleanAlias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`(?:^|\\s|\\()${escaped}(?:$|\\s|\\)|:)`);
      if (re.test(cleaned)) {
        let score = cleanAlias.length * 2;
        if (entry.specimen === specimen) score += 10;
        if (entry.canonicalKey.endsWith("_pct") && isPctUnit) score += 12;
        if (entry.canonicalKey.endsWith("_abs") && !isPctUnit && normUnit) score += 12;
        if (entry.canonicalKey.endsWith("_pct") && !isPctUnit && normUnit) score -= 20;
        if (entry.canonicalKey.endsWith("_abs") && isPctUnit) score -= 20;
        if (score > bestSubScore) {
          bestSubScore = score;
          bestSub = entry;
        }
      }
    }
  }
  if (bestSub && bestSubScore >= 6) {
    if (bestSub.canonicalKey === "serum:ldl" && isDirectLdlMethod) {
      const direct = CATALOG_BY_KEY.get("serum:ldl_direct");
      return { ...direct, isKnown: true };
    }
    return { ...bestSub, isKnown: true };
  }

  // 3. Deterministic fallback key so unknown analytes are preserved safely
  const slug = cleaned
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "unknown_analyte";
  return {
    canonicalKey: `${specimen}:${slug}`,
    displayName: (rawName || slug).trim(),
    panel: panelHint || (specimen === "urine" ? "Urinalysis" : specimen === "vitals" ? "Vitals & Anthropometrics" : "Other Labs"),
    specimen,
    defaultUnit: normUnit || null,
    isKnown: false,
  };
}

// Conversion tables: canonicalKey -> { targetUnit, units: { sourceUnit: factor | fn } }
const LIPID_CHOL_CONV = { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 38.67 } };
const GLUCOSE_CONV = { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 18.0182 } };
const TRIG_CONV = { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 88.57 } };
const CREAT_CONV = { targetUnit: "mg/dL", units: { "mg/dL": 1, "umol/L": 1 / 88.4 } };
const BILI_CONV = { targetUnit: "mg/dL", units: { "mg/dL": 1, "umol/L": 1 / 17.1 } };
const URIC_CONV = { targetUnit: "mg/dL", units: { "mg/dL": 1, "umol/L": 1 / 59.48 } };
const IRON_CONV = { targetUnit: "ug/dL", units: { "ug/dL": 1, "umol/L": 5.585 } };
const ENZYME_CONV = { targetUnit: "U/L", units: { "U/L": 1 } };
const ELECTROLYTE_CONV = { targetUnit: "mEq/L", units: { "mEq/L": 1, "mmol/L": 1 } };
const CRP_CONV = { targetUnit: "mg/L", units: { "mg/L": 1, "mg/dL": 10 } };
const CELL_K_CONV = { targetUnit: "10^3/uL", units: { "10^3/uL": 1, "cells/uL": 0.001 } };

const CONVERSIONS = {
  "serum:ldl_direct": LIPID_CHOL_CONV,
  "serum:ldl": LIPID_CHOL_CONV,
  "serum:hdl": LIPID_CHOL_CONV,
  "serum:total_cholesterol": LIPID_CHOL_CONV,
  "serum:vldl": LIPID_CHOL_CONV,
  "serum:non_hdl_cholesterol": LIPID_CHOL_CONV,
  "serum:triglycerides": TRIG_CONV,
  "serum:glucose": GLUCOSE_CONV,
  "serum:eag": GLUCOSE_CONV,
  "serum:hba1c": {
    targetUnit: "%",
    units: {
      "%": 1,
      "mmol/mol": v => v * 0.09148 + 2.152,
    },
  },
  "serum:creatinine": CREAT_CONV,
  "serum:egfr": { targetUnit: "mL/min/1.73m2", units: { "mL/min/1.73m2": 1 } },
  "serum:bun": { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 2.801 } },
  "serum:urea": { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 6.006 } },
  "serum:uric_acid": URIC_CONV,
  "serum:sodium": ELECTROLYTE_CONV,
  "serum:potassium": ELECTROLYTE_CONV,
  "serum:chloride": ELECTROLYTE_CONV,
  "serum:co2": ELECTROLYTE_CONV,
  "serum:calcium": { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 4.008 } },
  "serum:phosphorus": { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 3.097 } },
  "serum:magnesium": { targetUnit: "mg/dL", units: { "mg/dL": 1, "mmol/L": 2.431 } },
  "serum:ast": ENZYME_CONV,
  "serum:alt": ENZYME_CONV,
  "serum:ggt": ENZYME_CONV,
  "serum:alkaline_phosphatase": ENZYME_CONV,
  "serum:ldh": ENZYME_CONV,
  "serum:amylase": ENZYME_CONV,
  "serum:lipase": ENZYME_CONV,
  "serum:cpk": ENZYME_CONV,
  "serum:total_bilirubin": BILI_CONV,
  "serum:direct_bilirubin": BILI_CONV,
  "serum:indirect_bilirubin": BILI_CONV,
  "serum:total_protein": { targetUnit: "g/dL", units: { "g/dL": 1, "g/L": 0.1 } },
  "serum:albumin": { targetUnit: "g/dL", units: { "g/dL": 1, "g/L": 0.1 } },
  "serum:globulin": { targetUnit: "g/dL", units: { "g/dL": 1, "g/L": 0.1 } },
  "serum:iron": IRON_CONV,
  "serum:tibc": IRON_CONV,
  "serum:uibc": IRON_CONV,
  "serum:transferrin": { targetUnit: "mg/dL", units: { "mg/dL": 1, "g/L": 100 } },
  "serum:ferritin": { targetUnit: "ng/mL", units: { "ng/mL": 1, "ug/L": 1 } },
  "serum:vitamin_b12": { targetUnit: "pg/mL", units: { "pg/mL": 1, "ng/L": 1, "pmol/L": 1.355 } },
  "serum:folate": { targetUnit: "ng/mL", units: { "ng/mL": 1, "ug/L": 1, "nmol/L": 0.4413 } },
  "serum:vitamin_d": { targetUnit: "ng/mL", units: { "ng/mL": 1, "nmol/L": 1 / 2.496 } },
  "serum:tsh": { targetUnit: "mIU/L", units: { "mIU/L": 1 } },
  "serum:t4_free": { targetUnit: "ng/dL", units: { "ng/dL": 1, "pmol/L": 0.0777 } },
  "serum:t4_total": { targetUnit: "ug/dL", units: { "ug/dL": 1, "nmol/L": 0.0777 } },
  "serum:t3_free": { targetUnit: "pg/mL", units: { "pg/mL": 1, "pmol/L": 0.651 } },
  "serum:t3_total": { targetUnit: "ng/dL", units: { "ng/dL": 1, "ng/mL": 100, "nmol/L": 65.1 } },
  "serum:hs_crp": CRP_CONV,
  "serum:crp": CRP_CONV,
  "blood:hemoglobin": { targetUnit: "g/dL", units: { "g/dL": 1, "g/L": 0.1 } },
  "blood:hematocrit": { targetUnit: "%", units: { "%": 1 } },
  "blood:rbc": { targetUnit: "10^6/uL", units: { "10^6/uL": 1 } },
  "blood:wbc": CELL_K_CONV,
  "blood:platelets": CELL_K_CONV,
  "blood:neutrophils_abs": CELL_K_CONV,
  "blood:lymphocytes_abs": CELL_K_CONV,
  "blood:monocytes_abs": CELL_K_CONV,
  "blood:eosinophils_abs": CELL_K_CONV,
  "blood:basophils_abs": CELL_K_CONV,
  "vitals:height": { targetUnit: "cm", units: { "cm": 1, "m": 100 } },
  "vitals:weight": { targetUnit: "kg", units: { "kg": 1 } },
};

function roundClean(num) {
  return Number(num.toFixed(4));
}

export function convertValue(canonicalKey, valueNum, unitRaw) {
  if (valueNum === null || valueNum === undefined || Number.isNaN(Number(valueNum))) {
    return {
      normalizedValue: null,
      normalizedUnit: normalizeUnit(unitRaw),
      conversionFactor: null,
      comparable: false,
      reason: "Non-numeric value",
    };
  }
  const num = Number(valueNum);
  const normUnit = normalizeUnit(unitRaw);
  const spec = CONVERSIONS[canonicalKey];

  if (!spec) {
    const def = CATALOG_BY_KEY.get(canonicalKey);
    return {
      normalizedValue: roundClean(num),
      normalizedUnit: normUnit || def?.defaultUnit || null,
      conversionFactor: 1,
      comparable: true,
      reason: null,
    };
  }

  if (!normUnit) {
    // Missing unit on a dimensionless/ratio or missing-unit observation
    if (spec.targetUnit === "ratio" || spec.targetUnit === "%") {
      return {
        normalizedValue: roundClean(num),
        normalizedUnit: spec.targetUnit,
        conversionFactor: 1,
        comparable: true,
        reason: null,
      };
    }
    return {
      normalizedValue: null,
      normalizedUnit: spec.targetUnit,
      conversionFactor: null,
      comparable: false,
      reason: `Missing unit for ${canonicalKey} (expected ${spec.targetUnit})`,
    };
  }

  const rule = spec.units[normUnit];
  if (rule === undefined) {
    return {
      normalizedValue: null,
      normalizedUnit: spec.targetUnit,
      conversionFactor: null,
      comparable: false,
      reason: `Unsupported unit "${unitRaw}" for ${canonicalKey} (cannot convert to ${spec.targetUnit})`,
    };
  }

  if (typeof rule === "function") {
    return {
      normalizedValue: roundClean(rule(num)),
      normalizedUnit: spec.targetUnit,
      conversionFactor: null,
      comparable: true,
      reason: null,
    };
  }

  return {
    normalizedValue: roundClean(num * rule),
    normalizedUnit: spec.targetUnit,
    conversionFactor: roundClean(rule),
    comparable: true,
    reason: null,
  };
}

export function parseNumericValue(valueText) {
  if (valueText === null || valueText === undefined) return { valueNum: null, comparator: null };
  if (typeof valueText === "number") {
    return Number.isFinite(valueText) ? { valueNum: valueText, comparator: null } : { valueNum: null, comparator: null };
  }
  const s = String(valueText).trim().replace(/^\*+\s*/, "").replace(/\s*\*+$/, "");
  if (!s) return { valueNum: null, comparator: null };
  // Ignore compound BP like "120/80" as single scalar
  if (/^\d{2,3}\s*\/\s*\d{2,3}$/.test(s)) return { valueNum: null, comparator: null };
  const m = s.match(/^(<=|>=|<|>)?\s*(-?\d+(?:[.,]\d+)?)$/);
  if (!m) return { valueNum: null, comparator: null };
  const num = Number(m[2].replace(",", "."));
  return Number.isFinite(num) ? { valueNum: num, comparator: m[1] || null } : { valueNum: null, comparator: null };
}

export function parseReferenceRange(refText) {
  if (!refText || typeof refText !== "string") {
    return { refLow: null, refHigh: null, inclusiveLow: true, inclusiveHigh: true, kind: "unknown", expectedText: null };
  }
  const raw = refText.trim();
  if (!raw || raw === "-" || raw === "---") {
    return { refLow: null, refHigh: null, inclusiveLow: true, inclusiveHigh: true, kind: "unknown", expectedText: null };
  }
  const norm = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/,/g, ".")
    .trim();

  // Strip leading labels like "Recomendable:", "Deseable:", "Normal:", "Óptimo:"
  const stripped = norm.replace(/^(recomendable|deseable|normal|optimo|referencia|hombres?|mujeres?)\s*:?\s*/i, "");

  // Two-sided range: "70 - 99", "70.0 - 99.0", "70 a 99", "<= 0.0 - 5.0", "0.70 - 1.30"
  let m = stripped.match(/^(?:<=|>=)?\s*(-?\d+(?:\.\d+)?)\s*(?:-|–|—|\ba\b|\bto\b)\s*(-?\d+(?:\.\d+)?)(?:\s|$|%)/i);
  if (m) {
    const low = Number(m[1]);
    const high = Number(m[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) {
      return { refLow: low, refHigh: high, inclusiveLow: true, inclusiveHigh: true, kind: "range", expectedText: null };
    }
  }

  // Upper bound: "< 100", "<= 150", "Menor a 200", "Menor o igual a 150", "Hasta 40", "Inferior a 100"
  m = stripped.match(/^(?:(<=|<)|(?:menor\s+o\s+igual\s+(?:a|que)|hasta)|(menor\s+(?:a|que|de)|inferior\s+a))\s*(-?\d+(?:\.\d+)?)/i);
  if (m) {
    const high = Number(m[3]);
    const inclusive = m[1] === "<=" || Boolean(!m[1] && !m[2]);
    if (Number.isFinite(high)) {
      return { refLow: null, refHigh: high, inclusiveLow: true, inclusiveHigh: inclusive, kind: "upper", expectedText: null };
    }
  }

  // Lower bound: ">= 40", "> 60", "Igual o Mayor a 40", "Mayor o igual a 60", "Mayor a 40", "Superior a 40"
  m = stripped.match(/^(?:(>=|>)|(?:igual\s+o\s+mayor\s+(?:a|que)|mayor\s+o\s+igual\s+(?:a|que))|(mayor\s+(?:a|que|de)|superior\s+a))\s*(-?\d+(?:\.\d+)?)/i);
  if (m) {
    const low = Number(m[3]);
    const inclusive = m[1] === ">=" || Boolean(!m[1] && !m[2]);
    if (Number.isFinite(low)) {
      return { refLow: low, refHigh: null, inclusiveLow: inclusive, inclusiveHigh: true, kind: "lower", expectedText: null };
    }
  }

  // Qualitative expected reference
  const lowerNorm = norm.toLowerCase();
  if (/(negativ|no reactiv|ausent|normal|amarillo|incoloro|transparente|claro|escas)/.test(lowerNorm)) {
    return { refLow: null, refHigh: null, inclusiveLow: true, inclusiveHigh: true, kind: "qualitative", expectedText: raw };
  }

  return { refLow: null, refHigh: null, inclusiveLow: true, inclusiveHigh: true, kind: "unknown", expectedText: null };
}

export function computeFlag({
  valueNum = null,
  valueText = "",
  refLow = null,
  refHigh = null,
  refText = null,
  inclusiveLow = true,
  inclusiveHigh = true,
  comparator = null,
} = {}) {
  let low = refLow;
  let high = refHigh;
  let incLow = inclusiveLow;
  let incHigh = inclusiveHigh;
  let parsedRef = null;

  if (low === null && high === null && refText) {
    parsedRef = parseReferenceRange(refText);
    low = parsedRef.refLow;
    high = parsedRef.refHigh;
    incLow = parsedRef.inclusiveLow;
    incHigh = parsedRef.inclusiveHigh;
  }

  if (valueNum !== null && valueNum !== undefined && Number.isFinite(Number(valueNum))) {
    const v = Number(valueNum);
    // Censored values like "< 0.20" when upper ref is "< 3.0" are normal
    if (comparator === "<" || comparator === "<=") {
      if (high !== null && v <= high) return "normal";
      if (low !== null && v <= low) return "low";
    }
    if (comparator === ">" || comparator === ">=") {
      if (low !== null && v >= low) return "normal";
      if (high !== null && v >= high) return "high";
    }
    if (low !== null) {
      if (incLow ? v < low : v <= low) return "low";
    }
    if (high !== null) {
      if (incHigh ? v > high : v >= high) return "high";
    }
    if (low !== null || high !== null) return "normal";
    return "unknown";
  }

  // Qualitative comparison
  const cleanVal = cleanText(String(valueText || ""));
  const cleanRef = cleanText(String(refText || parsedRef?.expectedText || ""));
  if (!cleanVal) return "unknown";

  if (cleanRef) {
    if (cleanVal === cleanRef) return "normal";
    const expectedNeg = /(negativ|no reactiv|ausent)/.test(cleanRef);
    const actualNeg = /(negativ|no reactiv|ausent)/.test(cleanVal);
    const actualPos = /(positiv|reactiv|presente|abundante|moderad|trazas)/.test(cleanVal) && !actualNeg;
    if (expectedNeg && actualNeg) return "normal";
    if (expectedNeg && actualPos) return "abnormal";
    if (cleanRef.includes(cleanVal) || cleanVal.includes(cleanRef)) return "normal";
    // Color/appearance e.g. "AMARILLO/INCOLORO" vs "AMARILLO"
    const refParts = cleanRef.split(/[/,;\s]+/).filter(Boolean);
    if (refParts.some(p => p.length >= 4 && cleanVal.includes(p))) return "normal";
  }

  return "unknown";
}
