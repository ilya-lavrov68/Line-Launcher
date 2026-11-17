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
2. **Connector-generated files:** the Minecraft launch path can now prove a
   direct nested JARs against the current scanned release index, the live parent
   mod's SHA-256 and its declared Fabric `jars` entry, comparing complete bytes.
   Connector naming has a fast path; a bounded generic search can also prove an
   unchanged declared JAR under its original basename elsewhere in mods. Unknown, modified, ambiguous,
   recursively nested or transformed output remains blocked, not trusted or
   deleted. This covers only top-level lowercase `.jar` parent names and bounded
   files; generic searches have a finite read budget and may block an otherwise
   valid file in large packs when the budget is exhausted. They can add disk IO;
   performance is unmeasured. The general consent-based quarantine UX for
   artifacts whose provenance cannot be proved is not implemented; resource-pack-only checks and the non-Minecraft launch path remain
   strict. The ZIP-based Rust integration tests, Windows reparse/race behaviour
   and actual Connector versions still require full Cargo and real-instance
   validation. Locks coordinate cooperating processes only; external mutation
   after the scan is not prevented. Do not declare the false positive solved for
   all Connector artifacts.
3. **Prism ZIP without Mojang profiles:** metadata inspection exists but cannot
   build and repair the required instance. A read-only requirements pass now
   retains exact Minecraft, loader and LWJGL pins and rejects unsupported,
   unpinned or ambiguous components, custom patches and conflicting hints. For
   archives with a profile, LWJGL Maven coordinates must match the Prism pin;
   this verifies identity, not jar hashes or platform rules. Component repair
   must respect all exact versions;
   discover and validate pre-existing live components without reinstalling them;
   and prompt before downloading only the actual missing components.
4. **Consent:** the ZIP confirmation currently follows archive download, is
   coarse and can recur. For ZIP `mc_play`, launcher-owned Java downloads from
   Adoptium or Mojang now have a separate revision-, version-, source-, purpose-
   and operation-bound confirmation after local/cache discovery. This covers
   `resolve_java` during launch and the explicit legacy NeoForge installer, not
   independent calls, source installs or unverified dependency/third-party code.
   A ZIP may already have downloaded and approved component downloads may have
   occurred before the Java prompt. Do not claim refusal prevents every download
   until the pinned launcher-core and loader paths, full Cargo and Windows have
   been tested. The exact ZIP file-level plan remains unfinished.
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
- **ZIP runtime inventory:** when the scanned release contains version JSON,
  Minecraft preparation hashes live client and unruled library artifacts with
  explicit SHA-1 and size from that JSON; missing or modified files trigger the
  existing ZIP confirmation even if a library directory already exists. The
  dialog reports the lower-bound count/size and skipped entries. Rules, native
  classifiers, metadata without hashes, absent profiles and assets without a
  usable index are not covered. This is installation integrity, not keyword
  scanning; SHA-1 and provider-supplied metadata do not authenticate a hostile
  provider. The summary binds counts rather than an exact file list. The
  installer can do more than the inventory; repeats, traffic, large-pack timing
  and full Cargo/Windows behaviour have not been measured or validated.
- **Repeat performance:** source files with matching provider hash and size can
  be reused, but there are still repeated full scans and no independently
  validated loader receipt. Measure actual network, disk and wall time before
  merging scans or skipping verification.
- **Java and loaders:** newer explicitly chosen Java can satisfy Minecraft's
  minimum, but mod requirements are not fully inspected and the whole pack may
  still be incompatible. Test Vanilla, Fabric, Quilt, Forge, NeoForge 1.20.1
  and current NeoForge on Windows; verify loader and Java reuse.
- **Scan scope:** live mod checks compare missing/extra JARs (not keywords),
  while resource-pack keyword checks cover ZIPs and unpacked directories; other
  ordinary mod-directory data is ignored. A symlink/reparse point can still
  stop the scan. Archive and folder Rust tests need full Cargo and Windows; the
  separate installed-release integrity check still covers all published files.
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
