// Regenerate the README gallery without a browser.
//
//   npm run screenshots:gallery
//
// This is the offline renderer pointed at `docs/images`, so the eight pictures
// README.md embeds are refreshed from the live theme tokens even when no Chrome
// is available. `npm run screenshots` is still the better tool when a browser
// exists: it drives the real components. This one draws a token-accurate
// approximation, which is what the fallback has always been.
//
// `SHOTS_DIR` is set here rather than in the npm script because `VAR=value cmd`
// is shell syntax: on Windows `npm run` hands the line to cmd.exe, where it is
// not an environment assignment at all.
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
    env: { ...process.env, SHOTS_DIR: path.join(root, "docs", "images") },
  },
);
process.exit(result.status ?? 1);
