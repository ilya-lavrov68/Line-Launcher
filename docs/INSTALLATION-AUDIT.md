# Installation audit: open risks and acceptance gates

This audit concerns the implementation in draft PR #71, not a release or proof
of Windows compatibility. `INSTALLATION-ROADMAP.md` contains the intended phases.

## Critical issues to resolve before release

1. **ZIP replacement at the same digest:** replacement now retains the old
   directory in a recoverable sibling until publication, and recovery runs under
   the server lock before installation, launch inspection, Minecraft sync and
   rollback. A complete new directory is scanned before discarding its backup;
   if verification fails both copies remain for diagnosis. Pure filesystem tests
   cover interruption states and rename failure, but not actual process kills,
   power loss, Windows reparse points or Windows rename durability. Directory
   fsync is unavailable in the current Windows implementation and staged file
   durability is not guaranteed; do not claim power-loss safety or Windows
   readiness without integration testing. The local index is not authentication.
2. **Connector-generated files:** `check_live_mods` treats generated executable
   JARs in `.connector` as foreign. Do not allow the entire directory or trust
   arbitrary files captured after a run. Implement verifiable provenance or
   carefully scoped safe regeneration, including tamper and reparse-point tests.
3. **Prism ZIP without Mojang profiles:** metadata inspection exists but cannot
   build and repair the required instance. Component plans must reject unknown,
   ambiguous and custom patches; respect exact Minecraft and loader versions;
   discover and validate pre-existing live components without reinstalling them;
   and prompt before downloading only the actual missing components.
4. **Consent:** the ZIP confirmation currently follows archive download, is
   coarse and can recur; Java installation has no independent confirmation.
   Add a revision-bound exact plan and separate Java decision before claiming
   that refusal prevents every supplementary download.
5. **CurseForge:** no API source implementation. Credentials, rate limiting,
   distribution rights and unavailable-file UX must be designed and tested;
   do not bypass provider restrictions or assume every file is downloadable.

## Further validation and design work

- **Source cancellation:** source install now runs in a supervisor, with caller
  cancellation signalling the worker and the worker owning the server lock until
  pending work drains. New Tokio tests are in the crate but require a full Cargo
  run; interruption, panic, timeout and Windows filesystem behaviour still need
  integration tests. Termination of the entire process is a different case.
- **Other cancellation paths:** audit all blocking tasks and launcher/game
  shutdown. The in-memory registration is released on caller drop while any
  surviving source worker retains the cross-process server lock; attempts during
  that interval must fail busy, not modify staging. Advisory instance locks do
  not cover external launchers or an orphaned game after a launcher crash.
- **Trust and hashes:** inventories are partial; a matching size is not a hash,
  a locally generated index does not authenticate a malicious provider, and
  SHA-1 supplied by Minecraft metadata is not a modern anti-cheat signature.
- **Repeat performance:** source files with matching provider hash and size can
  be reused, but there are still repeated full scans and no independently
  validated loader receipt. Measure actual network, disk and wall time before
  merging scans or skipping verification.
- **Java and loaders:** newer explicitly chosen Java can satisfy Minecraft's
  minimum, but mod requirements are not fully inspected and the whole pack may
  still be incompatible. Test Vanilla, Fabric, Quilt, Forge, NeoForge 1.20.1
  and current NeoForge on Windows; verify loader and Java reuse.
- **UX:** progress totals may be unknown and the speed limit does not govern
  all external installers. A failure or pending confirmation must not display a
  ready state. Verify navigation, duplicate-action prevention and widget layout.
- **Windows matrix:** fresh and repeat installs; unchanged/changed source;
  incomplete and intact Prism ZIP; declined and accepted repairs; missing,
  corrupt and extra files; interrupted downloads and process termination;
  concurrent processes; external Java; resource packs; Connector; worlds and
  settings preservation. Include poor network and trusted HTTPS. Record logs and
  measurements without secrets; do not require an unnecessary long re-download.

## Verification boundary

The pure Rust harness uses shims and cannot compile Tauri, Tokio, the published
`mc-launcher-core`, or the complete installation pipelines. Structural TS tests
check wiring, not real concurrent IO. A full locked Cargo test/Clippy, Windows
build, and real end-to-end tests remain required before completing this plan.
