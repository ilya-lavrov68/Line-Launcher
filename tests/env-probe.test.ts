import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findMsvc,
  findWebView2,
  parseWebView2Version,
  WEBVIEW2_CLIENT_KEY,
  probe,
  programFilesRoots,
  tryLink,
} from "../scripts/lib/env-probe.mjs";

const win = process.platform === "win32";

test("probe runs an absolute path containing spaces", () => {
  // Regression: `shell: true` split "C:\Program Files (x86)\...\vswhere.exe"
  // at the space, so the MSVC check always reported "not installed".
  const dir = mkdtempSync(path.join(tmpdir(), "line probe test-"));
  try {
    const spaced = path.join(dir, "Program Files (x86)", "Installer");
    mkdirSync(spaced, { recursive: true });
    const tool = path.join(spaced, win ? "tool.cmd" : "tool");
    writeFileSync(
      tool,
      win ? "@echo off\r\necho TOOL-RAN\r\n" : "#!/bin/sh\necho TOOL-RAN\n",
    );
    if (!win) chmodSync(tool, 0o755);
    const out = probe(tool, []);
    assert.equal(
      out,
      "TOOL-RAN",
      "a path with spaces must execute, not be split",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe passes arguments through without shell reinterpretation", () => {
  const out = probe(process.execPath, [
    "-e",
    "console.log(JSON.stringify(process.argv[1]))",
    "a b&c",
  ]);
  assert.equal(out, '"a b&c"');
});

test("probe returns null for a missing binary and for a non-zero exit", () => {
  assert.equal(probe("line-definitely-not-a-real-binary-xyz", []), null);
  assert.equal(probe(process.execPath, ["-e", "process.exit(3)"]), null);
});

test("programFilesRoots keeps the x86 root and de-duplicates", () => {
  const roots = programFilesRoots({
    "ProgramFiles(x86)": "D:\\Program Files (x86)",
    ProgramFiles: "D:\\Program Files",
    ProgramW6432: "D:\\Program Files",
  });
  assert.deepEqual(roots, ["D:\\Program Files (x86)", "D:\\Program Files"]);
});

test("findMsvc trusts vswhere output reached through a spaced path", () => {
  // Fake vswhere echoes the installation path, mimicking a real Build Tools box.
  const dir = mkdtempSync(path.join(tmpdir(), "line vswhere-"));
  try {
    const installer = path.join(
      dir,
      "Program Files (x86)",
      "Microsoft Visual Studio",
      "Installer",
    );
    mkdirSync(installer, { recursive: true });
    const exe = path.join(installer, "vswhere.exe");
    writeFileSync(
      exe,
      process.platform === "win32"
        ? "@echo off\r\necho C:\\BuildTools\r\n"
        : "#!/bin/sh\necho 'C:\\BuildTools'\n",
    );
    if (!win) chmodSync(exe, 0o755);
    const env = { "ProgramFiles(x86)": path.join(dir, "Program Files (x86)") };
    // Inject a runner so the assertion is about argument passing, not the host OS.
    const run = (cmd: string, args: string[]) => {
      assert.ok(
        args.includes("-requires"),
        "vswhere must be queried for the C++ component",
      );
      return probe(cmd, []);
    };
    const found = findMsvc(env, run);
    assert.equal(found?.path, "C:\\BuildTools");
    assert.equal(found?.via, "vswhere");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMsvc falls back to cl.exe on disk when vswhere is unavailable", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line cl-"));
  try {
    const edition = path.join(
      dir,
      "Program Files",
      "Microsoft Visual Studio",
      "2022",
      "BuildTools",
    );
    const bin = path.join(
      edition,
      "VC",
      "Tools",
      "MSVC",
      "14.40.33807",
      "bin",
      "Hostx64",
      "x64",
    );
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "cl.exe"), "");
    const found = findMsvc(
      {
        ProgramFiles: path.join(dir, "Program Files"),
        "ProgramFiles(x86)": dir,
        ProgramW6432: path.join(dir, "Program Files"),
      },
      () => null,
    );
    assert.equal(found?.path, edition);
    assert.equal(found?.via, "cl.exe");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findMsvc reports null when no toolchain exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line empty-"));
  try {
    assert.equal(
      findMsvc(
        { ProgramFiles: dir, "ProgramFiles(x86)": dir, ProgramW6432: dir },
        () => null,
      ),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWebView2 finds the Evergreen versioned layout per user", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line webview-"));
  try {
    const app = path.join(dir, "Microsoft", "EdgeWebView", "Application");
    // Real installs put the exe under a version directory, not directly in
    // Application/ — the old probe checked the flat path and always missed.
    const versioned = path.join(app, "147.0.3912.98");
    mkdirSync(versioned, { recursive: true });
    const exe = path.join(versioned, "msedgewebview2.exe");
    writeFileSync(exe, "");
    const empty = path.join(dir, "empty");
    mkdirSync(empty);
    const roots = {
      ProgramFiles: empty,
      "ProgramFiles(x86)": empty,
      ProgramW6432: empty,
    };
    const found = findWebView2({ ...roots, LOCALAPPDATA: dir }, () => null);
    assert.deepEqual(found, {
      version: "147.0.3912.98",
      path: exe,
      via: "files",
    });
    assert.equal(
      findWebView2(roots, () => null),
      null,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWebView2 picks the newest version directory, not the first", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line webview-multi-"));
  try {
    const app = path.join(dir, "Microsoft", "EdgeWebView", "Application");
    // Deliberately not in numeric order: 99 < 147 numerically but sorts first
    // lexically, so a plain string sort would pick the wrong runtime.
    for (const version of ["99.0.1150.30", "147.0.3912.98", "120.0.2210.91"]) {
      mkdirSync(path.join(app, version), { recursive: true });
      writeFileSync(path.join(app, version, "msedgewebview2.exe"), "");
    }
    const found = findWebView2({ LOCALAPPDATA: dir }, () => null);
    assert.equal(found?.version, "147.0.3912.98");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWebView2 still accepts a flat layout", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line webview-flat-"));
  try {
    const app = path.join(dir, "Microsoft", "EdgeWebView", "Application");
    mkdirSync(app, { recursive: true });
    const exe = path.join(app, "msedgewebview2.exe");
    writeFileSync(exe, "");
    const found = findWebView2({ LOCALAPPDATA: dir }, () => null);
    assert.equal(found?.path, exe);
    assert.equal(found?.via, "files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findWebView2 trusts the registry pv value without touching the disk", () => {
  const asked: string[] = [];
  const found = findWebView2({}, (cmd, args) => {
    assert.equal(cmd, "reg");
    asked.push(args[1]);
    // Only the per-user hive has a runtime on this machine.
    return args[1].startsWith("HKCU")
      ? "    pv    REG_SZ    147.0.3912.98\r\n"
      : null;
  });
  assert.deepEqual(found, {
    version: "147.0.3912.98",
    path: null,
    via: "registry",
  });
  // Both documented hives plus the 32-bit machine view must be consulted.
  assert.ok(asked.some((k) => k.includes("WOW6432Node")));
  assert.ok(asked.some((k) => k.startsWith("HKCU")));
  assert.ok(asked.every((k) => k.includes(WEBVIEW2_CLIENT_KEY)));
});

test("a registry key with pv = 0.0.0.0 does not count as installed", () => {
  // Microsoft documents this exact state: the key exists, no runtime does.
  const found = findWebView2({}, () => "    pv    REG_SZ    0.0.0.0\r\n");
  assert.equal(found, null);
});

test("parseWebView2Version handles real reg output and rejects non-installs", () => {
  assert.equal(
    parseWebView2Version(
      "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}\r\n    pv    REG_SZ    147.0.3912.98\r\n",
    ),
    "147.0.3912.98",
  );
  for (const output of [
    null,
    "",
    "ERROR: The system was unable to find the specified registry key or value.",
    "    pv    REG_SZ    0.0.0.0",
    "    pv    REG_SZ    ",
    "    name    REG_SZ    Microsoft Edge WebView2 Runtime",
  ]) {
    assert.equal(parseWebView2Version(output), null, `accepted ${output}`);
  }
});

test("tryLink reports a useful failure when no compiler is on PATH", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "line no-rustc-"));
  const saved = process.env.PATH;
  try {
    process.env.PATH = dir;
    const r = tryLink();
    assert.equal(r.ok, false);
    assert.ok(
      r.detail.length > 0,
      "the linker error must be surfaced, not swallowed",
    );
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

// A POSIX shell shim stands in for rustc; on Windows the real binary is an .exe
// and this path is covered by the developer's own machine instead.
test(
  "tryLink succeeds when the compiler produces an executable",
  { skip: win },
  () => {
    const dir = mkdtempSync(path.join(tmpdir(), "line fake-rustc-"));
    const saved = process.env.PATH;
    try {
      const shim = path.join(dir, "rustc");
      // Echo the -o target back as a created file, like a successful link would.
      writeFileSync(
        shim,
        '#!/bin/sh\nwhile [ $# -gt 0 ]; do\n  if [ "$1" = "-o" ]; then shift; echo x > "$1"; fi\n  shift\ndone\nexit 0\n',
      );
      chmodSync(shim, 0o755);
      process.env.PATH = dir;
      const r = tryLink();
      assert.equal(r.ok, true);
    } finally {
      process.env.PATH = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
