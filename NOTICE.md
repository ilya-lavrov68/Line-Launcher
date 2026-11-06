# Line Launcher — notices

Line Launcher is a source-available, ready-to-brand solution for game-server
providers, maintained by **Plus In Plus**. It is not distributed as a fully
open-source product. Original Line contributions are governed by `LICENSE`
(Line Launcher Provider License 1.0), not MIT.

## Required product credit

Builds containing Line Materials must retain the visible credit required by
`LICENSE`. At least one exact phrase is required; both are shown by default:

- Работает на Line Launcher | Plus In Plus
- Powered by Line Launcher | Plus In Plus

The credit belongs in the main launcher interface (footer or header) and is
also repeated in About. Configuration may select placement and language, but
may not remove, rewrite or hide either required name. See `LICENSE` for the
binding conditions and `docs/BRANDING.md` for configuration.

## Upstream Obsy Launcher

Line Launcher incorporates materials from **Obsy Launcher** by obsy-official.
Those upstream materials remain under MIT. The original copyright and
permission notice is preserved verbatim in `LICENSES/Obsy-MIT.txt`. The Line
license does not relicense upstream code or withdraw permissions already
granted by MIT. It does not imply endorsement by the upstream project.

## Icons

The default Line application mark uses the Lucide `Layers2` glyph. Lucide's
license is preserved in `LICENSES/Lucide-LICENSE.txt` (ISC for Lucide icons,
with the upstream Feather MIT notice included in that file). The editable
source is `branding/assets/app-icon.svg`; desktop PNG/ICO/ICNS assets are
generated from it with `npm run brand` (which invokes `tauri icon`).
Provider-supplied replacement assets are the provider's responsibility.

## Other dependencies

Third-party dependencies retain their respective licenses. This notice is
not a relicensing of those dependencies. Before distributing a release,
review and include the notices required by the dependencies actually shipped.
