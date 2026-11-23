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

## Built on Obsy Launcher

Line Launcher was built on top of **Obsy Launcher** by obsy-official and has
since been fully adapted for Plus In Plus. The launcher you get is not Obsy with
a logo: the Rust backend, the game-engine integration, the provider contract,
the wardrobe, the installer flow and every screen were written or rewritten for
this product, and none of the upstream Rust modules survive in this tree.

What does survive is the set of **shadcn/ui primitives** that Obsy generated
into `src/components/ui/` and that this project inherited unchanged
(`button`, `input`, `select`, `slider`, `switch`, `tabs`, `progress`, `label`,
`popover`, `textarea`, `input-group`, and a locally modified `dialog`). Those
files are small, they are vendored from the shadcn/ui registry rather than
authored by Obsy, and they stay under MIT: the original copyright and
permission notice is preserved verbatim in `LICENSES/Obsy-MIT.txt`, and the
same text is shipped inside the installer. The Line license does not relicense
that code or withdraw permissions already granted by MIT. Nothing here implies
endorsement by the upstream project.

## Vendored shadcn stylesheet

`src/vendor/shadcn/tailwind.css` is the stylesheet from the `shadcn` npm
package version 4.13.0, preserved byte-for-byte. Its MIT license and copyright
notice are in `LICENSES/Shadcn-MIT.txt` and are included in desktop bundles.

## Icons

The default desktop app-mark artwork is adapted from Lucide's `Layers2` glyph.
Lucide's license is preserved in `LICENSES/Lucide-LICENSE.txt` (ISC for Lucide
icons, with the upstream Feather MIT notice included in that file). The editable
source is `branding/assets/app-icon.svg`; desktop PNG/ICO/ICNS assets are
generated from it with `npm run brand` (which invokes `tauri icon`). The app's
interface also uses tree-shaken Lucide React icons. Provider-supplied replacement
assets are the provider's responsibility.

## Fonts

The icon interface uses **Lucide React** (`lucide-react`), with SVG components tree-shaken into the frontend bundle. Lucide is ISC-licensed; its notice is preserved in `LICENSES/Lucide-LICENSE.txt` and included in desktop bundles.

The interface and the documentation renders use **Geist** (`@fontsource-variable/geist`
at runtime). The two TTFs in `scripts/fonts/` are the same font in a rasteriser-readable
format and are used only by `scripts/render-screens.mjs`. Geist is licensed under the SIL
Open Font License 1.1, preserved in `LICENSES/Geist-OFL.txt`.

The greeting's word is set in **Pacifico** (`@fontsource/pacifico` at runtime), the only
place a handwriting face is used. The TTF in `scripts/fonts/` is the same font converted
for the rasteriser and is used only by `scripts/render-screens.mjs`. Pacifico is licensed
under the SIL Open Font License 1.1, preserved in `LICENSES/Pacifico-OFL.txt`.

## Other dependencies

Third-party dependencies retain their respective licenses. This notice is
not a relicensing of those dependencies. Before distributing a release,
review and include the notices required by the dependencies actually shipped.
