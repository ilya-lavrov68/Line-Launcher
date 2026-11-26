# Custom navigation icon slots

The primary sidebar has a central registry in `src/components/ui/sidebar-icons.tsx`.
When custom artwork is supplied, add the files here and set that slot's
`customAsset` to its public URL. Until then, its current Lucide fallback remains
active. No sidebar code should import a navigation glyph directly from Lucide.

| Slot       | Expected asset |
| ---------- | -------------- |
| `servers`  | `servers.svg`  |
| `wardrobe` | `wardrobe.svg` |
| `account`  | `account.svg`  |
| `settings` | `settings.svg` |
| `about`    | `about.svg`    |
| `collapse` | `collapse.svg` |

## SVG contract

- SVG only; `viewBox="0 0 24 24"`, transparent background, centered artwork.
- Monochrome paths with alpha only. The launcher paints the mask using the
  surrounding `currentColor`, so selected and muted states remain theme-aware.
- No scripts, `<foreignObject>`, embedded raster data, external resources, or
  fonts. Keep the path self-contained and the shape legible at 24 px.
- Preserve the existing semantic names and accessible labels in `SideNav`; the
  SVG itself is decorative and is hidden from assistive technology.

Do not replace fallbacks with empty paths. Enable each custom asset only once
its file is present and visually reviewed in both collapsed and expanded rail
states.
