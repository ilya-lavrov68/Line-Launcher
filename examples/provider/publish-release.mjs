// Publishes the other Demo Survival release without restarting the provider.
// The launcher then sees a new version on «Переподключиться», installs it, and
// the previous release stays in «История сборок» — which is what makes the
// rollback path testable by hand.
//
//   node examples/provider/publish-release.mjs            # toggle 1.0.0 <-> 1.1.0
//   node examples/provider/publish-release.mjs pack.zip   # pick one explicitly
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const dir = path.resolve(root, process.env.LINE_PROVIDER_DIR || ".provider");
const configFile = path.join(dir, "config.json");
const packsFile = path.join(dir, "packs.json");

for (const file of [configFile, packsFile]) {
  if (!existsSync(file)) {
    console.error(
      `Нет ${path.relative(root, file)}. Сначала: npm run demo (или provider:pack)`,
    );
    process.exit(2);
  }
}

const config = JSON.parse(readFileSync(configFile, "utf8"));
const packs = JSON.parse(readFileSync(packsFile, "utf8"));
const server = config.servers.find((s) => s.id === "demo");
if (!server) {
  console.error("В конфиге нет сервера demo — публиковать нечего.");
  process.exit(2);
}

const current = server.distribution.url.split("/").pop();
const requested = process.argv[2];
const next = requested || (current === "pack.zip" ? "pack-v2.zip" : "pack.zip");
if (!packs[next]) {
  console.error(
    `Неизвестный релиз ${next}. Доступны: ${Object.keys(packs).join(", ")}`,
  );
  process.exit(2);
}
if (next === current) {
  console.log(
    `Уже опубликован ${next} (${packs[next].version}) — ничего не меняю.`,
  );
  process.exit(0);
}

const base = server.distribution.url.slice(
  0,
  server.distribution.url.lastIndexOf("/"),
);
server.version = packs[next].version;
server.distribution = {
  url: `${base}/${next}`,
  sha256: packs[next].sha256,
  size_bytes: packs[next].size_bytes,
  unpacked_size_bytes: packs[next].unpacked_size_bytes,
};
writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Demo Survival: ${current} → ${next} (версия ${server.version})`);
console.log(
  "В лаунчере: «Переподключиться» → «Установить сборку» → «История сборок» → откат.",
);
