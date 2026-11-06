// CI gate: the `tauri` crate and `@tauri-apps/api` must share major.minor,
// exactly as the Tauri CLI requires. Fails with the remedy instead of letting
// `tauri build` abort halfway through.
import path from "node:path";
import { checkTauriVersions, tauriVersionHelp } from "./lib/tauri-versions.mjs";

const root = path.resolve(import.meta.dirname, "..");
const { pairs, mismatches, missing } = checkTauriVersions(root);

if (missing.length > 0) {
  console.error(
    `Не удалось проверить версии Tauri: нет ${missing.join(", ")}.\n` +
      "Выполните npm ci и убедитесь, что src-tauri/Cargo.lock закоммичен.",
  );
  process.exit(1);
}
if (pairs.length === 0) {
  console.error("В Cargo.lock не найден крейт tauri.");
  process.exit(1);
}
for (const p of pairs) {
  console.log(`${p.crate} ${p.crateVersion} ↔ ${p.npm} ${p.npmVersion}`);
}
if (mismatches.length > 0) {
  console.error(`\n${tauriVersionHelp(mismatches)}`);
  process.exit(1);
}
console.log("Tauri crate/npm versions are aligned.");
