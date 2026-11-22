import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function makeTempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "ht-bridge-"));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

class McpStdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.stderr = "";
    child.stderr.on("data", (chunk) => {
      this.stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk) => {
      this.buffer += chunk.toString("utf8");
      this._drain();
    });
  }

  _drain() {
    while (true) {
      // Support both newline-delimited JSON-RPC (MCP 2024-11-05+) and Content-Length framing
      const trimmed = this.buffer.trimStart();
      if (!trimmed) return;
      if (trimmed.startsWith("Content-Length:")) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = this.buffer.slice(0, headerEnd);
        const m = header.match(/Content-Length:\s*(\d+)/i);
        if (!m) return;
        const len = Number(m[1]);
        const bodyStart = headerEnd + 4;
        if (Buffer.byteLength(this.buffer.slice(bodyStart), "utf8") < len) return;
        const body = this.buffer.slice(bodyStart, bodyStart + len);
        this.buffer = this.buffer.slice(bodyStart + len);
        this._dispatch(JSON.parse(body));
      } else {
        const nl = this.buffer.indexOf("\n");
        if (nl === -1) return;
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        this._dispatch(JSON.parse(line));
      }
    }
  }

  _dispatch(msg) {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
    }
  }

  request(id, method, params = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout for ${method}. stderr=${this.stderr}`));
      }, 10000);
      this.pending.set(id, {
        resolve: (val) => {
          clearTimeout(timer);
          resolve(val);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
      this.child.stdin.write(payload);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
}

test("OpenClaw manifest, Agent Plugins bundle, skills, and health-bot config are well-formed", () => {
  const ocManifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "openclaw.plugin.json"), "utf8"));
  assert.equal(ocManifest.id, "health-timeline");
  assert.ok(Array.isArray(ocManifest.skills) && ocManifest.skills.includes("./skills"));
  assert.ok(Array.isArray(ocManifest.contracts?.tools) && ocManifest.contracts.tools.length >= 9);

  for (const requiredTool of [
    "health_onboarding",
    "health_guidelines_sync",
    "health_guidelines_read",
    "health_import",
    "health_commit_extracted",
    "health_timeline",
    "health_trend",
    "health_evidence",
    "health_overview",
  ]) {
    assert.ok(
      ocManifest.contracts.tools.includes(requiredTool),
      `Missing ${requiredTool} in openclaw.plugin.json contracts.tools`,
    );
  }

  // Portable Agent Plugins 1.0.0 bundle files
  const pluginJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "plugin.json"), "utf8"));
  assert.ok(pluginJson.name || pluginJson.id);
  const mcpJson = JSON.parse(readFileSync(path.join(REPO_ROOT, "mcp.json"), "utf8"));
  assert.ok(mcpJson.mcpServers && Object.keys(mcpJson.mcpServers).length >= 1);

  // Portable skills
  for (const skillDir of [
    "health-onboarding-guidelines",
    "health-clinical-context",
    "health-timeline-ingest",
  ]) {
    const skillFile = path.join(REPO_ROOT, "skills", skillDir, "SKILL.md");
    assert.ok(existsSync(skillFile), `Missing skill file ${skillFile}`);
    const content = readFileSync(skillFile, "utf8");
    assert.ok(content.startsWith("---"), `${skillFile} must have YAML frontmatter`);
    assert.match(content, /name:/);
    assert.match(content, /description:/);
  }

  // Centralized health bot config
  for (const f of ["SOUL.md", "AGENTS.md", "openclaw.health-bot.example.json"]) {
    assert.ok(existsSync(path.join(REPO_ROOT, "agents", "health", f)), `Missing agents/health/${f}`);
  }
  const botCfg = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "agents", "health", "openclaw.health-bot.example.json"), "utf8"),
  );
  assert.ok(botCfg.agents?.entries?.health, "Missing agents.entries.health");
  assert.equal(botCfg.tools?.sessions?.visibility, "agent");
  assert.equal(botCfg.tools?.agentToAgent?.enabled, true);
  assert.deepEqual(botCfg.agents?.entries?.health?.tools?.agentToAgent?.send, []);
  const mainSend = botCfg.agents?.entries?.main?.tools?.agentToAgent?.send;
  assert.ok(Array.isArray(mainSend) && mainSend.includes("health"), `Expected main -> health send rule, got ${JSON.stringify(mainSend)}`);
});

test("OpenClaw plugin registers all tools and executes onboarding/overview cleanly", async () => {
  const tmp = makeTempDir();
  const prevDataDir = process.env.HEALTH_TIMELINE_DATA_DIR;
  process.env.HEALTH_TIMELINE_DATA_DIR = tmp.dir;
  try {
    const mod = await import(`../openclaw.mjs?test=${Date.now()}`);
    const plugin = mod.default;
    assert.equal(plugin.id, "health-timeline");
    const tools = new Map();
    plugin.register({
      registerTool(tool) {
        tools.set(tool.name, tool);
      },
      pluginConfig: { dataDir: tmp.dir },
      config: {},
    });

    for (const name of [
      "health_onboarding",
      "health_guidelines_sync",
      "health_guidelines_read",
      "health_import",
      "health_commit_extracted",
      "health_timeline",
      "health_trend",
      "health_evidence",
      "health_overview",
    ]) {
      assert.ok(tools.has(name), `Plugin failed to register ${name}`);
    }

    const onboardRes = await tools.get("health_onboarding").execute("t1", {
      action: "set",
      fullName: "Test OpenClaw User",
      aliases: ["USER, TEST OPENCLAW"],
      dob: "1991-06-20",
      biologicalSex: "male",
      country: "MX",
    });
    const parsedOnboard = JSON.parse(onboardRes.content[0].text);
    assert.equal(parsedOnboard.country || parsedOnboard.profile?.country, "MX");

    const overviewRes = await tools.get("health_overview").execute("t2", {});
    const parsedOverview = JSON.parse(overviewRes.content[0].text);
    assert.ok(parsedOverview.counts, "Expected overview.counts");
  } finally {
    if (prevDataDir === undefined) delete process.env.HEALTH_TIMELINE_DATA_DIR;
    else process.env.HEALTH_TIMELINE_DATA_DIR = prevDataDir;
    tmp.cleanup();
  }
});

test("mcp-server.mjs handles stdio initialize, tools/list, and tools/call", async () => {
  const tmp = makeTempDir();
  const child = spawn(process.execPath, [path.join(REPO_ROOT, "mcp-server.mjs")], {
    env: {
      ...process.env,
      HEALTH_TIMELINE_DATA_DIR: tmp.dir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  try {
    const client = new McpStdioClient(child);
    const init = await client.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verifier-test", version: "0.1.0" },
    });
    assert.ok(init.serverInfo?.name, `Expected serverInfo in initialize: ${JSON.stringify(init)}`);
    client.notify("notifications/initialized", {});

    const listed = await client.request(2, "tools/list", {});
    assert.ok(Array.isArray(listed.tools) && listed.tools.length >= 9);
    const toolNames = new Set(listed.tools.map((t) => t.name));
    for (const expected of [
      "health_onboarding",
      "health_guidelines_sync",
      "health_guidelines_read",
      "health_import",
      "health_commit_extracted",
      "health_timeline",
      "health_trend",
      "health_evidence",
      "health_overview",
    ]) {
      assert.ok(toolNames.has(expected), `MCP tools/list missing ${expected}`);
    }

    const callRes = await client.request(3, "tools/call", {
      name: "health_onboarding",
      arguments: {
        action: "set",
        fullName: "MCP Smoke User",
        country: "US",
        biologicalSex: "female",
        dob: "1993-02-11",
      },
    });
    assert.ok(Array.isArray(callRes.content) && callRes.content.length >= 1);
    const body = JSON.parse(callRes.content[0].text);
    assert.equal(body.country || body.profile?.country, "US");
  } finally {
    child.kill("SIGTERM");
    tmp.cleanup();
  }
});
