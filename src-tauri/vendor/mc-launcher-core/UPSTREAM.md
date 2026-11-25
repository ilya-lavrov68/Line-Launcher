# Vendored `mc-launcher-core`

This is the MIT-licensed `mc-launcher-core` 0.1.2 source vendored from
[`Star-tears/mc-launcher-core`](https://github.com/Star-tears/mc-launcher-core),
upstream commit `838daff3e04cfd04b77796f61a6d7d68a36b8aa6` (package version
0.1.2). The upstream `LICENSE` and `README.md` are retained. The vendored copy
contains the upstream `src/`, package manifest, and those attribution files.

Local changes are deliberately limited to:

- retrying transient download/metadata failures and falling back from NeoForge's
  exact HTTPS release host to `https://maven.creeperhost.net`;
- writing downloads to a temporary file and promoting only completed, checksum-
  verified files;
- passing NeoForge's documented `--mirror https://maven.creeperhost.net`
  installer option (Forge behavior is unchanged).

The fallback host is referenced by the NeoForged website itself when its Maven
is temporarily unavailable:
[`assets/js/neoforge.js`](https://github.com/neoforged/websites/blob/main/assets/js/neoforge.js).
When updating this vendored crate, re-check that upstream recommendation and
reapply the focused changes above.
