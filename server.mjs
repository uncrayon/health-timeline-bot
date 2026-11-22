import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readTimeline } from "./timeline.mjs";

const routes = new Map([
  ["/", ["web/index.html", "text/html; charset=utf-8"]],
  ["/app.mjs", ["web/app.mjs", "text/javascript; charset=utf-8"]],
  ["/style.css", ["web/style.css", "text/css; charset=utf-8"]],
  ["/reports/cedar.pdf", ["build/cedar-lab.pdf", "application/pdf"]],
  ["/reports/meridian.pdf", ["build/meridian-diagnostics.pdf", "application/pdf"]],
  ["/reports/cedar-1.png", ["build/cedar-1.png", "image/png"]],
  ["/reports/meridian-1.png", ["build/meridian-1.png", "image/png"]],
  ["/reports/meridian-2.png", ["build/meridian-2.png", "image/png"]],
]);

const server = createServer(async (request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'");
  if (request.method !== "GET") {
    response.writeHead(405, { Allow: "GET" }).end();
    return;
  }
  const route = request.url.split("?")[0];
  try {
    if (route === "/timeline.json") {
      const body = JSON.stringify(readTimeline());
      response.writeHead(200, { "Content-Type": "application/json" }).end(body);
      return;
    }
    const asset = routes.get(route);
    if (!asset) {
      response.writeHead(404).end("Page not found");
      return;
    }
    const [file, contentType] = asset;
    const body = await readFile(new URL(file, import.meta.url));
    response.writeHead(200, { "Content-Type": contentType }).end(body);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) response.writeHead(500);
    response.end("Health Timeline could not load. Run npm start.");
  }
});

const port = Number(process.env.HEALTH_TIMELINE_PORT || 8765);
server.listen(port, "127.0.0.1", () => {
  console.log("Health Timeline is running at http://127.0.0.1:" + server.address().port);
});
