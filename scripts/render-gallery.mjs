// Draw an offline gallery preview without a browser.
//
//   npm run screenshots:gallery
//
// This produces an offline approximation in `.offline-shots/gallery`; it never
// writes to `docs/images`. The README gallery is reserved for `npm run
// screenshots`, which photographs the real React components in a browser.
// This alias is retained for people who want the token-drawn gallery preview
// without installing Chrome, but it is not a replacement for those screenshots.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  [path.join(root, "scripts", "render-screens.mjs")],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      SHOTS_DIR: path.join(root, ".offline-shots", "gallery"),
    },
  },
);
process.exit(result.status ?? 1);
