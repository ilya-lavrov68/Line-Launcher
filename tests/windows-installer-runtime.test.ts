import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("Windows installer embeds the offline WebView2 installer", () => {
  const config = JSON.parse(read("src-tauri/tauri.conf.json"));
  assert.equal(config.bundle.windows.webviewInstallMode.type, "offlineInstaller");
  assert.equal(config.bundle.windows.webviewInstallMode.silent, true);
  assert.equal(config.build.frontendDist, "../dist");
  const msi = JSON.parse(read("src-tauri/tauri.msi.conf.json"));
  assert.equal(msi.bundle.windows, undefined, "MSI overlay must not replace the WebView policy");
});

test("legacy NeoForge uses a no-console process and preserves output in a log", () => {
  const rust = read("src-tauri/src/line/minecraft.rs");
  const runner = rust.slice(rust.indexOf("fn loader_installer_command("), rust.indexOf("async fn install_legacy_neoforge("));
  assert.match(runner, /creation_flags\(0x0800_0000\)/);
  assert.match(runner, /\.arg\("-jar"\)/);
  assert.match(runner, /\.arg\("--installClient"\)/);
  assert.match(runner, /\.stdout\(Stdio::from\(log\)\)/);
  assert.match(runner, /\.stderr\(Stdio::from\(stderr\)\)/);
  assert.match(runner, /line-loader-install\.log/);
  assert.doesNotMatch(runner, /cmd\.exe|powershell|sh -c/);
  const legacy = rust.slice(rust.indexOf("async fn install_legacy_neoforge("), rust.indexOf("async fn install_profile("));
  assert.match(legacy, /run_quiet_loader_installer\(&java, &installer, &dir\)/);
  assert.doesNotMatch(legacy, /run_loader_installer\(/);
});
