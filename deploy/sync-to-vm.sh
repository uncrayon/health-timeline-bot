#!/usr/bin/env bash
# Sync Health Timeline repository code to GCP VM (excluding .git, secrets, and build artifacts)
# Usage:
#   bash deploy/sync-to-vm.sh [--setup] [--verify] [--clean]
set -euo pipefail

GCP_PROJECT="${GCP_PROJECT:-computing-ds-mine}"
GCP_ZONE="${GCP_ZONE:-us-central1-a}"
VM_NAME="${VM_NAME:-health-timeline-vm}"
REMOTE_DIR="${REMOTE_DIR:-~/health-timeline}"

RUN_SETUP=false
RUN_VERIFY=false
CLEAN_REMOTE=false

for arg in "$@"; do
  case "$arg" in
    --setup) RUN_SETUP=true ;;
    --verify) RUN_VERIFY=true ;;
    --clean) CLEAN_REMOTE=true ;;
    -h|--help)
      echo "Usage: $0 [--setup] [--verify] [--clean]"
      echo "Env overrides: GCP_PROJECT, GCP_ZONE, VM_NAME, REMOTE_DIR"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

TMP_ARCHIVE="$(mktemp /tmp/health-timeline-sync.XXXXXX.tar.gz)"
cleanup() {
  rm -f "${TMP_ARCHIVE}"
}
trap cleanup EXIT

echo "[sync-to-vm] Archiving ${REPO_ROOT} (excluding .git, .env*, build, node_modules, private data)..."
COPYFILE_DISABLE=1 tar -czf "${TMP_ARCHIVE}" \
  -C "${REPO_ROOT}" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='build' \
  --exclude='.venv' \
  --exclude='__pycache__' \
  --exclude='*.pyc' \
  --exclude='.DS_Store' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='*.sqlite' \
  --exclude='*.sqlite-wal' \
  --exclude='*.sqlite-shm' \
  --exclude='private-labs-inbox' \
  .

ARCHIVE_SIZE="$(du -h "${TMP_ARCHIVE}" | awk '{print $1}')"
echo "[sync-to-vm] Uploading ${ARCHIVE_SIZE} archive to ${VM_NAME} (${GCP_PROJECT}/${GCP_ZONE})..."

gcloud compute scp \
  --project="${GCP_PROJECT}" \
  --zone="${GCP_ZONE}" \
  "${TMP_ARCHIVE}" \
  "${VM_NAME}:/tmp/health-timeline-sync.tar.gz"

REMOTE_CMD="set -euo pipefail; mkdir -p ${REMOTE_DIR};"
if [ "$CLEAN_REMOTE" = true ]; then
  REMOTE_CMD="${REMOTE_CMD} find ${REMOTE_DIR} -mindepth 1 -maxdepth 1 ! -name build -exec rm -rf {} +;"
fi
REMOTE_CMD="${REMOTE_CMD} tar -xzf /tmp/health-timeline-sync.tar.gz -C ${REMOTE_DIR} && rm -f /tmp/health-timeline-sync.tar.gz && chmod +x ${REMOTE_DIR}/deploy/*.sh && echo '[sync-to-vm] Extracted into ${REMOTE_DIR}:' && ls -la ${REMOTE_DIR}"

gcloud compute ssh "${VM_NAME}" \
  --project="${GCP_PROJECT}" \
  --zone="${GCP_ZONE}" \
  --command="${REMOTE_CMD}"

if [ "$RUN_SETUP" = true ]; then
  echo "[sync-to-vm] Running setup-vm.sh on ${VM_NAME}..."
  gcloud compute ssh "${VM_NAME}" \
    --project="${GCP_PROJECT}" \
    --zone="${GCP_ZONE}" \
    --command="bash ${REMOTE_DIR}/deploy/setup-vm.sh"
fi

if [ "$RUN_VERIFY" = true ]; then
  echo "[sync-to-vm] Running smoke-test.sh on ${VM_NAME}..."
  gcloud compute ssh "${VM_NAME}" \
    --project="${GCP_PROJECT}" \
    --zone="${GCP_ZONE}" \
    --command="bash ${REMOTE_DIR}/deploy/smoke-test.sh"
fi

echo "[sync-to-vm] Done."
echo "SSH tunnel for Dashboard (8765) + OpenClaw Gateway (18789):"
echo "  gcloud compute ssh ${VM_NAME} --project=${GCP_PROJECT} --zone=${GCP_ZONE} -- -L 8765:127.0.0.1:8765 -L 18789:127.0.0.1:18789"
