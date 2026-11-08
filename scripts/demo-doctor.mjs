// Checks the whole demo chain without changing a single file.
//
//   npm run demo:doctor
//
// `npm run doctor` answers "can this machine build the desktop app at all".
// This script answers the narrower question people actually hit: "why does
// `npm run demo` not work for me". It walks the same steps the demo walks and
// reports the first things that would break, with the exact command to fix them.
import { existsSync, readFileSync, statfsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { findOpenSsl } from "./lib/find-openssl.mjs";
import { inspectCertificate } from "./lib/demo-cert.mjs";
import { findMsvc, findWebView2, probe } from "./lib/env-probe.mjs";

const root = path.resolve(import.meta.dirname, "..");
const argv = new Set(process.argv.slice(2));
const portIndex = process.argv.indexOf("--port");
const port = Number(
  (portIndex >= 0
    ? process.argv[portIndex + 1]
    : process.env.LINE_PROVIDER_PORT) || 8443,
);
const dir = path.resolve(root, process.env.LINE_PROVIDER_DIR || ".provider");

const C = {
  dim: (s) => `\u001b[2m${s}\u001b[m`,
  bold: (s) => `\u001b[1m${s}\u001b[m`,
  green: (s) => `\u001b[32m${s}\u001b[m`,
  yellow: (s) => `\u001b[33m${s}\u001b[m`,
  red: (s) => `\u001b[31m${s}\u001b[m`,
};
const blockers = [];
const warnings = [];
const ok = (label, detail = "") =>
  console.log(`  ${C.green("OK")}   ${label} ${C.dim(detail)}`);
const warn = (label, detail, fix) => {
  warnings.push({ label, fix });
  console.log(`  ${C.yellow("!")}    ${label} ${C.dim(detail)}`);
};
const bad = (label, detail, fix) => {
  blockers.push({ label, fix });
  console.log(`  ${C.red("НЕТ")}  ${label} ${C.dim(detail)}`);
};

console.log(`\n${C.bold("Демо-режим Line Launcher — диагностика")}\n`);

// 1. Node and dependencies -------------------------------------------------
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22)
  bad(
    `Node.js ${process.versions.node}`,
    "нужен 22 или новее",
    "Поставьте Node.js 22 LTS: https://nodejs.org",
  );
else ok("Node.js", process.versions.node);

if (!existsSync(path.join(root, "node_modules", "vite")))
  bad("node_modules", "зависимости не установлены", "npm ci");
else ok("node_modules", "установлены");

if (!existsSync(path.join(root, "node_modules", "@tauri-apps", "cli")))
  bad("@tauri-apps/cli", "не найден", "npm ci");
else ok("@tauri-apps/cli", "есть");

// 2. openssl — issues the local certificate --------------------------------
const openssl = findOpenSsl();
if (!openssl)
  bad(
    "openssl",
    "не найден — сертификат демо создать нечем",
    process.platform === "win32"
      ? "Поставьте Git for Windows (в нём есть openssl) или OpenSSL Win64: см. docs/BUILD.md, шаг 1"
      : "Поставьте openssl пакетным менеджером: см. docs/BUILD.md, шаг 1",
  );
else ok("openssl", `${openssl.version.split("\n")[0]} [${openssl.via}]`);

// 3. Rust — the desktop window cannot open without it ----------------------
const rustc = probe("rustc", ["--version"]);
const cargo = probe("cargo", ["--version"]);
if (!rustc || !cargo)
  bad(
    "Rust (rustc/cargo)",
    "не найден в PATH — окно приложения не соберётся",
    "Поставьте rustup: https://rustup.rs, затем ЗАКРОЙТЕ и откройте терминал. Подробно: docs/BUILD.md, шаг 2",
  );
else ok("Rust", `${rustc} / ${cargo}`);

// 3b. Windows: the two things that stop a Rust build cold ------------------
if (process.platform === "win32") {
  const msvc = findMsvc();
  if (msvc) ok("MSVC Build Tools", `${msvc.path} [${msvc.via}]`);
  else
    bad(
      "MSVC Build Tools",
      "не найдены — cargo не сможет слинковать приложение",
      "Visual Studio Build Tools → рабочая нагрузка «Разработка классических приложений на C++». Подробно: docs/BUILD.md, шаг 2",
    );
  const webview = findWebView2();
  if (webview)
    ok("WebView2 Runtime", webview.version || webview.path || "есть");
  else
    warn(
      "WebView2 Runtime",
      "не найден — окно может не открыться",
      "Поставьте Evergreen WebView2 Runtime: https://developer.microsoft.com/microsoft-edge/webview2/",
    );
}

// 4. Java — decides whether the demo can actually launch a game ------------
const javaBin = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const java = probe(javaBin("java"), ["-version"]);
const javac = probe(javaBin("javac"), ["-version"]);
const major = /version "(\d+)(?:\.(\d+))?/.exec(java || "");
const javaMajor = major
  ? Number(major[1]) === 1
    ? Number(major[2])
    : Number(major[1])
  : null;
if (!java)
  warn(
    "Java",
    "нет — демо будет без кнопки «Играть»",
    "Поставьте JDK 21 (Temurin) и задайте JAVA_HOME. Всё остальное в демо работает и без Java: docs/BUILD.md, шаг 3",
  );
else if (!javac && !process.env.ECJ_JAR)
  warn(
    "javac",
    `java ${javaMajor} есть, компилятора нет — демо-игру собрать нечем`,
    "Поставьте именно JDK (не JRE) или задайте ECJ_JAR. Без этого демо работает, но без запуска игры",
  );
else ok("Java", `JDK ${javaMajor} — запуск игры в демо будет доступен`);

// 5. The dev-only trust feature must exist ---------------------------------
const cargoToml = readFileSync(
  path.join(root, "src-tauri", "Cargo.toml"),
  "utf8",
);
if (!/^dev-provider-ca = \[\]/m.test(cargoToml))
  bad(
    "cargo-фича dev-provider-ca",
    "не объявлена в src-tauri/Cargo.toml",
    "Восстановите файл из git: git checkout -- src-tauri/Cargo.toml",
  );
else ok("dev-provider-ca", "фича на месте (в релизные сборки не попадает)");

// 6. Port -----------------------------------------------------------------
const busy = await new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(true));
  server.once("listening", () => server.close(() => resolve(false)));
  server.listen(port, "127.0.0.1");
});
const stateFile = path.join(dir, "demo-state.json");
let running = null;
try {
  running = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {
  running = null;
}
if (busy && running?.port === port)
  ok(
    "Порт " + port,
    `занят своим демо-провайдером (${running.configUrl}) — можно npm run demo:app`,
  );
else if (busy)
  bad(
    `Порт ${port}`,
    "занят посторонней программой",
    `Возьмите другой порт: npm run demo -- --port ${port + 10}`,
  );
else ok(`Порт ${port}`, "свободен");

// 7. Certificate ----------------------------------------------------------
const certPath = path.join(dir, "tls.crt");
if (!existsSync(certPath))
  ok("Сертификат", "будет создан при первом запуске демо");
else {
  const cert = inspectCertificate(certPath, "127.0.0.1");
  if (cert.valid) ok("Сертификат", `годен до ${cert.validTo}`);
  else ok("Сертификат", `${cert.reason} — демо автоматически выпустит новый`);
}

// 8. Free space for the Rust target dir -----------------------------------
try {
  const stats = statfsSync(root);
  const freeGb = (Number(stats.bavail) * Number(stats.bsize)) / 1024 ** 3;
  if (freeGb < 5)
    warn(
      "Свободное место",
      `${freeGb.toFixed(1)} ГБ`,
      "Первая сборка Rust занимает 3–5 ГБ (src-tauri/target). Освободите место",
    );
  else ok("Свободное место", `${freeGb.toFixed(1)} ГБ`);
} catch {
  // statfs is not available everywhere; not worth a warning.
}

// 9. Branding is restorable -----------------------------------------------
const brandFile = path.join(root, "branding", "provider.json");
ok(
  "branding/provider.json",
  existsSync(brandFile)
    ? "демо подменит адрес и вернёт файл как был"
    : "файла нет — демо создаст его и удалит при выходе",
);

console.log("");
if (blockers.length === 0) {
  console.log(
    `${C.green("✔")} Демо можно запускать: ${C.bold("npm run demo")}`,
  );
  if (warnings.length) {
    console.log(`\n${C.yellow("Не блокирует, но стоит знать:")}`);
    for (const item of warnings) console.log(`  • ${item.label}: ${item.fix}`);
  }
  console.log(
    `\n${C.dim("Первая сборка Rust занимает несколько минут — это нормально.")}` +
      `\n${C.dim("Что нажимать в приложении: docs/DEMO.md. Сборка своего лаунчера: docs/BUILD.md.")}` +
      `\n${C.dim("Полная проверка тулчейна (включая линковку): npm run doctor")}\n`,
  );
  process.exit(0);
}
console.log(`${C.red(`Мешает запуску: ${blockers.length}`)}\n`);
for (const item of blockers) console.log(`  • ${item.label}\n    ${item.fix}`);
console.log(
  `\n${C.dim("Пошаговая установка всего нужного: docs/BUILD.md")}` +
    `\n${C.dim("Только провайдер, без сборки приложения: npm run demo -- --provider-only\n")}`,
);
process.exit(1);
