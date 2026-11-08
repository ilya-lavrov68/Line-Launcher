import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { zip } from "../scripts/lib/zip.mjs";
import {
  buildManifest,
  inspectLayout,
  MAX_ARCHIVE_BYTES,
  MAX_UNPACKED_BYTES,
  MAX_ZIP_ENTRIES,
  manifestForArchive,
  PACK_SCHEMA_VERSION,
  positionalArguments,
  readDirectory,
} from "../scripts/pack-manifest.mjs";

const read = (file: string) =>
  readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const bytes = (text: string) => Buffer.from(text, "utf8");
const URL_OK = "https://cdn.example.com/pack.zip";

function instanceArchive(prefix: string) {
  return zip([
    { name: `${prefix}mods/example.jar`, bytes: bytes("mod jar bytes") },
    { name: `${prefix}config/example.toml`, bytes: bytes("answer = 42") },
    {
      name: `${prefix}versions/fabric-loader-0.16.9-1.21.1/fabric-loader-0.16.9-1.21.1.json`,
      bytes: bytes('{"inheritsFrom":"1.21.1"}'),
    },
    {
      name: `${prefix}versions/1.21.1/1.21.1.json`,
      bytes: bytes('{"id":"1.21.1"}'),
    },
    {
      name: `${prefix}libraries/net/fabricmc/fabric-loader/0.16.9/fabric-loader-0.16.9.jar`,
      bytes: bytes("loader"),
    },
    { name: `${prefix}assets/objects/ab/abcdef`, bytes: bytes("sound") },
    { name: `${prefix}options.txt`, bytes: bytes("fov:90") },
    { name: "readme.txt", bytes: bytes("hello") },
  ]);
}

test("a zipped instance becomes a manifest the launcher can verify", () => {
  const archive = instanceArchive(".minecraft/");
  const { manifest, layout, fileCount } = manifestForArchive(archive, {
    url: URL_OK,
    revision: "1.0.0",
    version: "1.21.1",
  });
  assert.equal(manifest.schema_version, PACK_SCHEMA_VERSION);
  assert.equal(manifest.url, URL_OK);
  assert.equal(
    manifest.sha256,
    createHash("sha256").update(archive).digest("hex"),
  );
  assert.equal(manifest.size_bytes, archive.length);
  assert.equal(fileCount, 8);
  // Uncompressed total, not the archive size: that is what the extractor caps.
  const expected = readDirectory(archive).reduce(
    (sum: number, file: { size: number }) => sum + file.size,
    0,
  );
  assert.equal(manifest.unpacked_size_bytes, expected);
  assert.ok(expected > 0);
  assert.equal(manifest.revision, "1.0.0");
  assert.equal(manifest.minecraft_version, "1.21.1");
  assert.equal(layout.prefix, ".minecraft/");
  assert.deepEqual(layout.profiles, ["1.21.1", "fabric-loader-0.16.9-1.21.1"]);
  assert.equal(layout.hasLibraries, true);
  assert.equal(layout.hasAssets, true);
  // Exactly the fields PackManifest deserializes with deny_unknown_fields.
  assert.deepEqual(Object.keys(manifest).sort(), [
    "minecraft_version",
    "revision",
    "schema_version",
    "sha256",
    "size_bytes",
    "unpacked_size_bytes",
    "url",
  ]);
});

test("root-level and named-wrapper instances are both recognised", () => {
  assert.equal(inspectLayout(readDirectory(instanceArchive(""))).prefix, "");
  assert.equal(
    inspectLayout(readDirectory(instanceArchive("MyPack/.minecraft/"))).prefix,
    "MyPack/.minecraft/",
  );
  const flat = zip([{ name: "MyPack/mods/a.jar", bytes: bytes("x") }]);
  assert.equal(inspectLayout(readDirectory(flat)).prefix, "MyPack/");
  const wrong = zip([{ name: "docs/readme.txt", bytes: bytes("x") }]);
  assert.equal(inspectLayout(readDirectory(wrong)).prefix, null);
});

test("a mods-only pack is described without profiles so the launcher can fill gaps", () => {
  const archive = zip([
    { name: "mods/a.jar", bytes: bytes("jar") },
    { name: "config/a.toml", bytes: bytes("x") },
  ]);
  const { manifest, layout } = manifestForArchive(archive, { url: URL_OK });
  assert.deepEqual(layout.profiles, []);
  assert.equal(layout.hasLibraries, false);
  assert.equal(layout.hasAssets, false);
  assert.equal(manifest.minecraft_version, undefined);
});

test("the tool refuses what the launcher would refuse", () => {
  assert.throws(
    () =>
      buildManifest({
        url: "http://x/pack.zip",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        unpackedBytes: 1,
      }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      buildManifest({
        url: URL_OK,
        sha256: "A".repeat(64),
        sizeBytes: 1,
        unpackedBytes: 1,
      }),
    /sha256/,
  );
  assert.throws(
    () =>
      buildManifest({
        url: URL_OK,
        sha256: "a".repeat(63),
        sizeBytes: 1,
        unpackedBytes: 1,
      }),
    /sha256/,
  );
  assert.throws(
    () =>
      buildManifest({
        url: URL_OK,
        sha256: "a".repeat(64),
        sizeBytes: 0,
        unpackedBytes: 1,
      }),
    /архива/,
  );
  assert.throws(
    () =>
      buildManifest({
        url: URL_OK,
        sha256: "a".repeat(64),
        sizeBytes: 1,
        unpackedBytes: MAX_UNPACKED_BYTES + 1,
      }),
    /Распакованный/,
  );
  assert.throws(
    () =>
      buildManifest({
        url: URL_OK,
        sha256: "a".repeat(64),
        sizeBytes: MAX_ARCHIVE_BYTES + 1,
        unpackedBytes: 1,
      }),
    /архива/,
  );
  assert.throws(
    () =>
      buildManifest({
        url: URL_OK,
        sha256: "a".repeat(64),
        sizeBytes: 1,
        unpackedBytes: 1,
        version: "../evil",
      }),
    /minecraft_version/,
  );
  assert.throws(
    () => manifestForArchive(bytes("not a zip at all"), { url: URL_OK }),
    /ZIP/,
  );
});

test("limits and layout markers stay in sync with the Rust side", () => {
  const config = read("src-tauri/src/line/config.rs");
  const rustNumber = (name: string) => {
    const line = config
      .split("\n")
      .find((row) => row.includes(`pub const ${name}:`));
    assert.ok(line, `${name} is gone from config.rs`);
    const expression = line
      .split("=")[1]
      .replace(";", "")
      .replaceAll("_", "")
      .trim();
    return Function(`"use strict";return (${expression});`)() as number;
  };
  assert.equal(MAX_ARCHIVE_BYTES, rustNumber("MAX_ARCHIVE_BYTES"));
  assert.equal(MAX_UNPACKED_BYTES, rustNumber("MAX_UNPACKED_BYTES"));
  assert.equal(MAX_ZIP_ENTRIES, rustNumber("MAX_ZIP_ENTRIES"));
  const instance = read("src-tauri/src/line/instance.rs");
  for (const marker of [
    "versions/",
    "libraries/",
    "assets/",
    "mods/",
    "config/",
    "options.txt",
    "resourcepacks/",
  ]) {
    assert.ok(instance.includes(`"${marker}"`), `marker ${marker} drifted`);
  }
  assert.match(read("src-tauri/src/line/pack.rs"), /pub schema_version: u32/);
  assert.match(read("src-tauri/src/line/pack.rs"), /deny_unknown_fields/);
});

test("flag values are never taken for the archive path", () => {
  assert.deepEqual(positionalArguments(["pack.zip", URL_OK]), [
    "pack.zip",
    URL_OK,
  ]);
  assert.deepEqual(
    positionalArguments([
      "--version",
      "1.21.1",
      "pack.zip",
      "--out",
      "p.json",
      URL_OK,
    ]),
    ["pack.zip", URL_OK],
  );
  assert.deepEqual(positionalArguments(["--revision", "1.0.0"]), []);
});
