import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ICON_FILES, iconManifest } from "../scripts/lib/icon-integrity.mjs";
import { verifyWindowsIcon } from "../scripts/lib/windows-icon.mjs";

// Minimal PE32/PE32+ with RT_GROUP_ICON referring to RT_ICON, enough to
// exercise resource RVA mapping and cross-check the bytes, without Windows.
function fixture(is64: boolean) {
  const image = Buffer.from("icon bytes");
  const ico = Buffer.alloc(22 + image.length);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(1, 4);
  ico[6] = 32;
  ico[7] = 32;
  ico.writeUInt16LE(1, 10);
  ico.writeUInt16LE(32, 12);
  ico.writeUInt32LE(image.length, 14);
  ico.writeUInt32LE(22, 18);
  image.copy(ico, 22);
  const exe = Buffer.alloc(0xc00);
  exe.writeUInt16LE(0x5a4d, 0);
  exe.writeUInt32LE(0x80, 0x3c);
  exe.writeUInt32LE(0x4550, 0x80);
  exe.writeUInt16LE(1, 0x86);
  const opt = 0x98,
    size = is64 ? 240 : 224;
  exe.writeUInt16LE(size, 0x94);
  exe.writeUInt16LE(is64 ? 0x20b : 0x10b, opt);
  const dd = opt + (is64 ? 112 : 96);
  exe.writeUInt32LE(0x1000, dd + 16);
  exe.writeUInt32LE(0x800, dd + 20);
  const section = opt + size;
  exe.writeUInt32LE(0x1000, section + 12);
  exe.writeUInt32LE(0x800, section + 16);
  exe.writeUInt32LE(0x200, section + 20);
  const res = 0x200;
  function dir(offset: number, entries: [number, number][]) {
    exe.writeUInt16LE(entries.length, res + offset + 14);
    entries.forEach(([id, target], i) => {
      exe.writeUInt32LE(id, res + offset + 16 + i * 8);
      exe.writeUInt32LE(target, res + offset + 20 + i * 8);
    });
  }
  dir(0, [
    [3, 0x80000030],
    [14, 0x80000090],
  ]);
  dir(0x30, [[1, 0x80000050]]);
  dir(0x50, [[1033, 0x70]]);
  exe.writeUInt32LE(0x1140, res + 0x70);
  exe.writeUInt32LE(image.length, res + 0x74);
  dir(0x90, [[32512, 0x800000b0]]);
  dir(0xb0, [[1033, 0xd0]]);
  exe.writeUInt32LE(0x1100, res + 0xd0);
  exe.writeUInt32LE(20, res + 0xd4);
  const group = res + 0x100;
  exe.writeUInt16LE(1, group + 2);
  exe.writeUInt16LE(1, group + 4);
  exe[group + 6] = 32;
  exe[group + 7] = 32;
  exe.writeUInt16LE(1, group + 10);
  exe.writeUInt16LE(32, group + 12);
  exe.writeUInt32LE(image.length, group + 14);
  exe.writeUInt16LE(1, group + 18);
  image.copy(exe, res + 0x140);
  return { exe, ico };
}

test("compares the embedded PE icon, detects stale images and invalid executables", () => {
  for (const is64 of [false, true]) {
    const { exe, ico } = fixture(is64);
    assert.deepEqual(verifyWindowsIcon(exe, ico), { images: 1 });
    exe[0x200 + 0x140] ^= 1;
    assert.throws(() => verifyWindowsIcon(exe, ico), /не совпадает/);
    assert.throws(() => verifyWindowsIcon(exe.subarray(0, 12), ico));
  }
});

test("generated icon manifest notices missing or changed files", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "line-icons-"));
  try {
    const dir = path.join(root, "icons");
    mkdirSync(dir);
    assert.equal(iconManifest(dir), null);
    for (const name of ICON_FILES) writeFileSync(path.join(dir, name), name);
    const original = iconManifest(dir);
    assert.ok(original);
    assert.equal(iconManifest(dir), original);
    writeFileSync(path.join(dir, "icon.ico"), "stale");
    assert.notEqual(iconManifest(dir), original);
    rmSync(path.join(dir, "icon.ico"));
    assert.equal(iconManifest(dir), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("generation and Windows build verify the actual icon outputs", () => {
  const read = (file: string) =>
    readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
  const brand = read("scripts/apply-brand.ts");
  assert.match(brand, /iconManifest\(ICONS_DIR\)/);
  assert.match(brand, /!actual \|\| !sameText\(recorded, actual\)/);
  for (const file of ["scripts/demo-build.mjs", "scripts/tauri-build.mjs"]) {
    assert.match(read(file), /verifyWindowsIcon\(/);
  }
  assert.match(
    read("src-tauri/build.rs"),
    /icons\/\.brand-files\.sha256\.json/,
  );
});
