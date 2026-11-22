#!/usr/bin/env bash
# End-to-end verification script for Health Timeline on GCP VM
# Usage:
#   bash deploy/smoke-test.sh           # Run directly on the VM
#   bash deploy/smoke-test.sh --remote  # Invoke on health-timeline-vm over gcloud ssh
set -euo pipefail

if [ "${1:-}" = "--remote" ]; then
  GCP_PROJECT="${GCP_PROJECT:-computing-ds-mine}"
  GCP_ZONE="${GCP_ZONE:-us-central1-a}"
  VM_NAME="${VM_NAME:-health-timeline-vm}"
  exec gcloud compute ssh "${VM_NAME}" \
    --project="${GCP_PROJECT}" \
    --zone="${GCP_ZONE}" \
    --command="bash ~/health-timeline/deploy/smoke-test.sh"
fi

REPO_DIR="${HEALTH_TIMELINE_DIR:-$HOME/health-timeline}"
VENV_DIR="${HEALTH_TIMELINE_VENV:-/opt/health-timeline-venv}"
INBOX_DIR="${HEALTH_TIMELINE_INBOX:-$HOME/private-labs-inbox}"
ENV_FILE="${HOME}/.health-timeline.env"

if [ -f "${ENV_FILE}" ]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

export HEALTH_TIMELINE_PYTHON="${VENV_DIR}/bin/python"
export PATH="${VENV_DIR}/bin:${PATH}"

PASS=0
FAIL=0
SKIP=0

pass() { PASS=$((PASS + 1)); printf '  [PASS] %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  [FAIL] %s\n' "$*" >&2; }
skip() { SKIP=$((SKIP + 1)); printf '  [SKIP] %s\n' "$*"; }

echo "=== 1. Base Environment & Tooling ==="
if swapon --show | grep -q '/swapfile'; then
  pass "2 GB swapfile active ($(swapon --show --noheadings | awk '{print $3}' | head -n1))"
else
  fail "Swapfile not active"
fi

if command -v node >/dev/null 2>&1; then
  pass "Node.js $(node -v)"
else
  fail "Node.js missing"
fi

if command -v openclaw >/dev/null 2>&1; then
  pass "OpenClaw $(openclaw --version | head -n1)"
else
  fail "OpenClaw CLI missing"
fi

if command -v pdftotext >/dev/null 2>&1 && command -v pdftoppm >/dev/null 2>&1; then
  pass "Poppler $(pdftotext -v 2>&1 | head -n1)"
else
  fail "Poppler (pdftotext/pdftoppm) missing"
fi

if "${VENV_DIR}/bin/python" -c "import pypdf, pdfplumber, PIL; print(f'pypdf={pypdf.__version__}, pdfplumber={pdfplumber.__version__}, pillow={PIL.__version__}')" 2>/dev/null; then
  pass "Python venv PDF stack OK"
else
  fail "Python venv PDF libs missing"
fi

echo ""
echo "=== 2. Private Real-Data Inbox Hygiene ==="
if [ -d "${INBOX_DIR}" ]; then
  PDF_COUNT="$(find "${INBOX_DIR}" -maxdepth 1 -type f -name '*.pdf' | wc -l | tr -d ' ')"
  if [ "${PDF_COUNT}" -ge 8 ]; then
    pass "Private inbox ${INBOX_DIR} has ${PDF_COUNT} PDFs (outside git repo)"
  else
    fail "Expected >= 8 PDFs in ${INBOX_DIR}, found ${PDF_COUNT}"
  fi
else
  fail "Private inbox ${INBOX_DIR} missing"
fi

if [ -d "${REPO_DIR}" ]; then
  LEAKED="$(find "${REPO_DIR}" -maxdepth 3 -name 'Resultados*.pdf' -o -name 'ordenc*.pdf' 2>/dev/null | wc -l | tr -d ' ')"
  if [ "${LEAKED}" -eq 0 ]; then
    pass "No private lab PDFs leaked inside ${REPO_DIR}"
  else
    fail "Found ${LEAKED} private lab PDFs inside ${REPO_DIR}!"
  fi
fi

echo ""
echo "=== 3. Synthetic Demo & Repo Test Suite ==="
if [ ! -d "${REPO_DIR}" ]; then
  skip "Repo not synced to ${REPO_DIR} yet"
else
  cd "${REPO_DIR}"
  if npm test; then
    pass "npm test passed"
  else
    fail "npm test failed"
  fi

  echo ""
  echo "=== 4. Private Runtime Data Dir Verification (~/health-data) ==="
  DATA_DIR="${HEALTH_TIMELINE_DATA_DIR:-$HOME/health-data}"
  if [ -f "${DATA_DIR}/timeline.sqlite" ] && [ -f "${REPO_DIR}/core/query.mjs" ]; then
    if node - "${REPO_DIR}" "${DATA_DIR}" <<'NODE'
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [repoDir, dataDir] = process.argv.slice(2);
const queryMod = await import(pathToFileURL(path.join(repoDir, 'core', 'query.mjs')).href);
const guidelinesMod = await import(pathToFileURL(path.join(repoDir, 'core', 'guidelines.mjs')).href);

const opts = { dataDir };
const overview = queryMod.getOverview(opts);
const guidelines = guidelinesMod.readRegionalGuidelines(opts);
console.log('Runtime data summary:', JSON.stringify({
  counts: overview.counts,
  guidelinesExists: guidelines.exists,
  guidelinesCountry: guidelines.frontmatter?.country,
  guidelinesTargets: guidelines.targets?.length || 0,
}));
if ((overview.counts?.documents || 0) < 6 || (overview.counts?.skippedDocuments || 0) < 1) {
  throw new Error(`Unexpected runtime counts: ${JSON.stringify(overview.counts)}`);
}
if (!guidelines.exists) {
  throw new Error('regional-guidelines.md missing in runtime dataDir');
}
NODE
    then
      pass "Runtime data dir (${DATA_DIR}) has active multi-lab records, skipped non-owner doc, and regional-guidelines.md"
    else
      fail "Runtime data dir verification failed"
    fi
  else
    skip "Runtime data dir (${DATA_DIR}/timeline.sqlite) not populated yet"
  fi

  echo ""
  echo "=== 5. OpenClaw Plugin & Agent Inspection ==="
  if openclaw plugins list 2>&1 | grep -qi 'health-timeline'; then
    pass "OpenClaw plugin 'health-timeline' discovered"
  else
    fail "OpenClaw plugin 'health-timeline' not listed (run deploy/setup-vm.sh)"
  fi

  if openclaw plugins inspect health-timeline >/dev/null 2>&1; then
    pass "openclaw plugins inspect health-timeline succeeded"
  else
    skip "openclaw plugins inspect health-timeline unavailable or warning"
  fi

  if openclaw agents list 2>&1 | grep -Eq '(^|[[:space:]])health([[:space:]]|$)'; then
    pass "Dedicated OpenClaw 'health' agent configured"
  else
    skip "Dedicated 'health' agent not yet added (run deploy/setup-vm.sh)"
  fi

  echo ""
  echo "=== 6. Dashboard HTTP Check ==="
  TEST_PORT=18765
  HEALTH_TIMELINE_PORT="${TEST_PORT}" node "${REPO_DIR}/server.mjs" >/tmp/ht-smoke-server.log 2>&1 &
  SRV_PID=$!
  sleep 1
  if curl -fsS "http://127.0.0.1:${TEST_PORT}/" >/dev/null && \
     (curl -fsS "http://127.0.0.1:${TEST_PORT}/timeline.json" >/dev/null || curl -fsS "http://127.0.0.1:${TEST_PORT}/api/timeline" >/dev/null); then
    pass "Dashboard served HTML + JSON API on 127.0.0.1:${TEST_PORT}"
  else
    fail "Dashboard HTTP check failed (see /tmp/ht-smoke-server.log)"
  fi
  kill "${SRV_PID}" >/dev/null 2>&1 || true
fi

echo ""
echo "=== 7. Live LLM Connectivity Check (Optional, Secret-Safe) ==="
AI_KEY="${AI_STUDIO_API_KEY:-${GEMINI_API_KEY:-${GOOGLE_API_KEY:-}}}"
if [ -n "${AI_KEY}" ]; then
  HTTP_CODE="$(curl -sS -o /tmp/ht-gemini-check.json -w '%{http_code}' \
    "https://generativelanguage.googleapis.com/v1beta/models?key=${AI_KEY}" || echo "000")"
  if [ "${HTTP_CODE}" = "200" ]; then
    MODEL_COUNT="$(jq '.models | length' /tmp/ht-gemini-check.json 2>/dev/null || echo '?')"
    pass "Google AI Studio API reachable (HTTP 200, ${MODEL_COUNT} models)"
  else
    fail "Google AI Studio API returned HTTP ${HTTP_CODE}"
  fi
  rm -f /tmp/ht-gemini-check.json
else
  skip "No AI_STUDIO_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY set on VM"
fi

if [ -n "${CEREBRAS_API_KEY:-}" ]; then
  CEREBRAS_URL="${CEREBRAS_ENDPOINT_OPENAI:-https://api.cerebras.ai/v1}"
  HTTP_CODE="$(curl -sS -o /tmp/ht-cerebras-check.json -w '%{http_code}' \
    -H "Authorization: Bearer ${CEREBRAS_API_KEY}" \
    "${CEREBRAS_URL%/}/models" || echo "000")"
  if [ "${HTTP_CODE}" = "200" ]; then
    pass "Cerebras OpenAI endpoint reachable (HTTP 200)"
  else
    fail "Cerebras OpenAI endpoint returned HTTP ${HTTP_CODE}"
  fi
  rm -f /tmp/ht-cerebras-check.json
else
  skip "No CEREBRAS_API_KEY set on VM"
fi

echo ""
echo "=== Smoke Test Summary: PASS=${PASS} FAIL=${FAIL} SKIP=${SKIP} ==="
[ "${FAIL}" -eq 0 ]
