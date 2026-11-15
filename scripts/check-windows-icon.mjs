import { readFileSync } from "node:fs";
import path from "node:path";
import { verifyWindowsIcon } from "./lib/windows-icon.mjs";
const root = path.resolve(import.meta.dirname, "..");
const exe = path.resolve(
  process.argv[2] ??
    path.join(root, "src-tauri/target/release/line-launcher.exe"),
);
try {
  const result = verifyWindowsIcon(
    readFileSync(exe),
    readFileSync(path.join(root, "src-tauri/icons/icon.ico")),
  );
  console.log(
    `[icon] Совпадает с icon.ico: ${result.images} размеров. Файл: ${exe}`,
  );
} catch (error) {
  console.error(`[icon] ${error.message}`);
  process.exitCode = 1;
}
