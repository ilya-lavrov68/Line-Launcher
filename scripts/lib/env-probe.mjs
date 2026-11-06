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
  // .cmd/.bat shims cannot be spawned directly on Windows; retry via shell with
  // every argv entry quoted so spaces survive.
  if (r.error?.code === "ENOENT" && isWin) {
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

/** WebView2 ships machine-wide or per-user; both are valid. */
export function findWebView2(env = process.env) {
  const candidates = programFilesRoots(env).map((p) =>
    path.join(p, "Microsoft/EdgeWebView/Application/msedgewebview2.exe"),
  );
  if (env.LOCALAPPDATA) {
    candidates.push(
      path.join(
        env.LOCALAPPDATA,
        "Microsoft/EdgeWebView/Application/msedgewebview2.exe",
      ),
    );
  }
  return candidates.find((p) => existsSync(p)) || null;
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
