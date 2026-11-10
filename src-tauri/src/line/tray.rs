//! Notification-area icon.
//!
//! "Скрыть в трей" is only honest if there is a tray to hide into: hiding a
//! window with no icon is just a closed window that still eats memory. The tray
//! is therefore created once at startup, always, and does two things:
//!
//!  * left click / «Открыть» shows and focuses the window — the way back for a
//!    player who hid the launcher to give the game the whole screen;
//!  * «Выход» closes it for real, because the window's own close button may be
//!    the thing that hid it in the first place.
//!
//! Nothing here is a second copy of app state: the menu only calls window
//! methods, so a tray click can never desync the React tree from the backend.

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

/// Shows and focuses the main window. Shared by the tray menu and the icon's
/// left click, so both paths behave identically.
fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Builds the tray icon. Failure is not fatal: a machine with no notification
/// area (some kiosk and server setups) must still run the launcher, and the
/// "скрыть в трей" setting simply degrades to a minimised window from the
/// player's point of view. An install that could not create the icon would
/// otherwise refuse to start at all.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Открыть лаунчер", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;

    let mut builder = TrayIconBuilder::with_id("line-tray")
        .tooltip("Line Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            // Left click toggles back into the window; double click is handled
            // by the same branch so two fast clicks do not do nothing.
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });

    // The window icon is already decoded for the taskbar, so reusing it keeps
    // one source of truth for branding (`icons/` is generated from the brand
    // preset, see docs/BRANDING.md).
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
