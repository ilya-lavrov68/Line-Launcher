// Read PE resources without launching the binary or trusting Explorer's cache.
// A Windows .ico's images are stored as RT_ICON entries referenced by an
// RT_GROUP_ICON; compare each image byte-for-byte with the input ICO.
import { createHash } from "node:crypto";

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
function assertRange(b, offset, size) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset + size > b.length
  )
    throw new Error("Некорректная структура файла иконки или exe.");
}
function icoImages(ico) {
  assertRange(ico, 0, 6);
  if (ico.readUInt16LE(0) !== 0 || ico.readUInt16LE(2) !== 1)
    throw new Error("Некорректный ICO.");
  const count = ico.readUInt16LE(4);
  if (!count || count > 256)
    throw new Error("Некорректное число изображений ICO.");
  assertRange(ico, 6, count * 16);
  const result = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const size = ico.readUInt32LE(at + 8),
      offset = ico.readUInt32LE(at + 12);
    assertRange(ico, offset, size);
    if (!size) throw new Error("Пустое изображение ICO.");
    result.push(digest(ico.subarray(offset, offset + size)));
  }
  return result.sort();
}

export function verifyWindowsIcon(exe, ico) {
  const expected = icoImages(ico);
  assertRange(exe, 0, 64);
  if (exe.readUInt16LE(0) !== 0x5a4d) throw new Error("Не Windows PE-файл.");
  const pe = exe.readUInt32LE(0x3c);
  assertRange(exe, pe, 24);
  if (exe.readUInt32LE(pe) !== 0x4550)
    throw new Error("Некорректный PE-заголовок.");
  const sections = exe.readUInt16LE(pe + 6),
    optionalSize = exe.readUInt16LE(pe + 20);
  if (!sections || sections > 96) throw new Error("Некорректные разделы PE.");
  const optional = pe + 24;
  assertRange(exe, optional, optionalSize);
  const magic = exe.readUInt16LE(optional);
  const directories = magic === 0x20b ? 112 : magic === 0x10b ? 96 : 0;
  if (!directories || optionalSize < directories + 24)
    throw new Error("Нет таблицы ресурсов PE.");
  const resourceRva = exe.readUInt32LE(optional + directories + 16);
  const resourceSize = exe.readUInt32LE(optional + directories + 20);
  if (!resourceRva || !resourceSize)
    throw new Error("В exe нет ресурсов иконки.");
  const sectionTable = optional + optionalSize;
  assertRange(exe, sectionTable, sections * 40);
  function mapRva(rva, size) {
    for (let i = 0; i < sections; i++) {
      const at = sectionTable + i * 40;
      const address = exe.readUInt32LE(at + 12),
        rawSize = exe.readUInt32LE(at + 16),
        raw = exe.readUInt32LE(at + 20);
      if (
        rva >= address &&
        rva - address <= rawSize &&
        size <= rawSize - (rva - address)
      ) {
        const offset = raw + rva - address;
        assertRange(exe, offset, size);
        return offset;
      }
    }
    throw new Error("Ресурс exe находится вне файла.");
  }
  const resource = mapRva(resourceRva, resourceSize);
  function relative(offset, size) {
    if (offset < 0 || size < 0 || offset + size > resourceSize)
      throw new Error("Некорректная таблица ресурсов exe.");
    return resource + offset;
  }
  function entries(offset) {
    const at = relative(offset, 16);
    const count = exe.readUInt16LE(at + 12) + exe.readUInt16LE(at + 14);
    if (count > 4096) throw new Error("Слишком много ресурсов exe.");
    const start = relative(offset + 16, count * 8);
    const result = [];
    for (let i = 0; i < count; i++) {
      const key = exe.readUInt32LE(start + i * 8),
        value = exe.readUInt32LE(start + i * 8 + 4);
      result.push({
        id: key & 0x80000000 ? null : key,
        directory: Boolean(value & 0x80000000),
        offset: value & 0x7fffffff,
      });
    }
    return result;
  }
  function payload(entry) {
    if (entry.directory) throw new Error("Некорректная запись ресурса exe.");
    const data = relative(entry.offset, 16);
    const rva = exe.readUInt32LE(data),
      size = exe.readUInt32LE(data + 4);
    if (!size || size > 32 * 1024 * 1024)
      throw new Error("Некорректный размер ресурса exe.");
    const start = mapRva(rva, size);
    return exe.subarray(start, start + size);
  }
  function typeDirectory(id) {
    const entry = entries(0).find((e) => e.id === id);
    if (!entry?.directory)
      throw new Error("В exe отсутствует нужный ресурс иконки.");
    return entries(entry.offset);
  }
  // Each icon id can contain multiple languages. Accept a matching language.
  const icons = new Map();
  for (const item of typeDirectory(3)) {
    if (item.id !== null && item.directory)
      icons.set(item.id, entries(item.offset).map(payload));
  }
  // Explorer's icon index 0 is the first icon group; a later matching group
  // must not hide an outdated first group.
  for (const group of typeDirectory(14).slice(0, 1)) {
    if (!group.directory) continue;
    for (const language of entries(group.offset)) {
      const bytes = payload(language);
      assertRange(bytes, 0, 6);
      if (bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) continue;
      const count = bytes.readUInt16LE(4);
      if (count !== expected.length) continue;
      assertRange(bytes, 6, count * 14);
      const images = [];
      for (let i = 0; i < count; i++) {
        const at = 6 + i * 14;
        const id = bytes.readUInt16LE(at + 12),
          size = bytes.readUInt32LE(at + 8);
        const options = (icons.get(id) ?? [])
          .filter((data) => data.length === size)
          .map(digest);
        const match = options.find((hash) => expected.includes(hash));
        if (!match) break;
        images.push(match);
      }
      if (
        images.length === count &&
        images.sort().every((hash, i) => hash === expected[i])
      )
        return { images: count };
    }
  }
  throw new Error(
    "Иконка внутри exe не совпадает с текущим icons/icon.ico. Пересоберите приложение.",
  );
}
