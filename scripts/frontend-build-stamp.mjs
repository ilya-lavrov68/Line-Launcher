// Record the exact production frontend tree after Vite succeeds. Cargo watches
// this file, forcing generate_context! to run again when embedded assets change.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function frontendDigest(directory) {
  if (!existsSync(path.join(directory, "index.html"))) {
    throw new Error("Production frontend is missing dist/index.html");
  }
  const hash = createHash("sha256");
  function visit(dir, relative = "") {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file, rel);
      else if (entry.isFile()) {
        const data = readFileSync(file);
        // Length delimiters prevent ambiguous filename/content concatenations.
        hash.update(`${Buffer.byteLength(rel)}:${rel}:${data.length}:`);
        hash.update(data);
      } else throw new Error(`Unexpected frontend entry: ${rel}`);
    }
  }
  visit(directory);
  return hash.digest("hex");
}

export function writeFrontendStamp(directory, stamp) {
  const digest = frontendDigest(directory);
  const text = `${digest}\n`;
  if (!existsSync(stamp) || readFileSync(stamp, "utf8") !== text)
    writeFileSync(stamp, text);
  return digest;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = path.resolve(import.meta.dirname, "..");
  console.log(
    `[frontend] SHA-256 ${writeFrontendStamp(path.join(root, "dist"), path.join(root, "src-tauri/.frontend-build.sha256"))}`,
  );
}
