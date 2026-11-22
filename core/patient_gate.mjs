const NAME_STOPWORDS = new Set([
  "de", "del", "la", "las", "los", "y", "e", "da", "do", "dos",
  "dr", "dra", "sr", "sra", "srta", "mr", "mrs", "ms", "prof",
  "paciente", "pac", "nombre", "medico", "qfb", "mc", "ing", "lic",
]);

const MONTH_MAP = {
  jan: 1, ene: 1, enero: 1, january: 1,
  feb: 2, febrero: 2, february: 2,
  mar: 3, marzo: 3, march: 3,
  apr: 4, abr: 4, abril: 4, april: 4,
  may: 5, mayo: 5,
  jun: 6, junio: 6, june: 6,
  jul: 7, julio: 7, july: 7,
  aug: 8, ago: 8, agosto: 8, august: 8,
  sep: 9, sept: 9, septiembre: 9, september: 9,
  oct: 10, octubre: 10, october: 10,
  nov: 11, noviembre: 11, november: 11,
  dec: 12, dic: 12, diciembre: 12, december: 12,
};

export function normalizeName(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  // Strip trailing doctor label collision common in LAPI PDFs ("SURNAME FIRST Dr.")
  s = s.replace(/\b(dr|dra|q\.?f\.?b|m\.?c)\.?\s*$/g, "");
  s = s.replace(/^(paciente|nombre|patient)\s*:\s*/g, "");
  s = s.replace(/[^a-z0-9\s]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

export function tokenizeName(raw) {
  const normalized = normalizeName(raw);
  if (!normalized) return [];
  return normalized
    .split(" ")
    .filter(tok => tok.length >= 2 && !NAME_STOPWORDS.has(tok));
}

export function normalizeSex(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (["m", "male", "masculino", "masc", "hombre", "h", "man", "mannlich"].includes(s)) return "M";
  if (["f", "female", "femenino", "fem", "mujer", "woman", "weiblich"].includes(s)) return "F";
  return null;
}

export function normalizeDob(raw) {
  if (!raw || typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  // ISO YYYY-MM-DD
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    return formatValidDate(Number(m[1]), Number(m[2]), Number(m[3]));
  }

  // DD/MM/YYYY or DD-MM-YYYY or DD/MM/YY (Mexican/European standard)
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (m) {
    let day = Number(m[1]);
    let month = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) {
      const currentTwoDigit = new Date().getUTCFullYear() % 100;
      year = year <= currentTwoDigit + 1 ? 2000 + year : 1900 + year;
    }
    if (month > 12 && day <= 12) {
      // Fallback if US MM/DD/YYYY slipped in with day > 12
      [day, month] = [month, day];
    }
    return formatValidDate(year, month, day);
  }

  // DD-MMM-YYYY or DD MMM YYYY (Spanish/English month names)
  m = s.match(/^(\d{1,2})[\s/-]+([a-zA-Z]{3,10})[\s/-]+(\d{2,4})$/);
  if (m) {
    const day = Number(m[1]);
    const mon = MONTH_MAP[m[2].toLowerCase()];
    let year = Number(m[3]);
    if (year < 100) {
      const currentTwoDigit = new Date().getUTCFullYear() % 100;
      year = year <= currentTwoDigit + 1 ? 2000 + year : 1900 + year;
    }
    if (mon) return formatValidDate(year, mon, day);
  }

  return null;
}

function formatValidDate(year, month, day) {
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + cost);
      diag = temp;
    }
  }
  return prev[b.length];
}

function tokenInSet(token, tokenSet, allowFuzzy = false) {
  if (tokenSet.has(token)) return true;
  if (!allowFuzzy || token.length < 5) return false;
  for (const candidate of tokenSet) {
    if (candidate.length >= 5 && levenshtein(token, candidate) <= 1) {
      return true;
    }
  }
  return false;
}

function splitCommaStyleName(raw) {
  // Médica Sur format: "SURNAME1 SURNAME2, FIRST1 FIRST2"
  if (!raw || !raw.includes(",")) return null;
  const [left, right] = raw.split(",", 2);
  const surnames = tokenizeName(left);
  const givenNames = tokenizeName(right);
  if (!surnames.length || !givenNames.length) return null;
  return { surnames, givenNames };
}

function matchCandidate(docNameRaw, docTokens, candidateRaw, dobCorroborated) {
  const candTokens = tokenizeName(candidateRaw);
  if (!candTokens.length) return { matched: false, score: 0, detail: "empty_candidate" };

  const docSet = new Set(docTokens);
  const candSet = new Set(candTokens);

  // Exact normalized string match
  if (normalizeName(docNameRaw) === normalizeName(candidateRaw)) {
    return { matched: true, score: 1.0, detail: "exact_normalized_name" };
  }

  // Exact token set equality (order-independent: handles "FIRST LAST" vs "LAST, FIRST")
  if (docSet.size === candSet.size && [...candSet].every(t => docSet.has(t))) {
    return { matched: true, score: 0.99, detail: "exact_token_set" };
  }

  const allowFuzzy = dobCorroborated;
  const matchedCandTokens = candTokens.filter(t => tokenInSet(t, docSet, allowFuzzy));
  const matchedDocTokens = docTokens.filter(t => tokenInSet(t, candSet, allowFuzzy));

  // Comma-structured document name check (prevents sibling/spouse surname-only false positives)
  const commaParts = splitCommaStyleName(docNameRaw);
  const candCommaParts = splitCommaStyleName(candidateRaw);

  // Determine candidate primary given name & surname tokens
  const candGiven = candCommaParts ? candCommaParts.givenNames : [candTokens[0]];
  const candSurnames = candCommaParts ? candCommaParts.surnames : candTokens.slice(1);

  if (candTokens.length === 1) {
    // Single-token alias (only accept if exact single token AND DOB corroborates, or doc also 1 token)
    const tok = candTokens[0];
    if (tokenInSet(tok, docSet, false) && (dobCorroborated || docTokens.length === 1)) {
      return { matched: true, score: 0.85, detail: "single_alias_dob_corroborated" };
    }
    return { matched: false, score: 0.2, detail: "insufficient_single_token_alias" };
  }

  // Check if all candidate tokens appear in doc (e.g. profile "Alex Rivera" in "RIVERA GOMEZ, ALEX DANIEL")
  const allCandInDoc = matchedCandTokens.length === candTokens.length;
  // Check if all doc tokens appear in candidate (e.g. doc "RIVERA, ALEX" vs profile "Alex Daniel Rivera Gomez")
  const allDocInCand = docTokens.length >= 2 && matchedDocTokens.length === docTokens.length;

  // Verify at least one given-name token matches AND at least one surname token matches
  const givenMatches = candGiven.some(g =>
    commaParts
      ? tokenInSet(g, new Set(commaParts.givenNames), allowFuzzy)
      : tokenInSet(g, docSet, allowFuzzy)
  );
  const surnameMatches = candSurnames.some(s =>
    commaParts
      ? tokenInSet(s, new Set(commaParts.surnames), allowFuzzy)
      : tokenInSet(s, docSet, allowFuzzy)
  );

  if (allCandInDoc && (givenMatches || !commaParts)) {
    return { matched: true, score: 0.95, detail: "all_profile_tokens_matched" };
  }

  if (allDocInCand && givenMatches && surnameMatches) {
    return { matched: true, score: 0.93, detail: "all_doc_tokens_matched_given_and_surname" };
  }

  if (givenMatches && surnameMatches && matchedCandTokens.length >= 2) {
    return { matched: true, score: dobCorroborated ? 0.92 : 0.88, detail: "given_and_surname_token_match" };
  }

  return { matched: false, score: matchedCandTokens.length / Math.max(candTokens.length, 1), detail: "token_mismatch" };
}

export function evaluatePatientMatch(extractedPatient = {}, profile = null, opts = {}) {
  const nameRaw = extractedPatient?.nameRaw || "";
  const dobRaw = extractedPatient?.dobRaw || null;
  const sexRaw = extractedPatient?.sexRaw || null;
  const isSyntheticDemo = Boolean(extractedPatient?.isSyntheticDemo);

  if (isSyntheticDemo) {
    if (opts.allowSyntheticDemo === true) {
      return {
        matched: true,
        confidence: 1.0,
        reason: "Synthetic demo fixture explicitly allowed",
        method: "synthetic_demo",
      };
    }
    if (!profile && opts.allowSyntheticDemo !== false) {
      return {
        matched: true,
        confidence: 1.0,
        reason: "Synthetic demo fixture accepted (no patient profile configured)",
        method: "synthetic_demo",
      };
    }
  }

  if (!profile || !profile.fullName) {
    if (opts.requireProfile) {
      return {
        matched: false,
        confidence: 0,
        reason: "No patient profile configured; complete onboarding before importing real lab documents",
        method: "no_profile",
      };
    }
    return {
      matched: true,
      confidence: 0.5,
      reason: "No patient profile configured; document imported without strict identity filtering",
      method: "no_profile_warning",
    };
  }

  const docTokens = tokenizeName(nameRaw);
  if (docTokens.length === 0) {
    if (opts.allowMissingPatient === true) {
      return {
        matched: true,
        confidence: 0.4,
        reason: "Missing patient name explicitly allowed by caller",
        method: "missing_patient_allowed",
      };
    }
    return {
      matched: false,
      confidence: 0,
      reason: "Document lacks a readable patient name while patient identity gate is active",
      method: "missing_patient",
    };
  }

  const profileDob = normalizeDob(profile.dob);
  const docDob = normalizeDob(dobRaw);
  const dobCorroborated = Boolean(profileDob && docDob && profileDob === docDob);

  if (profileDob && docDob && profileDob !== docDob) {
    return {
      matched: false,
      confidence: 0,
      reason: `Patient DOB mismatch: document has ${docDob}, profile expects ${profileDob}`,
      method: "mismatch",
    };
  }

  const profileSex = normalizeSex(profile.biologicalSex || profile.biological_sex);
  const docSex = normalizeSex(sexRaw);
  if (profileSex && docSex && profileSex !== docSex) {
    return {
      matched: false,
      confidence: 0,
      reason: `Patient biological sex mismatch: document has ${docSex}, profile expects ${profileSex}`,
      method: "mismatch",
    };
  }

  const candidates = [profile.fullName, ...(Array.isArray(profile.aliases) ? profile.aliases : [])].filter(Boolean);
  let best = { matched: false, score: 0, detail: "no_candidate" };
  for (const cand of candidates) {
    const res = matchCandidate(nameRaw, docTokens, cand, dobCorroborated);
    if (res.matched && res.score > best.score) {
      best = res;
    } else if (!best.matched && res.score > best.score) {
      best = res;
    }
  }

  if (best.matched) {
    return {
      matched: true,
      confidence: best.score,
      reason: dobCorroborated
        ? `Matched patient profile (${best.detail}, DOB corroborated)`
        : `Matched patient profile (${best.detail})`,
      method: dobCorroborated ? "dob_corroborated" : "profile_match",
    };
  }

  return {
    matched: false,
    confidence: best.score,
    reason: `Patient name mismatch: document patient "${nameRaw}" does not match configured profile "${profile.fullName}"`,
    method: "mismatch",
  };
}
