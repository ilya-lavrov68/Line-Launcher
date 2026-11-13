// Locate an openssl binary, including the one Git for Windows already ships.
//
// `spawnSync("openssl")` fails with ENOENT on a default Windows box even though
// Git installed a working openssl at <Git>\usr\bin\openssl.exe. Requiring a
// separate OpenSSL install just to run the reference provider is unnecessary.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const isWin = process.platform === "win32";

function runs(cmd) {
  const r = spawnSync(cmd, ["version"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    shell: false,
  });
  return !r.error && r.status === 0 ? `${r.stdout || ""}`.trim() : null;
}

/** Directories where Git for Windows may be installed. */
function gitRoots(env) {
  const roots = [];
  // Ask git itself first: handles custom drives and per-user installs.
  const where = spawnSync(isWin ? "where.exe" : "which", ["git"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
    shell: false,
  });
  if (!where.error && where.status === 0) {
    for (const line of `${where.stdout || ""}`.split(/\r?\n/)) {
      const hit = line.trim();
      if (!hit) continue;
      // ...\Git\cmd\git.exe or ...\Git\mingw64\bin\git.exe -> ...\Git
      let dir = path.dirname(hit);
      for (let i = 0; i < 3; i += 1) {
        if (/git$/i.test(path.basename(dir))) {
          roots.push(dir);
          break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
  }
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  roots.push(path.join(pf, "Git"));
  roots.push(path.join(pf86, "Git"));
  if (env.LOCALAPPDATA) {
    roots.push(path.join(env.LOCALAPPDATA, "Programs", "Git"));
  }
  return [...new Set(roots)];
}

/**
 * @returns {{ path: string, version: string, via: string } | null}
 */
export function findOpenSsl(
  env = process.env,
  { run = runs, locateGit = gitRoots } = {},
) {
  // Explicit override wins.
  for (const key of ["LINE_OPENSSL", "OPENSSL"]) {
    const value = env[key];
    if (value && existsSync(value)) {
      const version = run(value);
      if (version) return { path: value, version, via: key };
    }
  }

  const onPath = run("openssl");
  if (onPath) return { path: "openssl", version: onPath, via: "PATH" };

  if (!isWin) return null;

  const candidates = [];
  for (const root of locateGit(env)) {
    candidates.push({
      file: path.join(root, "usr", "bin", "openssl.exe"),
      via: "Git for Windows",
    });
    candidates.push({
      file: path.join(root, "mingw64", "bin", "openssl.exe"),
      via: "Git for Windows",
    });
  }
  const pf = env.ProgramFiles || "C:\\Program Files";
  const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  candidates.push(
    {
      file: path.join(pf, "OpenSSL-Win64", "bin", "openssl.exe"),
      via: "OpenSSL-Win64",
    },
    {
      file: path.join(pf86, "OpenSSL-Win32", "bin", "openssl.exe"),
      via: "OpenSSL-Win32",
    },
    { file: "C:\\Strawberry\\c\\bin\\openssl.exe", via: "Strawberry Perl" },
    { file: "C:\\msys64\\usr\\bin\\openssl.exe", via: "MSYS2" },
    {
      file: path.join(
        env.ProgramData || "C:\\ProgramData",
        "chocolatey",
        "bin",
        "openssl.exe",
      ),
      via: "Chocolatey",
    },
  );

  for (const { file, via } of candidates) {
    if (!existsSync(file)) continue;
    const version = run(file);
    if (version) return { path: file, version, via };
  }
  return null;
}

/** Actionable, platform-specific instructions when nothing was found. */
export function openSslHelp() {
  if (isWin) {
    return [
      "openssl нужен только для самоподписанного сертификата демо-провайдера.",
      "Обычно он уже есть вместе с Git for Windows — проверьте:",
      '  & "$env:ProgramFiles\\Git\\usr\\bin\\openssl.exe" version',
      "Если файла нет, любой из вариантов:",
      "  winget install --id ShiningLight.OpenSSL.Light",
      "  choco install openssl",
      "Либо укажите путь явно:",
      '  $env:LINE_OPENSSL="C:\\Program Files\\Git\\usr\\bin\\openssl.exe"',
    ].join("\n");
  }
  return [
    "openssl нужен только для самоподписанного сертификата демо-провайдера.",
    "  Debian/Ubuntu: sudo apt-get install openssl",
    "  macOS:         brew install openssl",
    "Либо укажите путь: LINE_OPENSSL=/path/to/openssl",
  ].join("\n");
}
