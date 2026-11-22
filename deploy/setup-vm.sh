#!/usr/bin/env bash
# Idempotent Ubuntu 24.04 LTS setup script for Health Timeline on GCP (e2-medium)
# Usage:
#   bash deploy/setup-vm.sh              # Full setup (base OS + plugin/agent/systemd if repo exists)
#   bash deploy/setup-vm.sh --base-only  # Base OS/swap/tooling/Node/venv/OpenClaw only
set -euo pipefail

BASE_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --base-only) BASE_ONLY=true ;;
    -h|--help)
      echo "Usage: $0 [--base-only]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

APP_USER="${SUDO_USER:-$(whoami)}"
APP_HOME="$(eval echo "~${APP_USER}")"
REPO_DIR="${HEALTH_TIMELINE_DIR:-${APP_HOME}/health-timeline}"
VENV_DIR="${HEALTH_TIMELINE_VENV:-/opt/health-timeline-venv}"
DATA_DIR="${HEALTH_TIMELINE_DATA_DIR:-${APP_HOME}/health-data}"
INBOX_DIR="${HEALTH_TIMELINE_INBOX_DIR:-${APP_HOME}/private-labs-inbox}"
OPENCLAW_DIR="${APP_HOME}/.openclaw"
HEALTH_WORKSPACE="${OPENCLAW_DIR}/workspace-health"
ENV_FILE="${APP_HOME}/.health-timeline.env"

log() {
  printf '\n[setup-vm] %s\n' "$*"
}

# 1. Configure 2 GB swapfile (idempotent) for OOM headroom on e2-medium (4 GB RAM)
log "Step 1/7: Ensuring 2 GB swapfile at /swapfile"
if ! swapon --show | grep -q '/swapfile'; then
  if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 status=progress
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
  else
    sudo chmod 600 /swapfile
  fi
  sudo swapon /swapfile
fi
if ! grep -q '^/swapfile ' /etc/fstab; then
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi
sudo sysctl -w vm.swappiness=20 >/dev/null
if ! grep -q '^vm.swappiness=' /etc/sysctl.conf 2>/dev/null; then
  echo 'vm.swappiness=20' | sudo tee -a /etc/sysctl.conf >/dev/null
fi
free -h

# 2. Install base OS packages & Poppler
log "Step 2/7: Installing base packages (poppler-utils, python3, venv, git, curl, jq, rsync)"
export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -qq
sudo apt-get install -y -qq \
  ca-certificates \
  curl \
  gnupg \
  git \
  jq \
  rsync \
  poppler-utils \
  python3 \
  python3-venv \
  python3-pip \
  build-essential

# 3. Install Node.js 24 LTS (>= 24.16 for OpenClaw 2026.11.6+ and project >= 22.16)
log "Step 3/7: Ensuring Node.js >= 24.16 (Node 24 LTS)"
need_node=true
if command -v node >/dev/null 2>&1; then
  NODE_VER="$(node -v | sed 's/^v//')"
  NODE_MAJ="$(echo "$NODE_VER" | cut -d. -f1)"
  NODE_MIN="$(echo "$NODE_VER" | cut -d. -f2)"
  if [ "$NODE_MAJ" -gt 24 ] || { [ "$NODE_MAJ" -eq 24 ] && [ "$NODE_MIN" -ge 16 ]; }; then
    need_node=false
    echo "Node.js v${NODE_VER} already meets >= 24.16"
  fi
fi
if [ "$need_node" = true ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
node -v
npm -v

# 4. Create Python venv with PDF libraries (pypdf, pdfplumber, pillow)
log "Step 4/7: Creating Python venv at ${VENV_DIR} with pypdf, pdfplumber, pillow"
if [ ! -d "${VENV_DIR}" ]; then
  sudo mkdir -p "${VENV_DIR}"
  sudo chown -R "${APP_USER}:${APP_USER}" "${VENV_DIR}"
  python3 -m venv "${VENV_DIR}"
else
  sudo chown -R "${APP_USER}:${APP_USER}" "${VENV_DIR}"
fi
"${VENV_DIR}/bin/pip" install --upgrade --quiet pip
"${VENV_DIR}/bin/pip" install --upgrade --quiet pypdf pdfplumber pillow

if [ ! -e "${APP_HOME}/health-venv" ]; then
  ln -s "${VENV_DIR}" "${APP_HOME}/health-venv"
fi

# Ensure venv Python is discoverable via env var in shell profile
PROFILE_LINE="export HEALTH_TIMELINE_PYTHON=\"${VENV_DIR}/bin/python3\""
for rc in "${APP_HOME}/.bashrc" "${APP_HOME}/.profile"; do
  touch "$rc"
  if ! grep -Fq "HEALTH_TIMELINE_PYTHON" "$rc"; then
    {
      echo ""
      echo "# Health Timeline Python venv"
      echo "${PROFILE_LINE}"
      echo "export HEALTH_TIMELINE_DATA_DIR=\"${DATA_DIR}\""
      echo "export HEALTH_TIMELINE_INBOX_DIR=\"${INBOX_DIR}\""
      echo "export PATH=\"${APP_HOME}/bin:${VENV_DIR}/bin:\$PATH\""
    } >> "$rc"
  fi
done

# 5. Install OpenClaw CLI globally (2026.11+)
log "Step 5/7: Ensuring OpenClaw CLI (latest 2026.11+) is installed"
need_openclaw=true
if command -v openclaw >/dev/null 2>&1; then
  OC_VER="$(openclaw --version 2>/dev/null | head -n1 || true)"
  if echo "${OC_VER}" | grep -qE '2026\.1[1-9]\.|202[7-9]\.'; then
    need_openclaw=false
    echo "OpenClaw already installed: ${OC_VER}"
  fi
fi
if [ "$need_openclaw" = true ]; then
  sudo npm install -g openclaw@latest
fi
openclaw --version

# 6. Ensure private data & labs inbox directories exist with strict permissions
log "Step 6/7: Ensuring private data (${DATA_DIR}) and inbox (${INBOX_DIR}) dirs with chmod 700"
mkdir -p "${DATA_DIR}" "${INBOX_DIR}"
chmod 700 "${DATA_DIR}" "${INBOX_DIR}"

if [ "$BASE_ONLY" = true ]; then
  log "Base-only setup complete."
  exit 0
fi

# 7. Configure OpenClaw plugin, dedicated health agent, and systemd/helper services
if [ ! -d "${REPO_DIR}" ]; then
  log "Step 7/7: ${REPO_DIR} not found yet — skipping plugin/agent/systemd wiring. Run deploy/sync-to-vm.sh then re-run setup-vm.sh."
  exit 0
fi

log "Step 7/7: Wiring Health Timeline plugin, dedicated 'health' agent, and services"
mkdir -p "${OPENCLAW_DIR}" "${HEALTH_WORKSPACE}" "${APP_HOME}/bin"
chmod 700 "${OPENCLAW_DIR}"

if [ -f "${ENV_FILE}" ]; then
  cp -f "${ENV_FILE}" "${OPENCLAW_DIR}/.env"
  chmod 600 "${OPENCLAW_DIR}/.env"
fi

# Sync agent persona files into dedicated health workspace if present
if [ -d "${REPO_DIR}/agents/health" ]; then
  for f in SOUL.md AGENTS.md USER.md; do
    if [ -f "${REPO_DIR}/agents/health/${f}" ]; then
      cp -f "${REPO_DIR}/agents/health/${f}" "${HEALTH_WORKSPACE}/${f}"
    fi
  done
fi

# Link the health-timeline OpenClaw plugin (idempotent)
openclaw plugins install --link --force --accept-capabilities "${REPO_DIR}" \
  || openclaw plugins install --link --force "${REPO_DIR}" \
  || openclaw plugins install --link "${REPO_DIR}" \
  || echo "[setup-vm] Warning: openclaw plugins install returned non-zero; check openclaw plugins doctor"

openclaw plugins enable health-timeline >/dev/null 2>&1 || true

# Add dedicated 'health' agent if not already registered
if ! openclaw agents list 2>/dev/null | grep -Eq '(^|[[:space:]])health([[:space:]]|$)'; then
  openclaw agents add health --non-interactive --workspace "${HEALTH_WORKSPACE}" || true
fi

# Patch ~/.openclaw/openclaw.json idempotently with health agent + send-only agentToAgent + plugin config
node - "${OPENCLAW_DIR}/openclaw.json" "${REPO_DIR}" "${HEALTH_WORKSPACE}" "${DATA_DIR}" "${INBOX_DIR}" <<'NODE'
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [configPath, repoDir, healthWorkspace, dataDir, inboxDir] = process.argv.slice(2);
let cfg = {};
if (fs.existsSync(configPath)) {
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    cfg = {};
  }
}

// Optional example snippet from agents/health/openclaw.health-bot.example.json
let example = null;
const examplePath = path.join(repoDir, 'agents', 'health', 'openclaw.health-bot.example.json');
if (fs.existsSync(examplePath)) {
  try {
    example = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
  } catch {
    example = null;
  }
}

cfg.gateway = {
  ...(cfg.gateway || {}),
  mode: cfg.gateway?.mode || 'local',
  bind: cfg.gateway?.bind || 'loopback',
  port: cfg.gateway?.port || 18789,
  auth: cfg.gateway?.auth?.token
    ? cfg.gateway.auth
    : {
        mode: 'token',
        token: crypto.randomBytes(24).toString('hex'),
      },
};

cfg.tools = cfg.tools || {};
cfg.tools.sessions = {
  ...(cfg.tools.sessions || {}),
  visibility: 'agent',
};
const allowSet = new Set([...(cfg.tools.agentToAgent?.allow || []), 'main', 'health']);
cfg.tools.agentToAgent = {
  ...(cfg.tools.agentToAgent || {}),
  enabled: true,
  allow: Array.from(allowSet),
};

cfg.agents = cfg.agents || {};
cfg.agents.ownership = 'explicit';
cfg.agents.defaults = cfg.agents.defaults || {};
cfg.agents.defaults.model = cfg.agents.defaults.model || {
  primary: 'google/gemini-2.5-flash',
};
cfg.agents.entries = cfg.agents.entries || {};

// Configure Google AI Studio (explicit google-generative-ai API) + Cerebras (ready for 1-command switch)
cfg.models = {
  ...(cfg.models || {}),
  mode: cfg.models?.mode || 'merge',
  providers: {
    ...(cfg.models?.providers || {}),
    google: cfg.models?.providers?.google || {
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
      api: 'google-generative-ai',
      models: [
        {
          id: 'gemini-2.5-flash',
          name: 'Gemini 2.5 Flash',
          api: 'google-generative-ai',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 1048576,
          maxTokens: 65536,
        },
        {
          id: 'gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          api: 'google-generative-ai',
          reasoning: true,
          input: ['text', 'image'],
          contextWindow: 1048576,
          maxTokens: 65536,
        },
      ],
    },
    cerebras: cfg.models?.providers?.cerebras || {
      baseUrl: process.env.CEREBRAS_ENDPOINT_OPENAI || 'https://api.cerebras.ai/v1',
      apiKey: '${CEREBRAS_API_KEY}',
      api: 'openai-completions',
      models: [],
    },
  },
};

// Configure main -> health send-only
const mainEntry = cfg.agents.entries.main || {};
const mainSend = new Set([...(mainEntry.tools?.agentToAgent?.send || []), 'health']);
cfg.agents.entries.main = {
  ...mainEntry,
  tools: {
    ...(mainEntry.tools || {}),
    agentToAgent: {
      ...(mainEntry.tools?.agentToAgent || {}),
      send: Array.from(mainSend),
    },
  },
};

// Configure dedicated health agent (private transcripts: send = [])
const exampleHealth = example?.agents?.entries?.health || {};
const healthEntry = cfg.agents.entries.health || {};
cfg.agents.entries.health = {
  ...exampleHealth,
  ...healthEntry,
  workspace: healthWorkspace,
  skills: Array.from(new Set([...(exampleHealth.skills || []), ...(healthEntry.skills || [])])),
  tools: {
    ...(exampleHealth.tools || {}),
    ...(healthEntry.tools || {}),
    allow: Array.from(new Set([...(exampleHealth.tools?.allow || []), ...(healthEntry.tools?.allow || [])])),
    agentToAgent: {
      ...(exampleHealth.tools?.agentToAgent || {}),
      ...(healthEntry.tools?.agentToAgent || {}),
      send: [],
    },
  },
};

cfg.plugins = cfg.plugins || {};
cfg.plugins.entries = cfg.plugins.entries || {};
const prevPlugin = cfg.plugins.entries['health-timeline'] || {};
cfg.plugins.entries['health-timeline'] = {
  ...prevPlugin,
  enabled: true,
  config: {
    ...(prevPlugin.config || {}),
    dataDir,
    inboxDir,
  },
};

fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
console.log(`Updated ${configPath}`);
NODE

openclaw config validate || echo "[setup-vm] Warning: openclaw config validate reported an issue"

# Create convenience helper commands in ~/bin
cat > "${APP_HOME}/bin/ht-dashboard" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ -f "${ENV_FILE}" ] && set -a && source "${ENV_FILE}" && set +a
export HEALTH_TIMELINE_PYTHON="${VENV_DIR}/bin/python3"
export HEALTH_TIMELINE_PORT="\${HEALTH_TIMELINE_PORT:-8765}"
export HEALTH_TIMELINE_DATA_DIR="${DATA_DIR}"
export HEALTH_TIMELINE_INBOX_DIR="${INBOX_DIR}"
export HEALTH_TIMELINE_INBOX="${INBOX_DIR}"
cd "${REPO_DIR}"
exec "$(command -v node)" server.mjs "\$@"
EOF
chmod +x "${APP_HOME}/bin/ht-dashboard"

cat > "${APP_HOME}/bin/ht-gateway" <<EOF
#!/usr/bin/env bash
set -euo pipefail
[ -f "${ENV_FILE}" ] && set -a && source "${ENV_FILE}" && set +a
export HEALTH_TIMELINE_PYTHON="${VENV_DIR}/bin/python3"
export HEALTH_TIMELINE_DATA_DIR="${DATA_DIR}"
export HEALTH_TIMELINE_INBOX_DIR="${INBOX_DIR}"
export HEALTH_TIMELINE_INBOX="${INBOX_DIR}"
exec "$(command -v openclaw)" gateway run --bind loopback --port 18789 --allow-unconfigured "\$@"
EOF
chmod +x "${APP_HOME}/bin/ht-gateway"

cat > "${APP_HOME}/bin/ht-status" <<'EOF'
#!/usr/bin/env bash
echo "=== Services ==="
systemctl is-active health-timeline-dashboard.service openclaw-gateway.service 2>/dev/null || true
echo "=== Ports ==="
ss -tlnp 2>/dev/null | grep -E ':(8765|18789)\b' || true
echo "=== Memory ==="
free -h
EOF
chmod +x "${APP_HOME}/bin/ht-status"

# Install systemd services (bound strictly to 127.0.0.1 loopback)
NODE_BIN="$(command -v node)"
OPENCLAW_BIN="$(command -v openclaw)"

sudo tee /etc/systemd/system/health-timeline-dashboard.service >/dev/null <<EOF
[Unit]
Description=Health Timeline Local Dashboard (loopback 127.0.0.1:8765)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${REPO_DIR}
Environment=HEALTH_TIMELINE_PORT=8765
Environment=HEALTH_TIMELINE_HOST=127.0.0.1
Environment=HEALTH_TIMELINE_PYTHON=${VENV_DIR}/bin/python3
Environment=HEALTH_TIMELINE_DATA_DIR=${DATA_DIR}
Environment=HEALTH_TIMELINE_INBOX_DIR=${INBOX_DIR}
Environment=HEALTH_TIMELINE_INBOX=${INBOX_DIR}
Environment=PATH=${VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-${ENV_FILE}
ExecStart=${NODE_BIN} ${REPO_DIR}/server.mjs
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/openclaw-gateway.service >/dev/null <<EOF
[Unit]
Description=OpenClaw Gateway (loopback 127.0.0.1:18789)
After=network.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_HOME}
Environment=HOME=${APP_HOME}
Environment=HEALTH_TIMELINE_PYTHON=${VENV_DIR}/bin/python3
Environment=HEALTH_TIMELINE_DATA_DIR=${DATA_DIR}
Environment=HEALTH_TIMELINE_INBOX_DIR=${INBOX_DIR}
Environment=HEALTH_TIMELINE_INBOX=${INBOX_DIR}
Environment=PATH=${VENV_DIR}/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=-${ENV_FILE}
ExecStart=${OPENCLAW_BIN} gateway run --bind loopback --port 18789 --allow-unconfigured
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable health-timeline-dashboard.service openclaw-gateway.service >/dev/null 2>&1 || true

log "Setup complete! Start services with:"
echo "  sudo systemctl restart health-timeline-dashboard openclaw-gateway"
echo "Or run foreground helpers:"
echo "  ~/bin/ht-dashboard   # http://127.0.0.1:8765"
echo "  ~/bin/ht-gateway     # ws://127.0.0.1:18789"
