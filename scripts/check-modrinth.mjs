#!/usr/bin/env node
// Read-only Modrinth diagnostic. Does not install or modify a Minecraft profile.
import { createHash } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const MAX_API = 4 * 1024 * 1024;
const MAX_ARCHIVE = 64 * 1024 * 1024;
const MAX_INDEX = 16 * 1024 * 1024;

async function getBytes(raw, limit, fetcher) {
  let url = new URL(raw);
  for (let hops = 0; hops <= 5; hops++) {
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("Допускается только HTTPS без учётных данных.");
    const response = await fetcher(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || hops === 5)
        throw new Error("Некорректное перенаправление.");
      url = new URL(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Ошибка HTTP ${response.status}.`);
    if (Number(response.headers.get("content-length") || 0) > limit) {
      await response.body?.cancel();
      throw new Error("Ответ превышает лимит размера.");
    }
    let total = 0;
    const chunks = [];
    for await (const chunk of response.body ?? []) {
      total += chunk.byteLength;
      if (total > limit) throw new Error("Ответ превышает лимит размера.");
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks, total);
  }
  throw new Error("Слишком много перенаправлений.");
}

/** Read only the bounded index from a verified standard ZIP. No extraction. */
export function readMrpackIndex(buffer) {
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
  return index;
}

export async function inspectModrinth(project, version, fetcher = fetch) {
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
  const bytes = await getBytes(pack.url, MAX_ARCHIVE, fetcher);
  const hash = createHash("sha512").update(bytes).digest("hex");
  if (hash !== pack.hashes.sha512.toLowerCase())
    throw new Error("SHA-512 .mrpack не совпадает с API Modrinth.");
  const index = readMrpackIndex(bytes);
  return {
    project,
    version: selected.id,
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
  const [project, version] = process.argv.slice(2);
  inspectModrinth(project || "", version || "")
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
      console.log(
        "Архив и SHA-512 проверены; установка и запуск игры этой командой не проверяются.",
      );
      if (report.missingSha512) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`Ошибка проверки Modrinth: ${error.message}`);
      process.exitCode = 1;
    });
}
