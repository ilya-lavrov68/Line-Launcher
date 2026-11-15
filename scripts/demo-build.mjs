import { verifyWindowsIcon } from "./lib/windows-icon.mjs";
// Build a local-only release executable against the running demo provider.
// Never hand this executable to players: it enables the development CA feature.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import https from "node:https";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stateFile = path.join(root, ".provider/demo-state.json");
function fail(message) {
  console.error(`\n[demo:build] ${message}`);
  process.exit(1);
}
function state() {
  try {
    const data = JSON.parse(readFileSync(stateFile, "utf8"));
    const url = new URL(data.configUrl);
    if (
      url.protocol !== "https:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !path.isAbsolute(data.certPath) ||
      !existsSync(data.certPath)
    )
      throw new Error();
    return data;
  } catch {
    fail(
      "Не найден активный локальный демо-провайдер. Запустите в другом окне: npm run demo -- --battlearmory --provider-only",
    );
  }
}
function probe(data) {
  return new Promise((resolve) => {
    const request = https.get(
      data.configUrl,
      { ca: readFileSync(data.certPath), timeout: 5000 },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => request.destroy());
  });
}
if (process.platform !== "win32")
  fail("Эта команда пока предназначена для Windows.");
if (process.env.CARGO_BUILD_TARGET)
  fail(
    "CARGO_BUILD_TARGET не поддерживается этой командой. Уберите его и повторите.",
  );
function brandMatches(data) {
  try {
    return (
      JSON.parse(
        readFileSync(path.join(root, "branding/provider.json"), "utf8"),
      ).config_url === data.configUrl
    );
  } catch {
    return false;
  }
}
const before = state();
if (!brandMatches(before))
  fail(
    "В branding/provider.json указан другой провайдер. Перезапустите демо-провайдер.",
  );
if (!(await probe(before)))
  fail("Демо-провайдер не отвечает. Перезапустите его и повторите.");
console.log("[demo:build] Локальная тестовая сборка. Не распространять!\n");
const result = spawnSync(
  process.execPath,
  [
    path.join(root, "scripts/tauri.mjs"),
    "build",
    "--no-bundle",
    "--features",
    "dev-provider-ca",
  ],
  {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      CARGO_TARGET_DIR: path.join(root, "src-tauri/target"),
    },
  },
);
if (result.error || result.status !== 0)
  fail("Сборка не завершилась успешно; старый exe не будет запущен.");
const after = state();
if (
  before.configUrl !== after.configUrl ||
  before.certPath !== after.certPath ||
  before.pid !== after.pid ||
  !brandMatches(after) ||
  !(await probe(after))
)
  fail(
    "Провайдер изменился или остановился во время сборки. Повторите сборку с работающим провайдером.",
  );
const exe = path.join(root, "src-tauri/target/release/line-launcher.exe");
if (!existsSync(exe)) fail(`Готовый файл не найден: ${exe}`);
try {
  const result = verifyWindowsIcon(
    readFileSync(exe),
    readFileSync(path.join(root, "src-tauri/icons/icon.ico")),
  );
  console.log(`[demo:build] Иконка exe проверена: ${result.images} размеров.`);
} catch (error) {
  fail(`Проверка иконки exe не прошла: ${error.message}`);
}
console.log(
  `[demo:build] Запускаю ${exe}\n[demo:build] Отпечаток интерфейса: ${readFileSync(path.join(root, "src-tauri/.frontend-build.sha256"), "utf8").trim()}`,
);
const app = spawnSync(exe, [], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, LINE_DEV_CA_CERT: after.certPath },
});
if (app.error || app.status !== 0)
  fail("Не удалось запустить приложение или оно завершилось с ошибкой.");
