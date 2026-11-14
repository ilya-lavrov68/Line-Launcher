#!/usr/bin/env node
// Read-only Modrinth diagnostic. Does not install or modify a Minecraft profile.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const MAX_API = 4 * 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024; // diagnostic default, not launcher limit
const LAUNCHER_ARCHIVE_LIMIT = 4 * 1024 * 1024 * 1024;
const LAUNCHER_OVERRIDE_LIMIT = 16 * 1024 * 1024 * 1024;
const MAX_INDEX = 16 * 1024 * 1024;

async function getBytes(raw, limit, fetcher, stage, timeoutMs, onProgress) {
  const tooLarge = (observed, declared = false) =>
    new Error(
      `${stage}: ${declared ? "Content-Length" : "Получено более"} ${observed} байт; лимит ${limit} байт.`,
    );
  let url = new URL(raw);
  for (let hops = 0; hops <= 5; hops++) {
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Допускается только HTTPS без учётных данных.");
    const signal = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetcher(url, { redirect: "manual", signal });
    } catch (error) {
      if (signal.aborted)
        throw new Error(
          `${stage}: истекло время ожидания (${timeoutMs / 1000} секунд).`,
        );
      throw error;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hops === 5)
        throw new Error("Некорректное перенаправление.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Ошибка HTTP ${response.status}.`);
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > limit) {
      await response.body?.cancel();
      throw tooLarge(declared, true);
    }
    let total = 0;
    const chunks = [];
    try {
      for await (const chunk of response.body ?? []) {
        total += chunk.byteLength;
        if (total > limit) throw tooLarge(total);
        chunks.push(Buffer.from(chunk));
        onProgress?.(total, declared);
      }
    } catch (error) {
      if (signal.aborted)
        throw new Error(
          `${stage}: истекло время ожидания (${timeoutMs / 1000} секунд), получено ${total} байт.`,
        );
      throw error;
    }
    return Buffer.concat(chunks, total);
  }
  throw new Error("Слишком много перенаправлений.");
}

/** Read only the bounded index from a verified standard ZIP. No extraction. */
export function readMrpackIndex(buffer) {
  return inspectArchiveIndex(buffer).index;
}

function inspectArchiveIndex(buffer) {
  const bad = () => new Error("Повреждённый или неподдерживаемый .mrpack.");
  if (buffer.length < 22) throw bad();
  let end = -1;
  for (
    let i = buffer.length - 22;
    i >= Math.max(0, buffer.length - 65_557);
    i--
  ) {
    if (
      buffer.readUInt32LE(i) === 0x06054b50 &&
      i + 22 + buffer.readUInt16LE(i + 20) === buffer.length
    ) {
      end = i;
      break;
    }
  }
  if (
    end < 0 ||
    buffer.readUInt16LE(end + 4) !== 0 ||
    buffer.readUInt16LE(end + 6) !== 0
  )
    throw bad();
  const count = buffer.readUInt16LE(end + 10);
  const centralSize = buffer.readUInt32LE(end + 12);
  let pos = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || centralSize === 0xffffffff || pos + centralSize > end)
    throw bad();
  const centralStart = pos;
  const centralEnd = pos + centralSize;
  let found;
  let overrideFiles = 0;
  let overrideBytes = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > centralEnd || buffer.readUInt32LE(pos) !== 0x02014b50)
      throw bad();
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const size = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    const next = pos + 46 + nameLen + extraLen + commentLen;
    if (next > centralEnd) throw bad();
    const name = buffer.toString("utf8", pos + 46, pos + 46 + nameLen);
    if (
      !name.endsWith("/") &&
      (name.startsWith("overrides/") || name.startsWith("client-overrides/"))
    ) {
      if (size === 0xffffffff) throw bad();
      overrideFiles++;
      overrideBytes += size;
    }
    if (name === "modrinth.index.json") {
      if (
        found ||
        flags & 1 ||
        size > MAX_INDEX ||
        compressed > MAX_ARCHIVE ||
        ![0, 8].includes(method)
      )
        throw bad();
      if (
        local + 30 > centralStart ||
        buffer.readUInt32LE(local) !== 0x04034b50
      )
        throw bad();
      const localName = buffer.readUInt16LE(local + 26);
      const localExtra = buffer.readUInt16LE(local + 28);
      const start = local + 30 + localName + localExtra;
      if (
        start + compressed > centralStart ||
        buffer.toString("utf8", local + 30, local + 30 + localName) !== name
      )
        throw bad();
      const data = buffer.subarray(start, start + compressed);
      const decoded =
        method === 0
          ? data
          : inflateRawSync(data, { maxOutputLength: MAX_INDEX });
      if (decoded.length !== size) throw bad();
      found = decoded;
    }
    pos = next;
  }
  if (!found || pos !== centralEnd) throw bad();
  const index = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(found),
  );
  if (
    index.formatVersion !== 1 ||
    (index.game && index.game !== "minecraft") ||
    !Array.isArray(index.files)
  )
    throw bad();
  return { index, overrideFiles, overrideBytes };
}

export async function inspectModrinth(
  project,
  version,
  fetcher = fetch,
  archiveLimit = MAX_ARCHIVE,
  onProgress,
) {
  if (
    !Number.isSafeInteger(archiveLimit) ||
    archiveLimit < MAX_ARCHIVE ||
    archiveLimit > 512 * 1024 * 1024
  )
    throw new Error("Лимит архива должен быть от 64 до 512 МиБ.");
  if (
    !/^[a-zA-Z0-9_-]{1,64}$/.test(project) ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(version)
  )
    throw new Error("Укажите ID проекта и ID версии Modrinth.");
  const versions = JSON.parse(
    (
      await getBytes(
        `https://api.modrinth.com/v2/project/${project}/version`,
        MAX_API,
        fetcher,
        "Список версий Modrinth",
        60_000,
      )
    ).toString("utf8"),
  );
  if (!Array.isArray(versions))
    throw new Error("Modrinth вернул некорректный список версий.");
  const selected = versions.find((v) => v.id === version);
  if (!selected || !Array.isArray(selected.files))
    throw new Error("Указанная версия проекта не найдена.");
  const packs = selected.files.filter(
    (f) => typeof f.filename === "string" && f.filename.endsWith(".mrpack"),
  );
  const pack = packs.find((f) => f.primary) || packs[0];
  if (!pack || !/^[a-fA-F0-9]{128}$/.test(pack.hashes?.sha512 || ""))
    throw new Error("У версии нет .mrpack с SHA-512.");
  const bytes = await getBytes(
    pack.url,
    archiveLimit,
    fetcher,
    "Архив .mrpack",
    2 * 60 * 60_000,
    onProgress,
  );
  const hash = createHash("sha512").update(bytes).digest("hex");
  if (hash !== pack.hashes.sha512.toLowerCase())
    throw new Error("SHA-512 .mrpack не совпадает с API Modrinth.");
  const { index, overrideFiles, overrideBytes } = inspectArchiveIndex(bytes);
  return {
    project,
    version: selected.id,
    archiveBytes: bytes.length,
    launcherArchiveLimitBytes: LAUNCHER_ARCHIVE_LIMIT,
    exceedsLauncherArchiveLimit: bytes.length > LAUNCHER_ARCHIVE_LIMIT,
    overrideFiles,
    declaredOverrideBytes: overrideBytes,
    launcherOverrideLimitBytes: LAUNCHER_OVERRIDE_LIMIT,
    exceedsLauncherOverrideLimit: overrideBytes > LAUNCHER_OVERRIDE_LIMIT,
    versionNumber: selected.version_number ?? null,
    name: index.name ?? null,
    dependencies: index.dependencies ?? {},
    files: index.files.length,
    clientFiles: index.files.filter((f) => f.env?.client !== "unsupported")
      .length,
    missingSha512: index.files.filter(
      (f) =>
        f.env?.client !== "unsupported" &&
        !/^[a-fA-F0-9]{128}$/.test(f.hashes?.sha512 || ""),
    ).length,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [project, version, limitArg, ...extra] = process.argv.slice(2);
  const archiveLimit =
    limitArg === undefined ? MAX_ARCHIVE : Number(limitArg) * 1024 * 1024;
  if (extra.length || (limitArg !== undefined && !/^[0-9]+$/.test(limitArg))) {
    console.error(
      "Использование: npm run source:check-modrinth -- <project> <version> [лимит_архива_МиБ]",
    );
    process.exit(1);
  }
  let lastReported = 0;
  inspectModrinth(
    project || "",
    version || "",
    fetch,
    archiveLimit,
    (received, total) => {
      if (received - lastReported >= 32 * 1024 * 1024) {
        console.error(
          `Загружено ${received} байт${total ? ` из ${total}` : ""}...`,
        );
        lastReported = received;
      }
    },
  )
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      console.log(
        "Архив и SHA-512 проверены; установка и запуск игры этой командой не проверяются.",
      );
      if (report.exceedsLauncherArchiveLimit)
        console.log(
          "Внимание: архив превышает текущий лимит лаунчера 4 ГиБ; диагностика не означает, что установка возможна.",
        );
      if (report.exceedsLauncherOverrideLimit)
        console.log(
          "Внимание: заявленный размер overrides превышает лимит лаунчера 16 ГиБ.",
        );
      if (
        report.missingSha512 ||
        report.exceedsLauncherArchiveLimit ||
        report.exceedsLauncherOverrideLimit
      )
        process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`Ошибка проверки Modrinth: ${error.message}`);
      process.exitCode = 1;
    });
}
