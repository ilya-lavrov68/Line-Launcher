// One command that runs Line Launcher as a complete application against a local
// demo provider — no manual certificate trust, no env-var syntax, no URL typing.
//
//   npm run demo                  # provider + desktop app (needs Rust)
//   npm run demo -- --provider-only   # provider only, app started separately
//   npm run demo -- --no-java     # skip the JDK: everything except launching
//   npm run demo -- --port 8553   # another port when 8443 is busy
//   npm run demo:update           # publish the second release (update/rollback)
//   npm run demo:check            # verify the demo provider over real HTTPS
//
// What it does, in order:
//   1. checks the tools it actually needs and says what to install if one is missing;
//   2. builds the demo packs, artwork and config (.provider/);
//   3. points branding/provider.json at the local config, remembering the original;
//   4. starts the HTTPS provider and waits until it answers;
//   5. runs `tauri dev --features dev-provider-ca` with LINE_DEV_CA_CERT set, so
//      the self-signed certificate is trusted by this process only;
//   6. on exit (Ctrl+C, closed window, crash) stops the provider and restores
//      branding/provider.json exactly as it was.
//
// The dev CA feature is a development-only cargo feature. This script never
// builds an installer and never touches the OS trust store.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOpenSsl, openSslHelp } from "./lib/find-openssl.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const portArg = argv.find((a) => a.startsWith("--port="));
const portIndex = argv.indexOf("--port");
const port = Number(
  portArg?.split("=")[1] ||
    (portIndex >= 0 ? argv[portIndex + 1] : process.env.LINE_PROVIDER_PORT) ||
    8443,
);
const providerOnly = flags.has("--provider-only");
const noJava = flags.has("--no-java");
const skipDoctor = flags.has("--skip-doctor");
const host = "127.0.0.1";
const base = `https://${host}:${port}`;
const configUrl = `${base}/config.json`;
const dir = path.join(root, ".provider");
const certPath = path.join(dir, "tls.crt");
const brandFile = path.join(root, "branding", "provider.json");

const C = {
  dim: (s) => `\u001b[38;2;130;130;130m${s}\u001b[m`,
  bold: (s) => `\u001b[1m${s}\u001b[m`,
  green: (s) => `\u001b[32m${s}\u001b[m`,
  yellow: (s) => `\u001b[33m${s}\u001b[m`,
  red: (s) => `\u001b[31m${s}\u001b[m`,
};
const step = (n, text) => console.log(`\n${C.bold(`[${n}/5]`)} ${text}`);
const info = (text) => console.log(`      ${C.dim(text)}`);

function fail(message, hint) {
  console.error(`\n${C.red("✗")} ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    ...options,
  });
  if (result.error) fail(`${cmd}: ${result.error.message}`);
  return result.status ?? 1;
}

// ---------------------------------------------------------------- preflight
step(1, "Проверяю окружение");
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) fail(`Нужен Node.js 22+, сейчас ${process.versions.node}.`);
info(`node ${process.versions.node}`);

if (!existsSync(path.join(root, "node_modules", "vite"))) {
  fail("Зависимости не установлены.", "Выполните: npm ci");
}
const openssl = findOpenSsl();
if (!openssl)
  fail("Не найден openssl — им создаётся локальный сертификат.", openSslHelp());
info(`openssl ${openssl.version.split("\n")[0]} [${openssl.via}]`);

if (process.platform === "darwin" && !providerOnly) {
  fail(
    "На macOS демо-сертификат нельзя подключить к процессу лаунчера.",
    "Добавьте .provider/tls.crt в System keychain (docs/RUNBOOK.md, 3.2) и запустите npm run demo -- --provider-only, а приложение — обычным npm run tauri dev.",
  );
}
if (!providerOnly && !skipDoctor) {
  const doctor = run(process.execPath, [path.join(root, "scripts/doctor.mjs")]);
  if (doctor !== 0) {
    fail(
      "Окружение не готово к запуску приложения (обычно нет Rust).",
      "Поставьте Rust stable и зависимости Tauri, либо запустите только провайдера: npm run demo -- --provider-only",
    );
  }
}

// ---------------------------------------------------------------- demo pack
step(2, "Собираю демо-проект: три сервера, два релиза, оформление");
const packEnv = {
  ...process.env,
  LINE_PROVIDER_URL: base,
  LINE_PROVIDER_PORT: String(port),
};
const packArgs = [path.join(root, "examples/provider/build-pack.mjs")];
if (noJava) packArgs.push("--no-java");
if (run(process.execPath, packArgs, { env: packEnv }) !== 0) {
  fail("Не удалось собрать демо-сборки.");
}

// ---------------------------------------------------------------- branding
step(3, "Направляю сборку на локальный провайдер");
const originalBrand = existsSync(brandFile)
  ? readFileSync(brandFile, "utf8")
  : null;
let brandChanged = false;
let provider = null;
let restored = false;

/** Puts the repository back exactly as it was, even after Ctrl+C or a crash. */
function restore() {
  if (restored) return;
  restored = true;
  if (brandChanged) {
    if (originalBrand === null) rmSync(brandFile, { force: true });
    else writeFileSync(brandFile, originalBrand);
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", path.join(root, "scripts/apply-brand.ts")],
      { cwd: root, stdio: "ignore" },
    );
    console.log(`\n${C.dim("branding/provider.json восстановлен")}`);
  }
  if (provider && provider.exitCode === null) {
    provider.kill("SIGTERM");
    // Windows has no SIGTERM semantics for a detached child; be firm.
    setTimeout(() => {
      if (provider && provider.exitCode === null) provider.kill("SIGKILL");
    }, 1500).unref();
  }
}

writeFileSync(
  brandFile,
  `${JSON.stringify(
    {
      $comment:
        "Временно подставлено npm run demo. Файл вернётся к прежнему содержимому при выходе.",
      config_url: configUrl,
    },
    null,
    2,
  )}\n`,
);
brandChanged = true;
if (
  run(process.execPath, [
    "--experimental-strip-types",
    path.join(root, "scripts/apply-brand.ts"),
  ]) !== 0
) {
  restore();
  fail("Не удалось применить брендинг.");
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    restore();
    process.exit(0);
  });
}
process.on("exit", restore);

// ---------------------------------------------------------------- provider
step(4, "Запускаю HTTPS-провайдера");
provider = spawn(
  process.execPath,
  [path.join(root, "examples/provider/server.mjs")],
  {
    cwd: root,
    env: { ...packEnv, LINE_PROVIDER_HOST: host },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let providerLog = "";
const forward = (chunk) => {
  providerLog += chunk;
  process.stdout.write(C.dim(String(chunk)));
};
provider.stdout.on("data", forward);
provider.stderr.on("data", forward);

const listening = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve(false), 20_000);
  provider.stdout.on("data", (chunk) => {
    if (String(chunk).includes("Reference provider listening")) {
      clearTimeout(timer);
      resolve(true);
    }
  });
  provider.once("exit", () => {
    clearTimeout(timer);
    resolve(false);
  });
  provider.once("error", () => {
    clearTimeout(timer);
    resolve(false);
  });
});
if (!listening) {
  restore();
  const busy = providerLog.includes("EADDRINUSE");
  fail(
    busy
      ? `Порт ${port} уже занят другим процессом.`
      : `Провайдер не запустился на порту ${port}.`,
    busy
      ? `Закройте его или возьмите другой порт: npm run demo -- --port ${port + 10}`
      : `Подробности в выводе выше. Другой порт: npm run demo -- --port ${port + 10}`,
  );
}

// A listening socket is not proof of a working TLS + config path; ask it.
const probe = await new Promise((resolve) => {
  const request = https.get(
    configUrl,
    { ca: readFileSync(certPath), timeout: 5000 },
    (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    },
  );
  request.on("error", () => resolve(false));
  request.on("timeout", () => {
    request.destroy();
    resolve(false);
  });
});
if (!probe) {
  restore();
  fail("Провайдер не отдал config.json по HTTPS.", providerLog.slice(-2000));
}

const config = JSON.parse(readFileSync(path.join(dir, "config.json"), "utf8"));
const launchable = config.servers.some((s) => s.auth?.launch_ticket_url);
console.log(`
${C.green("✔")} Демо-проект готов
      Адрес:        ${C.bold(configUrl)}
      Аккаунт:      ${C.bold("Player_1 / demo-password")} ${C.dim("(или зарегистрируйте свой)")}
      Серверы:      ${config.servers.map((s) => s.name).join(", ")}
      Запуск игры:  ${launchable ? C.green("включён") : C.yellow("выключен — нет JDK")}
      Сертификат:   ${certPath}
      Лог провайдера ниже показывает login / ticket / exchange / skin updated.
      Что нажимать: ${C.bold("docs/DEMO.md")}
      Обновление и откат: ${C.bold("npm run demo:update")} в другом терминале.`);

if (providerOnly) {
  console.log(
    `\n${C.dim("Провайдер работает. Приложение: npm run tauri dev -- --features dev-provider-ca")}` +
      `\n${C.dim(`LINE_DEV_CA_CERT=${certPath}`)}\n${C.dim("Остановить: Ctrl+C")}`,
  );
  await new Promise(() => {});
}

// ---------------------------------------------------------------- app
step(
  5,
  "Запускаю приложение (первая сборка Rust может занять несколько минут)",
);
info("dev-provider-ca добавляет локальный сертификат только этому процессу");
const app = spawn(
  process.execPath,
  [
    path.join(root, "scripts/tauri.mjs"),
    "dev",
    "--features",
    "dev-provider-ca",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...packEnv,
      LINE_DEV_CA_CERT: certPath,
      LINE_DEMO_SECONDS: process.env.LINE_DEMO_SECONDS || "20",
      LINE_SKIP_DOCTOR: "1",
    },
  },
);
const code = await new Promise((resolve) => {
  app.once("exit", (value) => resolve(value ?? 0));
  app.once("error", (error) => {
    console.error(error.message);
    resolve(1);
  });
});
restore();
process.exit(code);
