import { createServer } from "node:http";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { openDb, resolveDataDir } from "./core/db.mjs";
import { readRegionalGuidelines } from "./core/guidelines.mjs";
import { ingestFile } from "./core/ingest.mjs";
import { getDashboardPayload, getEvidence, getTrend } from "./core/query.mjs";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(REPO_ROOT, "web");
const FIXTURES_DIR = path.join(REPO_ROOT, "fixtures");

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB
const SAFE_DOC_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const SAFE_PAGE_RE = /^[1-9][0-9]{0,3}$/;

const ALLOWED_UPLOAD_EXTS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".heic"]);

const MIME_BY_EXT = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".heic", "image/heic"],
]);

const STATIC_ASSETS = new Map([
  ["/", [path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8"]],
  ["/index.html", [path.join(WEB_DIR, "index.html"), "text/html; charset=utf-8"]],
  ["/app.mjs", [path.join(WEB_DIR, "app.mjs"), "text/javascript; charset=utf-8"]],
  ["/style.css", [path.join(WEB_DIR, "style.css"), "text/css; charset=utf-8"]],
]);

function getServerConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir || process.env.HEALTH_TIMELINE_DATA_DIR || resolveDataDir()
  );
  const inboxDir = path.resolve(
    overrides.inboxDir || process.env.HEALTH_TIMELINE_INBOX_DIR || path.join(dataDir, "inbox")
  );
  const maxUploadBytes = Number(
    overrides.maxUploadBytes || process.env.HEALTH_TIMELINE_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES
  );
  const host = overrides.host || process.env.HEALTH_TIMELINE_HOST || "127.0.0.1";
  const port = overrides.port !== undefined
    ? Number(overrides.port)
    : Number(process.env.HEALTH_TIMELINE_PORT || 8765);
  return {
    dataDir,
    inboxDir,
    maxUploadBytes,
    host,
    port,
    coreOpts: {
      dataDir,
      inboxDir,
      ...(overrides.dbPath ? { dbPath: overrides.dbPath } : {}),
      ...(overrides.guidelinesPath ? { guidelinesPath: overrides.guidelinesPath } : {}),
      ...(overrides.allowSyntheticDemo !== undefined ? { allowSyntheticDemo: overrides.allowSyntheticDemo } : {}),
    },
  };
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendText(response, statusCode, text, extraHeaders = {}) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    ...extraHeaders,
  });
  response.end(text);
}

function hasUnsafePathChars(value) {
  return !value || value.includes("\0") || value.includes("/") || value.includes("\\") || value === "." || value === "..";
}

function decodeSegmentSafe(raw) {
  try {
    const decoded = decodeURIComponent(raw);
    if (hasUnsafePathChars(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function safeRealpath(targetPath) {
  try {
    return await realpath(targetPath);
  } catch {
    return null;
  }
}

function isWithinRoot(realTarget, realRoot) {
  if (!realTarget || !realRoot) return false;
  const rel = path.relative(realRoot, realTarget);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function resolveConfinedFile(candidatePath, allowedRoots) {
  if (!candidatePath || typeof candidatePath !== "string" || candidatePath.includes("\0")) {
    return null;
  }
  const realTarget = await safeRealpath(candidatePath);
  if (!realTarget) return null;

  const fileStat = await stat(realTarget).catch(() => null);
  if (!fileStat || !fileStat.isFile()) return null;

  const realRoots = (await Promise.all(allowedRoots.map(safeRealpath))).filter(Boolean);
  for (const root of realRoots) {
    if (isWithinRoot(realTarget, root)) {
      return realTarget;
    }
  }
  return null;
}

function lookupDocumentRecord(docId, coreOpts) {
  try {
    const db = openDb({ ...coreOpts, readOnly: true });
    try {
      const row = db.prepare(
        "SELECT id, filename, source_path, doc_type, page_count, meta_json FROM documents WHERE id = ?"
      ).get(docId);
      if (row) return row;
      const skipped = db.prepare(
        "SELECT id, filename, source_path FROM skipped_documents WHERE id = ?"
      ).get(docId);
      return skipped || null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

async function findEvidencePageFile(docId, pageNum, config) {
  const allowedRoots = [config.dataDir, config.inboxDir, FIXTURES_DIR];
  const candidates = [];

  try {
    const ev = getEvidence({ documentId: docId, page: pageNum }, config.coreOpts);
    if (ev?.imagePath) candidates.push(ev.imagePath);
  } catch {
    // Fall through to deterministic path candidates inside dataDir.
  }

  const pageStr = String(pageNum);
  const pagePadded2 = pageStr.padStart(2, "0");
  candidates.push(
    path.join(config.dataDir, "pages", docId, `page-${pageStr}.png`),
    path.join(config.dataDir, "pages", docId, `page-${pagePadded2}.png`),
    path.join(config.dataDir, "pages", docId, `${pageStr}.png`),
    path.join(config.dataDir, "pages", `${docId}-${pageStr}.png`),
    path.join(config.dataDir, "pages", `${docId}-${pagePadded2}.png`),
    path.join(config.dataDir, "evidence", docId, `page-${pageStr}.png`),
    path.join(config.dataDir, "evidence", docId, `${pageStr}.png`),
    path.join(config.dataDir, "evidence", `${docId}-${pageStr}.png`),
    path.join(config.dataDir, docId, `page-${pageStr}.png`),
    path.join(config.dataDir, `${docId}-${pageStr}.png`),
    path.join(config.dataDir, `${docId}-${pagePadded2}.png`)
  );

  // If the document itself is a lab photo, allow page 1 to serve the confined image directly.
  if (pageNum === 1) {
    const doc = lookupDocumentRecord(docId, config.coreOpts);
    if (doc?.source_path) {
      const ext = path.extname(doc.source_path).toLowerCase();
      if (ext && ext !== ".pdf" && MIME_BY_EXT.has(ext)) {
        candidates.push(doc.source_path);
      }
    }
  }

  for (const candidate of candidates) {
    const confined = await resolveConfinedFile(candidate, allowedRoots);
    if (confined) return confined;
  }
  return null;
}

async function findEvidenceSourceFile(docId, config) {
  const allowedRoots = [config.dataDir, config.inboxDir, FIXTURES_DIR];
  const candidates = [];

  try {
    const ev = getEvidence({ documentId: docId, page: 1 }, config.coreOpts);
    if (ev?.sourcePath) candidates.push(ev.sourcePath);
  } catch {
    // Fall back to DB lookup below.
  }

  const doc = lookupDocumentRecord(docId, config.coreOpts);
  if (doc?.source_path) candidates.push(doc.source_path);
  if (doc?.filename) {
    const base = path.basename(doc.filename);
    candidates.push(
      path.join(config.dataDir, base),
      path.join(config.dataDir, "sources", base),
      path.join(config.inboxDir, base),
      path.join(FIXTURES_DIR, base)
    );
  }

  for (const ext of ALLOWED_UPLOAD_EXTS) {
    candidates.push(
      path.join(config.dataDir, `${docId}${ext}`),
      path.join(config.dataDir, "sources", `${docId}${ext}`),
      path.join(config.inboxDir, `${docId}${ext}`)
    );
  }

  for (const candidate of candidates) {
    const confined = await resolveConfinedFile(candidate, allowedRoots);
    if (confined) return confined;
  }
  return null;
}

async function readRequestBody(request, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const err = new Error(`Upload exceeds maximum allowed size of ${Math.round(maxBytes / (1024 * 1024))} MB.`);
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function parseMultipartFile(bodyBuffer, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  if (!boundaryMatch) {
    const err = new Error("Missing multipart boundary.");
    err.statusCode = 400;
    throw err;
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  const delimiter = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");

  let cursor = bodyBuffer.indexOf(delimiter);
  while (cursor !== -1) {
    const partStart = cursor + delimiter.length;
    if (bodyBuffer[partStart] === 45 && bodyBuffer[partStart + 1] === 45) break; // closing "--"
    const contentOffset = (bodyBuffer[partStart] === 13 && bodyBuffer[partStart + 1] === 10)
      ? partStart + 2
      : partStart;
    const nextDelimiter = bodyBuffer.indexOf(delimiter, contentOffset);
    if (nextDelimiter === -1) break;

    const headerEnd = bodyBuffer.indexOf(headerSeparator, contentOffset);
    if (headerEnd !== -1 && headerEnd < nextDelimiter) {
      const headersText = bodyBuffer.subarray(contentOffset, headerEnd).toString("utf8");
      const filenameMatch = /filename\*=UTF-8''([^;\r\n]+)|filename="([^"]+)"|filename=([^;\r\n]+)/i.exec(headersText);
      if (filenameMatch) {
        let filename = filenameMatch[1]
          ? decodeURIComponent(filenameMatch[1])
          : (filenameMatch[2] || filenameMatch[3] || "").trim();
        let dataEnd = nextDelimiter;
        if (dataEnd >= 2 && bodyBuffer[dataEnd - 2] === 13 && bodyBuffer[dataEnd - 1] === 10) {
          dataEnd -= 2;
        }
        const data = bodyBuffer.subarray(headerEnd + headerSeparator.length, dataEnd);
        return { filename, data };
      }
    }
    cursor = nextDelimiter;
  }

  const err = new Error("No file part found in multipart upload.");
  err.statusCode = 400;
  throw err;
}

function sanitizeUploadFilename(rawName, contentType = "") {
  const base = path.basename(String(rawName || "")).replace(/\0/g, "").trim();
  let ext = path.extname(base).toLowerCase();
  if (!ext && contentType) {
    const ct = contentType.split(";")[0].trim().toLowerCase();
    for (const [candidateExt, mime] of MIME_BY_EXT.entries()) {
      if (mime === ct) {
        ext = candidateExt;
        break;
      }
    }
  }
  if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
    const err = new Error(`Unsupported file type "${ext || "unknown"}". Allowed: PDF, PNG, JPG, WEBP, HEIC.`);
    err.statusCode = 400;
    throw err;
  }
  const rawStem = path.basename(base, path.extname(base)) || "upload";
  const safeStem = rawStem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 80) || "upload";
  return `${safeStem}${ext}`;
}

async function handleUpload(request, url, config) {
  const contentType = String(request.headers["content-type"] || "");
  const body = await readRequestBody(request, config.maxUploadBytes);
  if (!body.length) {
    const err = new Error("Empty upload body.");
    err.statusCode = 400;
    throw err;
  }

  let rawFilename = "";
  let fileBuffer = null;

  if (contentType.toLowerCase().includes("multipart/form-data")) {
    const parsed = parseMultipartFile(body, contentType);
    rawFilename = parsed.filename;
    fileBuffer = parsed.data;
  } else if (contentType.toLowerCase().includes("application/json")) {
    let json;
    try {
      json = JSON.parse(body.toString("utf8"));
    } catch {
      const err = new Error("Invalid JSON payload.");
      err.statusCode = 400;
      throw err;
    }
    rawFilename = json?.filename || json?.name || "";
    const rawBase64 = json?.contentBase64 || json?.base64 || json?.data || "";
    if (typeof rawBase64 !== "string" || !rawBase64.trim()) {
      const err = new Error("Missing contentBase64 field in JSON upload.");
      err.statusCode = 400;
      throw err;
    }
    const stripped = rawBase64.replace(/^data:[^;]+;base64,/i, "").trim();
    fileBuffer = Buffer.from(stripped, "base64");
  } else {
    rawFilename = String(request.headers["x-filename"] || url.searchParams.get("filename") || "");
    fileBuffer = body;
  }

  if (!fileBuffer || !fileBuffer.length) {
    const err = new Error("Uploaded file is empty.");
    err.statusCode = 400;
    throw err;
  }

  const safeFilename = sanitizeUploadFilename(rawFilename, contentType);
  await mkdir(config.inboxDir, { recursive: true });
  const realInbox = await realpath(config.inboxDir);

  let targetPath = path.join(realInbox, safeFilename);
  const existing = await stat(targetPath).catch(() => null);
  if (existing) {
    const ext = path.extname(safeFilename);
    const stem = path.basename(safeFilename, ext);
    targetPath = path.join(realInbox, `${stem}-${Date.now()}${ext}`);
  }

  if (!isWithinRoot(path.resolve(targetPath), realInbox)) {
    const err = new Error("Invalid upload destination.");
    err.statusCode = 400;
    throw err;
  }

  await writeFile(targetPath, fileBuffer);
  const result = await ingestFile(targetPath, config.coreOpts);
  return {
    ok: result?.status !== "error",
    uploadedFilename: path.basename(targetPath),
    ...result,
  };
}

export function createDashboardServer(overrides = {}) {
  const config = getServerConfig(overrides);

  return createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'"
    );

    const rawUrl = request.url || "/";
    let url;
    try {
      url = new URL(rawUrl, "http://127.0.0.1");
    } catch {
      sendText(response, 400, "Bad request URL");
      return;
    }

    const pathname = url.pathname;

    try {
      // POST /api/upload
      if (pathname === "/api/upload") {
        if (request.method !== "POST") {
          sendText(response, 405, "Method Not Allowed", { Allow: "POST" });
          return;
        }
        const uploadResult = await handleUpload(request, url, config);
        const statusCode = uploadResult.status === "error" ? 422 : 200;
        sendJson(response, statusCode, uploadResult);
        return;
      }

      if (request.method !== "GET" && request.method !== "HEAD") {
        sendText(response, 405, "Method Not Allowed", { Allow: "GET, HEAD" });
        return;
      }

      // GET /api/dashboard & backward-compat /timeline.json
      if (pathname === "/api/dashboard" || pathname === "/timeline.json") {
        const payload = getDashboardPayload(config.coreOpts);
        sendJson(response, 200, payload);
        return;
      }

      // GET /api/trend?key=<canonical_key>
      if (pathname === "/api/trend") {
        const key = url.searchParams.get("key")?.trim();
        if (!key) {
          sendJson(response, 400, { error: "Missing required query parameter: key" });
          return;
        }
        const trend = getTrend(key, config.coreOpts);
        sendJson(response, 200, trend);
        return;
      }

      // GET /api/guidelines
      if (pathname === "/api/guidelines") {
        const guidelines = readRegionalGuidelines(config.coreOpts);
        sendJson(response, 200, guidelines);
        return;
      }

      // GET /api/evidence?obs=<id> or ?doc=<docId>&page=<n>
      if (pathname === "/api/evidence") {
        const obsId = url.searchParams.get("obs")?.trim();
        const docId = url.searchParams.get("doc")?.trim();
        const pageParam = url.searchParams.get("page")?.trim();
        if (!obsId && !docId) {
          sendJson(response, 400, { error: "Provide obs or doc query parameter." });
          return;
        }
        const filter = obsId
          ? obsId
          : { documentId: docId, page: pageParam && SAFE_PAGE_RE.test(pageParam) ? Number(pageParam) : 1 };
        const evidence = getEvidence(filter, config.coreOpts);
        if (!evidence) {
          sendJson(response, 404, { error: "Evidence not found." });
          return;
        }
        sendJson(response, 200, evidence);
        return;
      }

      // Evidence routes:
      //   GET /evidence/<docId>/page/<pageNum>.png
      //   GET /evidence/<docId>/source
      if (pathname.startsWith("/evidence/")) {
        // Reject raw encoded traversal markers immediately.
        if (/(^|\/)\.\.(\/|$)|%2e%2e|%2f|%5c|\\/i.test(rawUrl.split("?")[0])) {
          sendText(response, 400, "Invalid evidence path");
          return;
        }
        const parts = pathname.split("/").filter(Boolean);
        // ["evidence", docId, "source"]
        if (parts.length === 3 && parts[2] === "source") {
          const docId = decodeSegmentSafe(parts[1]);
          if (!docId || !SAFE_DOC_ID_RE.test(docId)) {
            sendText(response, 400, "Invalid document identifier");
            return;
          }
          const sourceFile = await findEvidenceSourceFile(docId, config);
          if (!sourceFile) {
            sendText(response, 404, "Source file not found");
            return;
          }
          const ext = path.extname(sourceFile).toLowerCase();
          const mime = MIME_BY_EXT.get(ext) || "application/octet-stream";
          const data = await readFile(sourceFile);
          response.writeHead(200, {
            "Content-Type": mime,
            "Content-Length": data.length,
            "Content-Disposition": `inline; filename="${path.basename(sourceFile).replace(/"/g, "")}"`,
          });
          response.end(request.method === "HEAD" ? undefined : data);
          return;
        }

        // ["evidence", docId, "page", "<pageNum>.png"]
        if (parts.length === 4 && parts[2] === "page" && parts[3].endsWith(".png")) {
          const docId = decodeSegmentSafe(parts[1]);
          const pageRaw = parts[3].slice(0, -4);
          if (!docId || !SAFE_DOC_ID_RE.test(docId) || !SAFE_PAGE_RE.test(pageRaw)) {
            sendText(response, 400, "Invalid evidence page request");
            return;
          }
          const pageNum = Number(pageRaw);
          const pageFile = await findEvidencePageFile(docId, pageNum, config);
          if (!pageFile) {
            sendText(response, 404, "Rendered page not found");
            return;
          }
          const ext = path.extname(pageFile).toLowerCase();
          const mime = MIME_BY_EXT.get(ext) || "image/png";
          const data = await readFile(pageFile);
          response.writeHead(200, {
            "Content-Type": mime,
            "Content-Length": data.length,
          });
          response.end(request.method === "HEAD" ? undefined : data);
          return;
        }

        sendText(response, 404, "Evidence route not found");
        return;
      }

      // Static web UI assets
      const staticAsset = STATIC_ASSETS.get(pathname);
      if (staticAsset) {
        const [assetPath, contentType] = staticAsset;
        const body = await readFile(assetPath);
        response.writeHead(200, {
          "Content-Type": contentType,
          "Content-Length": body.length,
        });
        response.end(request.method === "HEAD" ? undefined : body);
        return;
      }

      sendText(response, 404, "Page not found");
    } catch (error) {
      const statusCode = Number(error?.statusCode) || 500;
      if (statusCode >= 500) console.error("[server]", error);
      if (!response.headersSent) {
        if (pathname.startsWith("/api/") || pathname === "/timeline.json") {
          sendJson(response, statusCode, {
            error: statusCode >= 500 ? "Internal server error" : error.message,
          });
        } else {
          sendText(response, statusCode, statusCode >= 500 ? "Health Timeline could not load." : error.message);
        }
      } else {
        response.end();
      }
    }
  });
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isDirectRun) {
  const cfg = getServerConfig();
  const server = createDashboardServer();
  server.listen(cfg.port, cfg.host, () => {
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr ? addr.port : cfg.port;
    console.log(`Health Timeline is running at http://${cfg.host}:${boundPort}`);
  });
}
