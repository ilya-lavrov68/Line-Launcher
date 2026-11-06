// Environment probing helpers, kept separate from doctor.mjs so they can be
// unit-tested. Windows paths contain spaces ("Program Files (x86)"), which a
// shell invocation silently breaks — see probe() below.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const isWin = process.platform === "win32";

/**
 * Run a command and return combined stdout+stderr, or null on failure.
 *
 * Must NOT use `shell: true` for absolute paths: Node joins the command and
 * arguments into one string, so `C:\Program Files (x86)\...\vswhere.exe`
 * becomes `C:\Program` plus arguments and the call fails with a bogus
 * "not found". Direct spawn passes the path as a single argv entry.
 */
export function probe(cmd, args = [], opts = {}) {
  const base = {
    encoding: "utf8",
    windowsHide: true,
    timeout: 20_000,
    ...opts,
  };
  let r = spawnSync(cmd, args, { ...base, shell: false });
  // .cmd/.bat shims cannot be spawned directly on Windows: Node >=18.20.2
  // throws EINVAL (older versions ENOENT). Retry via shell with every argv
  // entry quoted so spaces survive.
  if (isWin && ["ENOENT", "EINVAL"].includes(r.error?.code)) {
    const line = [cmd, ...args]
      .map((a) => (/[\s"]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a))
      .join(" ");
    r = spawnSync(line, { ...base, shell: true });
  }
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || ""}${r.stderr || ""}`.trim();
}

function subdirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export function programFilesRoots(env = process.env) {
  return [
    env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    env.ProgramFiles || "C:\\Program Files",
    env.ProgramW6432 || "C:\\Program Files",
  ].filter((v, i, a) => a.indexOf(v) === i);
}

export function vsWherePath(env = process.env) {
  const p = path.join(
    env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Microsoft Visual Studio/Installer/vswhere.exe",
  );
  return existsSync(p) ? p : null;
}

/**
 * Locate an MSVC C++ toolchain. Returns { path, via } or null.
 *
 * vswhere is asked twice: Build Tools installs report the VC.Tools component,
 * but some layouts only report the VCTools workload. If vswhere is missing or
 * inconclusive, fall back to looking for cl.exe on disk.
 */
export function findMsvc(env = process.env, run = probe) {
  const vswhere = vsWherePath(env);
  if (vswhere) {
    for (const requires of [
      "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
      "Microsoft.VisualStudio.Workload.VCTools",
    ]) {
      const out = run(vswhere, [
        "-latest",
        "-products",
        "*",
        "-requires",
        requires,
        "-property",
        "installationPath",
      ]);
      const first = out?.split(/\r?\n/).find((l) => l.trim());
      if (first) return { path: first.trim(), via: "vswhere" };
    }
    // No -requires: an install exists but the C++ component may be absent.
    // Fall through to the on-disk check rather than trusting this result.
  }

  for (const root of programFilesRoots(env)) {
    const vsRoot = path.join(root, "Microsoft Visual Studio");
    for (const version of subdirs(vsRoot)) {
      for (const edition of subdirs(path.join(vsRoot, version))) {
        const msvc = path.join(vsRoot, version, edition, "VC/Tools/MSVC");
        for (const toolset of subdirs(msvc)) {
          for (const host of ["Hostx64/x64", "Hostx86/x86"]) {
            const cl = path.join(msvc, toolset, "bin", host, "cl.exe");
            if (existsSync(cl)) {
              return {
                path: path.join(vsRoot, version, edition),
                via: "cl.exe",
              };
            }
          }
        }
      }
    }
  }
  return null;
}

/** WebView2 Runtime client GUID used by EdgeUpdate. */
export const WEBVIEW2_CLIENT_KEY =
  "Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

/**
 * `reg query` prints `    pv    REG_SZ    147.0.3912.98`.
 * A key can exist with pv = 0.0.0.0 (or empty) while no runtime is installed,
 * so the value must be present and non-zero to count.
 */
export function parseWebView2Version(output) {
  if (!output) return null;
  const match = /^\s*pv\s+REG_SZ\s+(\S+)\s*$/im.exec(output);
  const version = match?.[1];
  if (!version || /^0+(\.0+)*$/.test(version)) return null;
  return version;
}

/** Newest dotted numeric version first; non-numeric names sort last. */
function compareVersionDirs(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (Number.isNaN(na) !== Number.isNaN(nb)) return Number.isNaN(na) ? 1 : -1;
    if (na !== nb) return nb - na;
  }
  return 0;
}

/**
 * WebView2 ships machine-wide or per-user; both are valid.
 *
 * The registry `pv` value is Microsoft's documented detection rule and is
 * authoritative. The on-disk fallback must account for the Evergreen layout,
 * where the executable lives in a *versioned* subdirectory:
 *   ...\\Microsoft\\EdgeWebView\\Application\\<version>\\msedgewebview2.exe
 * Checking `Application/msedgewebview2.exe` (no version) never matches a real
 * install and made doctor report "not found" on machines that had it.
 */
export function findWebView2(env = process.env, run = probe) {
  for (const hive of [
    `HKLM\\SOFTWARE\\WOW6432Node\\${WEBVIEW2_CLIENT_KEY}`,
    `HKCU\\Software\\${WEBVIEW2_CLIENT_KEY}`,
    `HKLM\\SOFTWARE\\${WEBVIEW2_CLIENT_KEY}`,
  ]) {
    const version = parseWebView2Version(
      run("reg", ["query", hive, "/v", "pv"]),
    );
    if (version) return { version, path: null, via: "registry" };
  }

  const roots = programFilesRoots(env).map((p) =>
    path.join(p, "Microsoft/EdgeWebView/Application"),
  );
  if (env.LOCALAPPDATA) {
    roots.push(
      path.join(env.LOCALAPPDATA, "Microsoft/EdgeWebView/Application"),
    );
  }
  for (const app of roots) {
    // Fixed-version/manual layouts may keep it flat; support both.
    const flat = path.join(app, "msedgewebview2.exe");
    if (existsSync(flat)) return { version: null, path: flat, via: "files" };
    const versions = subdirs(app).sort(compareVersionDirs);
    for (const version of versions) {
      const exe = path.join(app, version, "msedgewebview2.exe");
      if (existsSync(exe)) return { version, path: exe, via: "files" };
    }
  }
  return null;
}

/**
 * Definitive Windows toolchain test: ask rustc to actually link a trivial
 * executable. Heuristics (vswhere, cl.exe on disk) can miss a valid install on a
 * non-default drive, so a successful link always wins over "not found".
 * Returns { ok, detail }.
 */
export function tryLink() {
  const dir = mkdtempSync(path.join(tmpdir(), "line-link-"));
  try {
    const src = path.join(dir, "probe.rs");
    const out = path.join(dir, isWin ? "probe.exe" : "probe");
    writeFileSync(src, "fn main() {}\n");
    const result = spawnSync(
      "rustc",
      ["--edition", "2021", "-C", "debuginfo=0", "-o", out, src],
      { encoding: "utf8", windowsHide: true, timeout: 120_000, shell: false },
    );
    if (!result.error && result.status === 0 && existsSync(out)) {
      return { ok: true, detail: "линковка проверена компилятором" };
    }
    const stderr = `${result.stderr || ""}${result.error?.message || ""}`;
    return {
      ok: false,
      detail: stderr.trim().split(/\r?\n/).slice(0, 6).join("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
