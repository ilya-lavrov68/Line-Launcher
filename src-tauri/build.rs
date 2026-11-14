fn main() {
    // The app icon is embedded into the executable by the Windows resource
    // compiler (and into the bundle by `tauri build`), so a stale executable is
    // a stale icon. `build.rs` used to track nothing of its own, and cargo only
    // re-runs a build script when one of its *tracked* inputs changes — a new
    // `icons/icon.ico` was therefore not a reason to relink. The visible result
    // was confusing but consistent: the header mark updated (it is a frontend
    // asset Vite serves), while the shortcut, the taskbar and the tray kept the
    // old icon, because the binary that carries them was never rebuilt.
    //
    // Naming the generated icons here closes that hole for both `tauri dev` and
    // `tauri build`: regenerating the set now forces a relink, which re-embeds
    // the icon and refreshes `default_window_icon` (the tray reuses it).
    //
    // Paths are relative to this crate's manifest directory (src-tauri/).
    for icon in [
        "icons/icon.ico",
        "icons/icon.icns",
        "icons/icon.png",
        "icons/32x32.png",
        "icons/128x128.png",
        "icons/128x128@2x.png",
        // Written by `npm run brand` with the source's SHA-256, so a rebuild is
        // triggered even if an icon file happens to be byte-identical.
        "icons/.brand-source.sha256",
    ] {
        println!("cargo:rerun-if-changed={icon}");
    }
    // The overlay carries the branded product name and icon list.
    println!("cargo:rerun-if-changed=tauri.brand.conf.json");

    // Vite writes hashed filenames, so watching only previously embedded files
    // is insufficient when an asset is added or renamed. The stamp hashes the
    // complete production tree and is written only after a successful Vite build.
    // Watching dist also covers direct builds and additions outside that script.
    println!("cargo:rerun-if-changed=../dist");
    println!("cargo:rerun-if-changed=.frontend-build.sha256");

    tauri_build::build()
}
