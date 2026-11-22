#!/usr/bin/env node
/**
 * Health Timeline — Cross-Agent MCP Server (Zero-Dependency JSON-RPC 2.0)
 *
 * Exposes the exact same Health Timeline tools, regional guidelines resource,
 * and portable SKILL.md prompts over:
 *   - stdio (default) — for Hermes, Claude, Cursor, Codex, OpenClaw bundles
 *   - Streamable HTTP (--http [--port 8766] [--host 127.0.0.1]) — for remote
 *     cloud/VM agents such as Grok Bot, Meta Muse, and OpenAI Dots.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHealthTools } from "./openclaw.mjs";
import { readRegionalGuidelines } from "./core/guidelines.mjs";
import { getOverview } from "./core/query.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_INFO = {
  name: "health-timeline",
  version: "0.2.0",
};
const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
];

const SERVER_INSTRUCTIONS = [
  "Health Timeline is a privacy-first personal health record keeper.",
  "Always call health_guidelines_read before interpreting lab results or trends.",
  "Treat each lab's own printed reference range as primary and regional guidelines as educational clinical targets.",
  "Cite both source document pages/excerpts (health_evidence) and official ministry URLs.",
  "Never diagnose, prescribe, invent follow-ups, or bypass the patient-identity gate.",
].join(" ");

function loadSkillPrompts() {
  const skillsDir = path.join(__dirname, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  const prompts = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) continue;
    const raw = fs.readFileSync(skillPath, "utf8");
    const nameMatch = raw.match(/^name:\s*(.+)$/m);
    const descMatch = raw.match(/^description:\s*(.+)$/m);
    prompts.push({
      name: (nameMatch ? nameMatch[1].trim() : entry.name).replace(/^["']|["']$/g, ""),
      description: (descMatch ? descMatch[1].trim() : `Skill ${entry.name}`).replace(/^["']|["']$/g, ""),
      body: raw,
    });
  }
  return prompts;
}

export function createMcpHandler(pluginConfig = {}) {
  const tools = createHealthTools(pluginConfig);
  const toolsByName = new Map(tools.map((t) => [t.name, t]));
  const prompts = loadSkillPrompts();
  const promptsByName = new Map(prompts.map((p) => [p.name, p]));

  const coreOpts = {};
  if (pluginConfig.dataDir) coreOpts.dataDir = pluginConfig.dataDir;
  if (pluginConfig.inboxDir) coreOpts.inboxDir = pluginConfig.inboxDir;

  function ok(id, result) {
    return { jsonrpc: "2.0", id, result };
  }

  function err(id, code, message, data) {
    return {
      jsonrpc: "2.0",
      id: id ?? null,
      error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
  }

  async function handleMessage(msg) {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
      return err(null, -32600, "Invalid JSON-RPC 2.0 request");
    }

    const { id, method, params = {} } = msg;
    const isNotification = id === undefined || id === null;

    if (typeof method !== "string") {
      return isNotification ? null : err(id, -32600, "Missing JSON-RPC method");
    }

    // Notifications require no response
    if (method === "notifications/initialized" || method === "notifications/cancelled") {
      return null;
    }

    try {
      switch (method) {
        case "initialize": {
          const requested = params?.protocolVersion;
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : SUPPORTED_PROTOCOL_VERSIONS[1];
          return ok(id, {
            protocolVersion,
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS,
          });
        }

        case "ping":
          return ok(id, {});

        case "tools/list":
          return ok(id, {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.parameters,
            })),
          });

        case "tools/call": {
          const name = params?.name;
          const args = params?.arguments ?? {};
          const tool = toolsByName.get(name);
          if (!tool) {
            return err(id, -32602, `Unknown tool: ${name}`);
          }
          try {
            const output = await tool.execute(String(id ?? "mcp"), args);
            return ok(id, {
              content: output.content ?? [
                { type: "text", text: JSON.stringify(output.details ?? output) },
              ],
              ...(output.details !== undefined
                ? { structuredContent: output.details }
                : {}),
              isError: false,
            });
          } catch (toolError) {
            return ok(id, {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    error: toolError instanceof Error ? toolError.message : String(toolError),
                  }),
                },
              ],
              isError: true,
            });
          }
        }

        case "resources/list":
          return ok(id, {
            resources: [
              {
                uri: "health://regional-guidelines.md",
                name: "Regional Official Clinical Guidelines",
                description:
                  "Synced national health ministry / WHO clinical target thresholds with official source citations.",
                mimeType: "text/markdown",
              },
              {
                uri: "health://overview.json",
                name: "Health Timeline Overview",
                description:
                  "Current summary of recent changes, abnormal flags, documented follow-ups, skipped non-owner docs, and review items.",
                mimeType: "application/json",
              },
            ],
          });

        case "resources/read": {
          const uri = params?.uri;
          if (uri === "health://regional-guidelines.md") {
            const g = readRegionalGuidelines(coreOpts);
            return ok(id, {
              contents: [
                {
                  uri,
                  mimeType: "text/markdown",
                  text: g.exists
                    ? g.markdown
                    : "# Regional Guidelines Not Yet Synced\n\nRun `health_onboarding` and `health_guidelines_sync` first.\n",
                },
              ],
            });
          }
          if (uri === "health://overview.json") {
            const overview = getOverview(coreOpts);
            return ok(id, {
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(overview, null, 2),
                },
              ],
            });
          }
          return err(id, -32002, `Resource not found: ${uri}`);
        }

        case "prompts/list":
          return ok(id, {
            prompts: prompts.map((p) => ({
              name: p.name,
              description: p.description,
              arguments: [],
            })),
          });

        case "prompts/get": {
          const prompt = promptsByName.get(params?.name);
          if (!prompt) {
            return err(id, -32602, `Unknown prompt: ${params?.name}`);
          }
          return ok(id, {
            description: prompt.description,
            messages: [
              {
                role: "user",
                content: { type: "text", text: prompt.body },
              },
            ],
          });
        }

        default:
          return isNotification ? null : err(id, -32601, `Method not found: ${method}`);
      }
    } catch (unexpected) {
      return isNotification
        ? null
        : err(
            id,
            -32603,
            unexpected instanceof Error ? unexpected.message : String(unexpected),
          );
    }
  }

  return { handleMessage, tools };
}

function startStdioServer(handler) {
  let buffer = Buffer.alloc(0);

  function writeJsonLine(response) {
    if (!response) return;
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }

  async function dispatchPayload(text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      writeJsonLine({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
      return;
    }

    if (Array.isArray(parsed)) {
      const replies = [];
      for (const item of parsed) {
        const res = await handler.handleMessage(item);
        if (res) replies.push(res);
      }
      if (replies.length > 0) writeJsonLine(replies);
      return;
    }

    const res = await handler.handleMessage(parsed);
    if (res) writeJsonLine(res);
  }

  let processing = Promise.resolve();

  function drainBuffer() {
    while (buffer.length > 0) {
      // Support Content-Length framed messages if a client uses LSP-style framing
      const headStr = buffer.subarray(0, Math.min(buffer.length, 64)).toString("utf8");
      if (/^Content-Length:/i.test(headStr)) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const headerText = buffer.subarray(0, headerEnd).toString("utf8");
        const lenMatch = headerText.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          buffer = buffer.subarray(headerEnd + 4);
          continue;
        }
        const contentLength = Number(lenMatch[1]);
        const bodyStart = headerEnd + 4;
        if (buffer.length < bodyStart + contentLength) return;
        const body = buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
        buffer = buffer.subarray(bodyStart + contentLength);
        processing = processing.then(() => dispatchPayload(body));
        continue;
      }

      // Standard MCP newline-delimited JSON-RPC 2.0
      const nlIndex = buffer.indexOf(0x0a);
      if (nlIndex === -1) return;
      const line = buffer.subarray(0, nlIndex).toString("utf8");
      buffer = buffer.subarray(nlIndex + 1);
      if (line.trim()) {
        processing = processing.then(() => dispatchPayload(line));
      }
    }
  }

  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drainBuffer();
  });

  process.stdin.on("end", () => {
    if (buffer.length > 0) {
      const rest = buffer.toString("utf8").trim();
      buffer = Buffer.alloc(0);
      if (rest) {
        processing = processing.then(() => dispatchPayload(rest));
      }
    }
  });
}

function startHttpServer(handler, { host, port }) {
  const bearerToken = process.env.HEALTH_TIMELINE_MCP_TOKEN || "";
  const sessionId = crypto.randomUUID();
  const MAX_BODY_BYTES = 10 * 1024 * 1024;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (bearerToken) {
      const auth = req.headers.authorization || "";
      if (auth !== `Bearer ${bearerToken}`) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          server: SERVER_INFO,
          tools: handler.tools.map((t) => t.name),
        }),
      );
      return;
    }

    if (url.pathname === "/mcp" && req.method === "POST") {
      const chunks = [];
      let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          res.writeHead(413, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Payload too large" }));
          return;
        }
        chunks.push(chunk);
      }

      let parsed;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Parse error" },
          }),
        );
        return;
      }

      if (Array.isArray(parsed)) {
        const replies = [];
        for (const item of parsed) {
          const reply = await handler.handleMessage(item);
          if (reply) replies.push(reply);
        }
        if (replies.length === 0) {
          res.writeHead(202, { "Mcp-Session-Id": sessionId });
          res.end();
          return;
        }
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Mcp-Session-Id": sessionId,
        });
        res.end(JSON.stringify(replies));
        return;
      }

      const reply = await handler.handleMessage(parsed);
      if (!reply) {
        res.writeHead(202, { "Mcp-Session-Id": sessionId });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
      });
      res.end(JSON.stringify(reply));
      return;
    }

    if (url.pathname === "/mcp" && req.method === "DELETE") {
      res.writeHead(204);
      res.end();
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, host, () => {
    process.stderr.write(
      `Health Timeline MCP Streamable HTTP server listening on http://${host}:${port}/mcp\n`,
    );
  });
}

function parseCliArgs(argv) {
  const opts = {
    http: false,
    host: process.env.HEALTH_TIMELINE_MCP_HOST || "127.0.0.1",
    port: Number(process.env.HEALTH_TIMELINE_MCP_PORT || 8766),
    dataDir: process.env.HEALTH_TIMELINE_DATA_DIR || undefined,
    inboxDir: process.env.HEALTH_TIMELINE_INBOX_DIR || undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--http") opts.http = true;
    else if (arg === "--host" && argv[i + 1]) opts.host = argv[++i];
    else if (arg === "--port" && argv[i + 1]) opts.port = Number(argv[++i]);
    else if (arg === "--data-dir" && argv[i + 1]) opts.dataDir = argv[++i];
    else if (arg === "--inbox-dir" && argv[i + 1]) opts.inboxDir = argv[++i];
  }
  return opts;
}

const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  const cli = parseCliArgs(process.argv.slice(2));
  const handler = createMcpHandler({
    dataDir: cli.dataDir,
    inboxDir: cli.inboxDir,
  });
  if (cli.http) {
    startHttpServer(handler, cli);
  } else {
    startStdioServer(handler);
  }
}
