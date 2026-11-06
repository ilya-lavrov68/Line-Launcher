// Preflight environment check. `tauri dev` fails with a cryptic
// "cargo metadata ... program not found" when Rust is missing; this prints the
// actual cause and the fix instead. Exit code 1 only for blockers.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findMsvc, findWebView2, probe, tryLink } from "./lib/env-probe.mjs";

const root = path.resolve(import.meta.dirname, "..");
const platform = process.platform;
const args = new Set(process.argv.slice(2));
const rustRequired = !args.has("--frontend-only");

if (process.env.LINE_SKIP_DOCTOR === "1") {
  console.log("LINE_SKIP_DOCTOR=1 — проверка окружения пропущена.");
  process.exit(0);
}

const C = {
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

let blockers = 0;
const problems = [];

function ok(label, detail) {
  console.log(`  ${C.green("OK")}   ${label} ${C.dim(detail || "")}`);
}

function bad(label, detail, fixId) {
  console.log(`  ${C.red("НЕТ")}  ${label} ${C.dim(detail || "")}`);
  blockers += 1;
  if (fixId && !problems.includes(fixId)) problems.push(fixId);
}

function warn(label, detail) {
  console.log(`  ${C.yellow("!")}    ${label} ${C.dim(detail || "")}`);
}

console.log(C.bold("\nLine Launcher — проверка окружения\n"));

// --- Node -------------------------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor >= 22) ok("Node.js", process.versions.node);
else bad("Node.js", `${process.versions.node}, нужен 22+`, "node");

if (existsSync(path.join(root, "node_modules")))
  ok("node_modules", "установлены");
else bad("node_modules", "не установлены", "npm");

// --- Rust -------------------------------------------------------------------
console.log("");
const rustc = probe("rustc", ["--version"]);
const cargo = probe("cargo", ["--version"]);
if (rustRequired) {
  if (rustc) ok("rustc", rustc);
  else bad("rustc", "не найден в PATH", "rust");
  if (cargo) ok("cargo", cargo);
  else bad("cargo", "не найден в PATH", "rust");

  if (rustc) {
    const m = /rustc (\d+)\.(\d+)/.exec(rustc);
    if (m) {
      const [, major, minor] = m.map(Number);
      const needed = readFileSync(
        path.join(root, "src-tauri/Cargo.toml"),
        "utf8",
      );
      const req = /rust-version\s*=\s*"(\d+)\.(\d+)"/.exec(needed);
      if (req) {
        const [rMaj, rMin] = [Number(req[1]), Number(req[2])];
        if (major < rMaj || (major === rMaj && minor < rMin)) {
          bad(
            "версия Rust",
            `${major}.${minor}, нужна ${rMaj}.${rMin}+`,
            "rustup",
          );
        }
      }
    }
  }

  // Windows needs the MSVC linker; rustc alone is not enough.
  if (platform === "win32") {
    const msvc = findMsvc();
    if (msvc) {
      ok("MSVC Build Tools", `${msvc.path} ${C.dim(`[${msvc.via}]`)}`);
    } else {
      // Heuristics can miss a valid install (custom drive, moved VS). Let the
      // compiler decide before blocking the user.
      const link = tryLink();
      if (link.ok) ok("MSVC Build Tools", link.detail);
      else bad("MSVC Build Tools", "линковка не проходит", "msvc");
    }

    const webview = findWebView2();
    if (webview) ok("WebView2 Runtime", path.dirname(webview));
    else warn("WebView2 Runtime", "не найден — нужен для окна приложения");
  }
} else {
  console.log(C.dim("  Rust пропущен (--frontend-only)"));
}

// --- Optional tooling -------------------------------------------------------
console.log("");
const java = probe("java", ["-version"]);
if (java) ok("Java", java.split("\n")[0]);
else warn("Java", "нет — не нужны test:java / provider:pack");

const openssl = probe("openssl", ["version"]);
if (openssl) ok("openssl", openssl);
else warn("openssl", "нет — нужен только для test:provider");

// --- Verdict ----------------------------------------------------------------
if (blockers === 0) {
  console.log(C.green("\nГотово к сборке.\n"));
  process.exit(0);
}

const FIXES = {
  node: [
    "Node.js 22+: https://nodejs.org — установите LTS и переоткройте терминал.",
  ],
  npm: ["Установите зависимости:  npm ci"],
  rust: [
    "Установите Rust через rustup:",
    platform === "win32"
      ? "  скачайте https://win.rustup.rs/x86_64 и запустите (вариант 1, по умолчанию)"
      : "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh",
    "Затем ЗАКРОЙТЕ и снова откройте терминал — PATH обновляется только при старте.",
    "Проверка:  rustc --version  и  cargo --version",
  ],
  rustup: ["Обновите toolchain:  rustup update stable"],
  msvc: [
    "Установите Microsoft C++ Build Tools:",
    "  https://visualstudio.microsoft.com/visual-cpp-build-tools/",
    '  В инсталляторе выберите workload "Разработка классических приложений на C++",',
    "  обязательно с компонентом «Windows 10/11 SDK».",
    "Без него Rust соберётся, но линковка Tauri упадёт с ошибкой link.exe.",
  ],
};

console.log(C.red(`\nНайдено проблем: ${blockers}\n`));
for (const id of problems) {
  for (const line of FIXES[id] || []) console.log(line);
  console.log("");
}
console.log(
  C.dim(
    "Если проверка ошибается, а сборка работает: LINE_SKIP_DOCTOR=1 npm run tauri dev\n" +
      "Подробности: docs/RUNBOOK.md, раздел 1.",
  ),
);
console.log("");
process.exit(1);
