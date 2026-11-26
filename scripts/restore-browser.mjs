// Ensure a compatible Chromium is available before any screenshot/GIF capture.
//
// Resolution order:
//   1. CHROMIUM_PATH / installed Chrome, Edge or Chromium
//   2. Playwright's pinned browser cache
//   3. Install Playwright Chromium
//   4. On Linux x64 only, fetch a matching Chromium build from npm (useful in
//      restricted sandboxes where Playwright's browser CDN is unreachable).
//
// `npm run screenshots` invokes this file in --capture mode, so capture cannot
// silently fall back to stale images when the browser is missing.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findBrowser } from "./lib/find-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const capture = process.argv[2] === "--capture";
const forwardedArgs = capture ? process.argv.slice(3) : [];
const timeout = 20 * 60 * 1000;

function command(file, args, env = process.env, options = {}) {
  return spawnSync(file, args, {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: options.timeout ?? 20_000,
    stdio: options.stdio ?? "pipe",
    maxBuffer: 8 * 1024 * 1024,
  });
}

function executableVersion(file, env = process.env) {
  if (!file || !existsSync(file)) return undefined;
  const result = command(file, ["--version"], env);
  if (result.error || result.status !== 0) return undefined;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(
    /(?:Chromium|Chrome|HeadlessChrome|Microsoft Edge)[^\d]*(\d+\.\d+(?:\.\d+)?)/i,
  )?.[1];
}

function playwrightChromium() {
  return import("playwright-core").then(({ chromium }) => chromium);
}

function printReady(file, version, source) {
  console.log(`[browser] Chromium ready: ${file} (${version}; ${source})`);
}

function installPlaywrightChromium() {
  const cli = path.join(root, "node_modules", "playwright-core", "cli.js");
  if (!existsSync(cli))
    throw new Error("playwright-core is not installed; run npm ci first.");
  console.log(
    "[browser] No usable browser found; restoring Playwright Chromium…",
  );
  const result = command(
    process.execPath,
    [cli, "install", "chromium"],
    process.env,
    {
      timeout,
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `Playwright browser installer exited with ${result.status}.`,
    );
}

function playwrightExpectedMajor(browsersFile) {
  const manifest = JSON.parse(readFileSync(browsersFile, "utf8"));
  const version = manifest.browsers.find(
    (entry) => entry.name === "chromium",
  )?.browserVersion;
  const major = Number.parseInt(String(version).split(".")[0], 10);
  if (!Number.isInteger(major))
    throw new Error("Could not read Playwright's pinned Chromium version.");
  return major;
}

function npmChromiumCache(major) {
  if (process.platform !== "linux" || process.arch !== "x64") return undefined;
  const cacheBase =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  const cacheRoot = path.join(cacheBase, "line-launcher", "browser-fallback");
  const packageJson = path.join(
    cacheRoot,
    "node_modules",
    "@sparticuz",
    "chromium",
    "package.json",
  );
  const binaryArchive = path.join(
    cacheRoot,
    "node_modules",
    "@sparticuz",
    "chromium",
    "bin",
    "chromium.br",
  );
  const installedMajor = existsSync(packageJson)
    ? Number.parseInt(
        JSON.parse(readFileSync(packageJson, "utf8")).version.split(".")[0],
        10,
      )
    : undefined;
  return installedMajor === major && existsSync(binaryArchive)
    ? { cacheRoot, packageJson }
    : { cacheRoot, packageJson: undefined };
}

async function loadNpmChromium(major) {
  const cached = npmChromiumCache(major);
  if (!cached?.packageJson) return undefined;

  const packageDir = path.dirname(cached.packageJson);
  const packageModule = await import(
    pathToFileURL(path.join(packageDir, "build", "index.js")).href
  );
  const binary = await packageModule.default.executablePath();
  // The npm build is packaged for Linux serverless environments. Extract its
  // matching NSS libraries and pass them only to this capture process.
  const { inflate } = await import(
    pathToFileURL(path.join(packageDir, "build", "lambdafs.js")).href
  );
  const libraries = await inflate(
    path.join(packageDir, "bin", "al2023.tar.br"),
  );
  const env = {
    ...process.env,
    CHROMIUM_PATH: binary,
    LD_LIBRARY_PATH: [libraries + "/lib", process.env.LD_LIBRARY_PATH]
      .filter(Boolean)
      .join(path.delimiter),
  };
  const version = executableVersion(binary, env);
  if (!version || Number.parseInt(version.split(".")[0], 10) !== major) {
    throw new Error(
      `Registry Chromium did not start with the expected major ${major}.`,
    );
  }
  return {
    path: binary,
    version,
    source: `npm registry fallback ${major}`,
    env,
  };
}

async function installNpmChromium(major) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new Error(
      "The npm-registry Chromium fallback is available only on Linux x64.",
    );
  }
  const cached = npmChromiumCache(major);
  if (!cached.packageJson) {
    mkdirSync(cached.cacheRoot, { recursive: true });
    console.log(
      `[browser] Playwright CDN unavailable; restoring Chromium ${major} from npm registry…`,
    );
    const result = command(
      "npm",
      [
        "install",
        "--prefix",
        cached.cacheRoot,
        "--no-save",
        "--no-package-lock",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        `@sparticuz/chromium@${major}`,
      ],
      process.env,
      { timeout, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0)
      throw new Error(`npm Chromium restore exited with ${result.status}.`);
  }
  const restored = await loadNpmChromium(major);
  if (!restored)
    throw new Error(
      "The npm Chromium package did not contain its browser binary.",
    );
  return restored;
}

async function restore() {
  const playwright = await playwrightChromium();
  const browserManifest = path.join(
    root,
    "node_modules",
    "playwright-core",
    "browsers.json",
  );
  const expectedMajor = playwrightExpectedMajor(browserManifest);
  const candidates = [];

  if (process.env.CHROMIUM_PATH)
    candidates.push({
      path: process.env.CHROMIUM_PATH,
      source: "CHROMIUM_PATH",
    });
  const system = findBrowser({ ...process.env, CHROMIUM_PATH: "" });
  if (system) candidates.push({ path: system.path, source: system.via });
  candidates.push({
    path: playwright.executablePath(),
    source: "Playwright cache",
  });

  const tried = new Set();
  for (const candidate of candidates) {
    if (tried.has(candidate.path)) continue;
    tried.add(candidate.path);
    const version = executableVersion(candidate.path);
    if (version)
      return {
        ...candidate,
        version,
        env: { ...process.env, CHROMIUM_PATH: candidate.path },
      };
    if (candidate.path)
      console.warn(`[browser] Ignoring unusable browser at ${candidate.path}`);
  }

  const cachedNpmBrowser = await loadNpmChromium(expectedMajor);
  if (cachedNpmBrowser) return cachedNpmBrowser;

  let playwrightError;
  try {
    installPlaywrightChromium();
    const file = playwright.executablePath();
    const version = executableVersion(file);
    if (version)
      return {
        path: file,
        version,
        source: "Playwright installer",
        env: { ...process.env, CHROMIUM_PATH: file },
      };
    playwrightError = new Error(
      "Playwright installation finished, but its browser executable did not start.",
    );
  } catch (error) {
    playwrightError = error;
    console.warn(`[browser] Playwright restore failed: ${error.message}`);
  }

  try {
    return await installNpmChromium(expectedMajor);
  } catch (error) {
    throw new Error(
      `Could not restore Chromium. Playwright: ${playwrightError?.message ?? "unknown failure"}. ` +
        `npm fallback: ${error.message}`,
    );
  }
}

try {
  const browser = await restore();
  printReady(browser.path, browser.version, browser.source);

  if (capture) {
    const result = command(
      process.execPath,
      [path.join(root, "scripts", "screenshots.mjs"), ...forwardedArgs],
      browser.env,
      {
        timeout,
        stdio: "inherit",
      },
    );
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
} catch (error) {
  console.error(`[browser] ${error.message}`);
  console.error(
    "Install project dependencies with npm ci, then rerun npm run browser:restore.",
  );
  process.exitCode = 2;
}
