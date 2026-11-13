// Rules of the two new build sources, and the agreement between the launcher's
// own resolver and the converter script.
//
// The Rust implementation is not directly runnable here (no toolchain in this
// sandbox, and the rules live behind an HTTP client). So this test does two
// things: it exercises `src/lib/line/sources.ts` — a deliberate line-by-line
// mirror of the Rust rules — on real fixture files, and it asserts that the
// converter produces the same file set the mirror says it should.
//
// The mirror is only worth having if it cannot drift silently, so the last block
// checks the Rust source still contains the decisions these tests encode.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { PackwizMeta } from "../src/lib/line/sources.ts";
import {
  computeRevision,
  digest,
  modrinthFiles,
  packwizEntry,
  parseToml,
  pickModrinthVersion,
  strongHash,
} from "../src/lib/line/sources.ts";
import {
  convert,
  crc32,
  entryFromMetafile,
  readZipEntry,
  writeZip,
} from "../scripts/pack-from-packwiz.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = path.join(ROOT, "tests/fixtures/packwiz");
const read = (name: string) => readFileSync(path.join(FIXTURE, name), "utf8");

interface IndexFixture {
  files: { file: string }[];
}
interface PackFixture {
  name: string;
  "pack-format": string;
  index: { file: string; "hash-format": string };
  versions: Record<string, string>;
}

const PACK = parseToml(read("pack.toml")) as unknown as PackFixture;
const INDEX = parseToml(read("index.toml")) as unknown as IndexFixture;
const META = (name: string) => parseToml(read(name)) as unknown as PackwizMeta;

test("the reader handles the TOML packwiz actually writes", () => {
  // pack.toml: a title, a table, a table of versions.
  assert.equal(PACK.name, "Line Test Pack");
  assert.equal(PACK["pack-format"], "packwiz:1.1.0");
  assert.equal(PACK.index.file, "index.toml");
  assert.equal(PACK.index["hash-format"], "sha256");
  assert.equal(PACK.versions.minecraft, "1.21.1");
  assert.equal(PACK.versions.fabric, "0.16.9");

  // index.toml: an array of tables, the shape everything else depends on.
  assert.ok(Array.isArray(INDEX.files));
  assert.equal(INDEX.files.length, 5);
  assert.deepEqual(
    INDEX.files.map((entry: { file: string }) => entry.file),
    [
      "mods/sodium.pw.toml",
      "mods/sodium-extra.pw.toml",
      "mods/server-only.pw.toml",
      "mods/optional.pw.toml",
      "resourcepacks/line-ui.pw.toml",
    ],
  );

  // A metafile has a nested [download] table and sometimes an [option].
  const sodium = META("mods/sodium.pw.toml");
  assert.equal(sodium.side, "client");
  assert.equal(sodium.download?.["hash-format"], "sha512");
  assert.equal(META("mods/optional.pw.toml").option?.optional, true);
});

test("the reader refuses what it cannot parse instead of guessing", () => {
  // An unknown value is the failure that would otherwise become an empty pack
  // and a player with no mods, wondering why.
  assert.throws(
    () => parseToml("name = not-a-value\n"),
    /неизвестное значение/,
  );
  assert.throws(() => parseToml('name = """multi\nline"""\n'), /многострочные/);
  assert.throws(() => parseToml("no equals sign\n"), /нет «=/);
  // Comments are stripped, including a # inside a string.
  const parsed = parseToml('name = "a # b" # real comment\n');
  assert.equal(parsed.name, "a # b");
});

test("side and optional decide what is installed, and neither is an error", () => {
  // The distinction that matters: skipped is normal, refused is a mistake.
  const server = packwizEntry(
    "mods/server-only.pw.toml",
    META("mods/server-only.pw.toml"),
  );
  assert.deepEqual(server, { skip: "server-side" });
  const optional = packwizEntry(
    "mods/optional.pw.toml",
    META("mods/optional.pw.toml"),
  );
  assert.deepEqual(optional, { skip: "optional" });

  // The path comes from the metafile's own location, not from the filename:
  // `resourcepacks/line-ui.pw.toml` owns `resourcepacks/line-ui.zip`.
  const ui = packwizEntry(
    "resourcepacks/line-ui.pw.toml",
    META("resourcepacks/line-ui.pw.toml"),
  );
  assert.ok(ui.file, "the resource pack must resolve");
  assert.equal(ui.file.path, "resourcepacks/line-ui.zip");
  assert.equal(ui.file.hashFormat, "sha256");
});

test("weak hashes and CurseForge metadata are refused by name", () => {
  const sha1 = {
    filename: "x.jar",
    download: {
      url: "https://example.com/x.jar",
      "hash-format": "sha1",
      hash: "a".repeat(40),
    },
  };
  assert.match(
    packwizEntry("mods/x.pw.toml", sha1).error ?? "",
    /sha1 is not strong enough/,
  );

  const curseforge = {
    filename: "y.jar",
    update: { mode: "metadata:curseforge" },
    download: {
      url: "https://example.com/y.jar",
      "hash-format": "sha256",
      hash: "a".repeat(64),
    },
  };
  assert.match(
    packwizEntry("mods/y.pw.toml", curseforge).error ?? "",
    /CurseForge key/,
  );

  // A filename is not a path: it may not climb out of its own directory.
  const escaping = {
    filename: "../../.minecraft/options.txt",
    download: {
      url: "https://example.com/z.jar",
      "hash-format": "sha256",
      hash: "a".repeat(64),
    },
  };
  assert.match(
    packwizEntry("mods/z.pw.toml", escaping).error ?? "",
    /bad filename/,
  );

  // And the URL must be HTTPS: a plain-http manifest is a downgrade.
  const http = {
    filename: "w.jar",
    download: {
      url: "http://example.com/w.jar",
      "hash-format": "sha256",
      hash: "a".repeat(64),
    },
  };
  assert.match(packwizEntry("mods/w.pw.toml", http).error ?? "", /not https/);
});

test("only sha256 and sha512 count as checks", () => {
  assert.equal(strongHash("sha256"), true);
  assert.equal(strongHash("SHA512"), true);
  assert.equal(strongHash("sha1"), false);
  assert.equal(strongHash("md5"), false);
  assert.equal(strongHash("murmur2"), false);
  assert.equal(
    digest("sha256", Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.throws(() => digest("md5", Buffer.from("abc")), /weak hash/);
});

test("Modrinth: releases by default, a pinned beta only on request", () => {
  const versions = [
    { id: "BETA1", version_number: "2.0.0-beta.1", version_type: "beta" },
    { id: "REL2", version_number: "1.4.0", version_type: "release" },
    { id: "REL1", version_number: "1.3.0", version_type: "release" },
  ];
  assert.equal(pickModrinthVersion(versions, undefined).id, "REL2");
  // Pinned by id or by the number the page URL shows.
  assert.equal(pickModrinthVersion(versions, "BETA1").id, "BETA1");
  assert.equal(pickModrinthVersion(versions, "1.3.0").id, "REL1");
  assert.throws(() => pickModrinthVersion(versions, "9.9.9"), /not found/);
  // Only betas: refuse rather than silently ship one.
  assert.throws(
    () => pickModrinthVersion([{ id: "B", version_type: "beta" }], undefined),
    /only betas/,
  );
  // A missing version_type means release, which is what the API does.
  assert.equal(pickModrinthVersion([{ id: "R" }], undefined).id, "R");
});

test("Modrinth: sha512 is required and CurseForge-only files are named", () => {
  const good = {
    files: [
      {
        path: "mods/sodium.jar",
        downloads: ["https://cdn.modrinth.com/data/a/sodium.jar"],
        hashes: { sha1: "x", sha512: "b".repeat(128) },
        file_size: 1234,
      },
    ],
  };
  const files = modrinthFiles(good);
  assert.equal(files[0].path, "mods/sodium.jar");
  assert.equal(files[0].sha512, "b".repeat(128));

  const curseforgeOnly = {
    files: [
      {
        path: "mods/x.jar",
        downloads: ["https://edge.forgecdn.net/files/1/2/x.jar"],
        hashes: { sha512: "b".repeat(128) },
      },
    ],
  };
  assert.throws(() => modrinthFiles(curseforgeOnly), /only CurseForge/);

  const noSha512 = {
    files: [
      {
        path: "mods/y.jar",
        downloads: ["https://cdn.modrinth.com/data/a/y.jar"],
        hashes: { sha1: "x" },
      },
    ],
  };
  assert.throws(() => modrinthFiles(noSha512), /sha512/);
});

// ---------------------------------------------------------------------------
// The converter and the resolver must agree
// ---------------------------------------------------------------------------

/**
 * A complete pack built in memory, with real digests.
 *
 * The fixtures on disk carry placeholder hashes so their text can be read; the
 * converter verifies what it downloads, so an end-to-end conversion needs hashes
 * that match the bytes. Everything is served from maps — no disk, no network —
 * and the only thing standing between the test and the rules is `convert`.
 */
function localPack() {
  const payloads = new Map<string, Buffer>([
    ["mods/sodium.jar", Buffer.from("sodium-bytes")],
    ["mods/sodium-extra.jar", Buffer.from("sodium-extra-bytes")],
    ["resourcepacks/line-ui.zip", Buffer.from("LINE-UI-PACK")],
    ["mods/server-only.jar", Buffer.from("server-only")],
    ["mods/shader.jar", Buffer.from("shader")],
  ]);
  const sha256 = (name: string) =>
    digest("sha256", payloads.get(name) as Buffer);
  const meta = (name: string, body: string) => {
    payloads.set(name, Buffer.from(body, "utf8"));
    return body;
  };

  const metafiles: Record<string, string> = {
    "mods/sodium.pw.toml": meta(
      "mods/sodium.pw.toml",
      `name = "Sodium"\nfilename = "sodium.jar"\nside = "client"\n\n[download]\n` +
        `url = "https://cdn.example.com/sodium.jar"\nhash-format = "sha512"\n` +
        `hash = "${digest("sha512", payloads.get("mods/sodium.jar") as Buffer)}"\n`,
    ),
    "mods/sodium-extra.pw.toml": meta(
      "mods/sodium-extra.pw.toml",
      `name = "Sodium Extra"\nfilename = "sodium-extra.jar"\nside = "both"\n\n[download]\n` +
        `url = "https://cdn.example.com/sodium-extra.jar"\nhash-format = "sha256"\n` +
        `hash = "${sha256("mods/sodium-extra.jar")}"\n`,
    ),
    "mods/server-only.pw.toml": meta(
      "mods/server-only.pw.toml",
      `name = "Server"\nfilename = "server-only.jar"\nside = "server"\n\n[download]\n` +
        `url = "https://cdn.example.com/server-only.jar"\nhash-format = "sha256"\n` +
        `hash = "${sha256("mods/server-only.jar")}"\n`,
    ),
    "mods/optional.pw.toml": meta(
      "mods/optional.pw.toml",
      `name = "Shader"\nfilename = "shader.jar"\n\n[option]\noptional = true\n\n[download]\n` +
        `url = "https://cdn.example.com/shader.jar"\nhash-format = "sha256"\n` +
        `hash = "${sha256("mods/shader.jar")}"\n`,
    ),
    "resourcepacks/line-ui.pw.toml": meta(
      "resourcepacks/line-ui.pw.toml",
      `name = "Line UI"\nfilename = "line-ui.zip"\nside = "client"\n\n[download]\n` +
        `url = "https://cdn.example.com/line-ui.zip"\nhash-format = "sha256"\n` +
        `hash = "${sha256("resourcepacks/line-ui.zip")}"\n`,
    ),
  };
  const index = meta(
    "index.toml",
    `hash-format = "sha256"\n\n` +
      Object.keys(metafiles)
        .map(
          (name) =>
            `[[files]]\nfile = "${name}"\nmetafile = true\nhash = "${digest("sha256", Buffer.from(metafiles[name]))}"\n`,
        )
        .join("\n"),
  );
  const pack = meta(
    "pack.toml",
    `name = "Line Test Pack"\npack-format = "packwiz:1.1.0"\n\n[index]\nfile = "index.toml"\n` +
      `hash-format = "sha256"\nhash = "${digest("sha256", Buffer.from(index))}"\n\n` +
      `[versions]\nminecraft = "1.21.1"\nfabric = "0.16.9"\n`,
  );
  // The files the metafiles point at, addressed by URL, as a real reader would.
  // Built from the generated text, not from the on-disk fixtures — those are a
  // different pack whose hashes are placeholders.
  const byUrl = new Map<string, Buffer>(
    Object.entries(metafiles).map(([name, text]) => {
      const target = text.split('filename = "')[1].split('"')[0];
      const url = text.split('url = "')[1].split('"')[0];
      const dir = name.slice(0, name.lastIndexOf("/"));
      return [url, payloads.get(`${dir}/${target}`) as Buffer];
    }),
  );

  return {
    source: "https://raw.githubusercontent.com/owner/repo/main/pack.toml",
    reader: {
      async text(name: string) {
        const local = name.replace(
          /^https:\/\/raw\.githubusercontent\.com\/owner\/repo\/main\//,
          "",
        );
        if (local === "pack.toml") return pack;
        if (local === "index.toml") return index;
        if (metafiles[local]) return metafiles[local];
        throw new Error("no fixture for " + name);
      },
      async bytes(name: string) {
        if (name === "index.toml") return Buffer.from(index);
        if (metafiles[name]) return Buffer.from(metafiles[name]);
        const hit = byUrl.get(name);
        if (!hit) throw new Error("no fixture for " + name);
        return hit;
      },
    },
  };
}

test("the converter installs exactly what the rules say it should", async () => {
  // The fixtures carry placeholder hashes, so the rule outcome — not the bytes —
  // is what this compares. `packwizEntry` is the list of files the launcher's
  // installer would create; the converter's manifest must match it path for path.
  const expected = INDEX.files
    .map((entry: { file: string }) =>
      packwizEntry(entry.file, META(entry.file)),
    )
    .flatMap((outcome) => (outcome.file ? [outcome.file.path] : []))
    .sort();

  assert.deepEqual(expected, [
    "mods/sodium-0.6.13.jar",
    "mods/sodium-extra-0.6.0.jar",
    "resourcepacks/line-ui.zip",
  ]);

  // Same decisions in the converter, expressed on the same metafiles.
  const converted = INDEX.files
    .map((entry: { file: string }) =>
      entryFromMetafile(entry.file, META(entry.file)),
    )
    .flatMap((outcome) =>
      outcome.ok && outcome.entry ? [outcome.entry.path] : [],
    )
    .sort();
  assert.deepEqual(converted, expected);
});

test("the mirror and the converter reach the same verdict on every edge case", () => {
  // The two implementations exist to disagree loudly, so the assertion is on the
  // *kind* of outcome, not on the wording: a file, a skip, or a refusal. Wording
  // differs by language; behaviour must not differ at all.
  const sha256 = "a".repeat(64);
  const base = {
    filename: "x.jar",
    download: {
      url: "https://cdn.example.com/x.jar",
      "hash-format": "sha256",
      hash: sha256,
    },
  };
  const cases: [string, object][] = [
    ["plain client file", { ...base, side: "client" }],
    ["no side", { ...base }],
    ["server side", { ...base, side: "server" }],
    ["optional", { ...base, option: { optional: true } }],
    ["not optional", { ...base, option: { optional: false } }],
    [
      "sha1",
      { ...base, download: { ...base.download, "hash-format": "sha1" } },
    ],
    ["md5", { ...base, download: { ...base.download, "hash-format": "md5" } }],
    [
      "sha512",
      {
        ...base,
        download: {
          ...base.download,
          "hash-format": "sha512",
          hash: "b".repeat(128),
        },
      },
    ],
    ["no hash", { ...base, download: { ...base.download, hash: undefined } }],
    [
      "http url",
      {
        ...base,
        download: { ...base.download, url: "http://cdn.example.com/x.jar" },
      },
    ],
    [
      "metadata curseforge",
      { ...base, update: { mode: "metadata:curseforge" } },
    ],
    ["metadata modrinth", { ...base, update: { mode: "metadata:modrinth" } }],
    ["name with slash", { ...base, filename: "sub/x.jar" }],
    ["name climbs out", { ...base, filename: "../x.jar" }],
    ["empty name", { ...base, filename: "  " }],
  ];

  const verdict = (outcome: {
    ok?: boolean;
    skip?: string;
    error?: string;
    file?: { path: string };
    entry?: { path: string };
  }) => {
    if (outcome.error) return "refused";
    if (outcome.skip) return "skipped";
    return `file:${(outcome.file ?? outcome.entry)?.path}`;
  };

  for (const [label, meta] of cases) {
    const mirror = verdict(packwizEntry("mods/x.pw.toml", meta as PackwizMeta));
    const script = verdict(
      entryFromMetafile("mods/x.pw.toml", meta as PackwizMeta),
    );
    assert.equal(
      script,
      mirror,
      `${label}: mirror said ${mirror}, converter said ${script}`,
    );
  }

  // And the specific verdicts, so a case cannot silently become "refused" in
  // both implementations at once and still pass.
  assert.equal(
    verdict(packwizEntry("mods/x.pw.toml", cases[0][1] as never)),
    "file:mods/x.jar",
  );
  assert.equal(
    verdict(packwizEntry("mods/x.pw.toml", cases[2][1] as never)),
    "skipped",
  );
  assert.equal(
    verdict(packwizEntry("mods/x.pw.toml", cases[8][1] as never)),
    "refused",
  );
  // metadata:modrinth is a legitimate update mode: it still has a download URL.
  assert.equal(
    verdict(packwizEntry("mods/x.pw.toml", cases[11][1] as never)),
    "file:mods/x.jar",
  );
});

test("converting a real pack produces the files and nothing else", async () => {
  const { reader, source } = localPack();
  const result = await convert({ source, reader, dryRun: true });
  assert.deepEqual(
    result.manifest.files.map((file: { path: string }) => file.path),
    // Server-only and optional are still skipped with real hashes in place.
    // Index order, not sorted: the manifest describes the order it converted.
    ["mods/sodium.jar", "mods/sodium-extra.jar", "resourcepacks/line-ui.zip"],
  );
  assert.equal(result.skipped, 2);
  assert.equal(result.manifest.loader, "fabric");
  assert.equal(result.manifest.loaderVersion, "0.16.9");
  assert.equal(result.manifest.minecraft_version, "1.21.1");
  // Every file in the archive has a digest in the manifest that matches the
  // bytes, because that is what the installer will verify against.
  for (const file of result.manifest.files) {
    const bytes = readZipEntry(result.zip, `install/${file.path}`);
    assert.ok(bytes, `missing ${file.path}`);
    assert.equal(digest("sha256", bytes as Buffer), file.sha256);
    assert.equal((bytes as Buffer).length, file.size_bytes);
  }
});

test("converting the same pack twice is byte-identical", async () => {
  // A provider diffing two builds, or comparing digests in a release note,
  // needs the output to depend on the content and not on the clock or on the
  // order the index happened to list files in.
  const { reader, source } = localPack();
  const first = await convert({ source, reader, dryRun: true });
  const second = await convert({ source, reader, dryRun: true });
  assert.equal(first.zip.length, second.zip.length);
  assert.ok(first.zip.equals(second.zip), "the two archives must be identical");
});

test("the zip is readable back and its manifest describes the files", () => {
  const payload = Buffer.from("some bytes here");
  const zip = writeZip([{ name: "install/mods/a.jar", data: payload }]);
  assert.ok(readZipEntry(zip, "install/mods/a.jar")?.equals(payload));
  assert.equal(readZipEntry(zip, "install/mods/missing.jar"), null);
  // A known CRC vector, so a table typo cannot pass silently.
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
});

test("the revision changes with content and not with order", () => {
  const files = [
    { path: "b.jar", sha256: "b".repeat(64), size: 2 },
    { path: "a.jar", sha256: "a".repeat(64), size: 1 },
  ];
  const reversed = [...files].reverse();
  assert.equal(computeRevision(files), computeRevision(reversed));
  const changed = [{ ...files[0], sha256: "c".repeat(64) }, files[1]];
  assert.notEqual(computeRevision(files), computeRevision(changed));
});

// ---------------------------------------------------------------------------
// The Rust side still says what these tests assume
// ---------------------------------------------------------------------------

test("the Rust resolver keeps the same decisions", () => {
  const rust = (name: string) =>
    readFileSync(path.join(ROOT, "src-tauri/src/line/source", name), "utf8");

  const packwiz = rust("packwiz.rs");
  // Index hash is checked before the index is trusted.
  assert.match(
    packwiz,
    /matches!\(format\.to_ascii_lowercase\(\)\.as_str\(\), "sha256" \| "sha512"\)/,
  );
  // Server-side and optional entries are skipped, not installed.
  assert.match(packwiz, /meta\.side\.as_deref\(\) == Some\("server"\)/);
  assert.match(packwiz, /option\.optional/);
  // CurseForge metadata is refused with its reason.
  assert.match(packwiz, /metadata:/);
  // A filename may not contain a separator or climb.
  assert.match(packwiz, /filename\.contains\('\/'\)/);

  const modrinth = rust("modrinth.rs");
  assert.match(modrinth, /version_type.*release|is_release/);
  assert.match(modrinth, /hashes\.get\("sha512"\)/);
  assert.match(modrinth, /is_curseforge/);
  // Only official URLs: the host check is the whole point of "official link".
  assert.match(
    modrinth,
    /host != "modrinth\.com" && host != "www\.modrinth\.com"/,
  );

  const resolve = rust("resolve.rs");
  // The hash must be verified before parsing the index: parsing a document that
  // failed its hash would look like success.
  const verified = resolve.indexOf(
    "packwiz::digest(&pack.index.hash_format, &index_bytes)",
  );
  const parsed = resolve.indexOf("packwiz::parse_index(&index_bytes)");
  assert.ok(
    verified > 0 && parsed > verified,
    "verify the index hash before parsing it",
  );
  // And the .mrpack file itself is checked before its index is read.
  const packHash = resolve.indexOf("modrinth::matches_sha512");
  const packRead = resolve.indexOf('by_name("modrinth.index.json")');
  assert.ok(
    packHash > 0 && packRead > packHash,
    "verify .mrpack before reading its index",
  );
});

test("the generated version profile is readable by the launcher's own rules", () => {
  // `pack::inspect` decides the loader from `libraries[].name` and the version
  // from `inheritsFrom`. A profile that *looks* right but omits the coordinate
  // would install cleanly and then launch a vanilla client over a modded pack,
  // so the shape is asserted against the real parser instead of by eye.
  const installRust = readFileSync(
    path.join(ROOT, "src-tauri/src/line/source/install.rs"),
    "utf8",
  );
  const instanceRust = readFileSync(
    path.join(ROOT, "src-tauri/src/line/instance.rs"),
    "utf8",
  );

  // The coordinate table the writer uses must exist for every loader kind.
  for (const coordinate of [
    ["Fabric", "net.fabricmc", "fabric-loader"],
    ["Quilt", "org.quiltmc", "quilt-loader"],
    ["Forge", "net.minecraftforge", "forge"],
    ["NeoForge", "net.neoforged", "neoforge"],
  ] as const) {
    assert.ok(
      installRust.includes(`"${coordinate[2]}", "${coordinate[1]}"`) ||
        installRust.includes(`("${coordinate[2]}", "${coordinate[1]}")`),
      `${coordinate[0]} must be written as ${coordinate[1]}:${coordinate[2]}`,
    );
    // And the reader must know that exact pair.
    assert.match(
      instanceRust,
      new RegExp(
        `\\("${coordinate[1].replace(/\./g, "\\.")}", "${coordinate[2]}`,
      ),
      `instance.rs must recognise ${coordinate[1]}:${coordinate[2]}`,
    );
  }

  // The profile carries both fields `inspect` reads.
  assert.match(installRust, /"inheritsFrom": version/);
  assert.match(installRust, /"libraries": libraries/);
  assert.match(installRust, /"name": coordinate/);

  // A mods-only list must still acquire a profile; an existing profile wins.
  assert.match(installRust, /version_profile_ids\(&paths, ""\)/);
  assert.match(installRust, /index\.files\.push\(FileEntry/);
});

test("packwiz converter includes and verifies ordinary indexed files", async () => {
  const { reader, source } = localPack();
  const originalIndex = await reader.bytes("index.toml");
  const payload = Buffer.from("example config contents\n");
  const index = Buffer.concat([
    originalIndex,
    Buffer.from(
      `\n[[files]]\nfile = "config/example.toml"\nhash = "${digest("sha256", payload)}"\n`,
    ),
  ]);
  const originalPack = await reader.text("pack.toml");
  const pack = originalPack.replace(
    /hash = "[a-f0-9]{64}"/,
    `hash = "${digest("sha256", index)}"`,
  );
  const makeReader = (ordinary: Buffer) => ({
    async text(name: string) {
      if (name === "pack.toml") return pack;
      return reader.text(name);
    },
    async bytes(name: string) {
      if (name === "index.toml") return index;
      if (name === "config/example.toml") return ordinary;
      return reader.bytes(name);
    },
  });
  const result = await convert({
    source,
    reader: makeReader(payload),
    dryRun: true,
  });
  assert.deepEqual(
    readZipEntry(result.zip, "install/config/example.toml"),
    payload,
  );
  assert.ok(
    result.manifest.files.some((file) => file.path === "config/example.toml"),
  );
  await assert.rejects(
    convert({
      source,
      reader: makeReader(Buffer.from("tampered")),
      dryRun: true,
    }),
    /хеш/i,
  );
});

test("packwiz converter rejects altered metafiles before parsing", async () => {
  const { reader, source } = localPack();
  const altered = {
    text: reader.text,
    async bytes(name: string) {
      const bytes = await reader.bytes(name);
      return name === "mods/sodium.pw.toml"
        ? Buffer.concat([bytes, Buffer.from("\n# altered")])
        : bytes;
    },
  };
  await assert.rejects(
    convert({ source, reader: altered, dryRun: true }),
    /хеш/i,
  );
});
