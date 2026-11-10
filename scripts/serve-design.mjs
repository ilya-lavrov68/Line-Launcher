// Serves the built design sandbox (`/preview.html`) on a plain HTTP server.
//
//   npm run build && npm run design
//   PORT=4173 node scripts/serve-design.mjs
//
// The real window needs Tauri IPC, so opening the app in a browser shows the
// provider form and nothing else. This server redirects `/` to the sandbox,
// where both designs and every dock state can be compared without a backend.
// It is a review tool: it never serves outside `dist/` and refuses traversal.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
);
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

if (!existsSync(path.join(root, "preview.html"))) {
  console.error("Нет dist/preview.html. Сначала: npm run build");
  process.exit(2);
}

const server = createServer((request, response) => {
  const raw = request.url || "/";
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
  const url = new URL(raw, "http://localhost");
  if (url.pathname === "/" || url.pathname === "/index.html") {
    // The app window is not reviewable in a browser: send reviewers to the
    // sandbox instead of a form that cannot connect.
    response.writeHead(302, { Location: `/preview.html${query}` });
    response.end();
    return;
  }
  let relative;
  try {
    relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  } catch {
    response.writeHead(400).end("bad path");
    return;
  }
  const file = path.resolve(root, relative);
  if (
    !file.startsWith(root + path.sep) ||
    !existsSync(file) ||
    !statSync(file).isFile()
  ) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }
  response.writeHead(200, {
    "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Дизайн-песочница: http://localhost:${port}/preview.html`);
  console.log(
    `Старый дизайн:    http://localhost:${port}/preview.html?theme=old`,
  );
});
