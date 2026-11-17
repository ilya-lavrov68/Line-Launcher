//! The main window starts hidden and is revealed by the interface itself.
//!
//! Tauri creates the window before the WebView has loaded, drawn or mounted
//! anything, so a window that starts visible shows a white rectangle for as long
//! as the bundle takes to boot — on a cold start, most of what a player reads as
//! "the launcher is slow". `"visible": false` in `tauri.conf.json` plus one call
//! from the frontend, after the first frame has been committed, means the first
//! thing on screen is the launcher's own backdrop rather than the WebView's
//! default white.
//!
//! The command is intentionally idempotent and forgiving: if the frontend never
//! calls it (a startup error before React mounts), a watchdog in `run()` shows
//! the window anyway, because a hidden window with no interface is much worse
//! than a white flash.

use tauri::{AppHandle, Manager, WebviewWindow};

pub const MAIN_WINDOW: &str = "main";

/// Show and focus the main window. Called by the frontend once the first frame
/// is on screen; safe to call more than once.
#[tauri::command]
pub fn show_main_window(app: AppHandle) {
    reveal(&app);
}

fn reveal(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        show(&window);
    }
}

fn show(window: &WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

/// The safety net: if nothing has revealed the window within `delay`, do it
/// here. Kept out of `setup` so the counter starts when the event loop does,
/// not when the last blocking initialisation step finishes.
pub fn arm_fallback(app: AppHandle, delay: std::time::Duration) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(delay).await;
        if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
            // `is_visible` is false both when hidden and when the handle is
            // gone; showing an already-visible window is a no-op with a focus
            // call, which is harmless.
            if !window.is_visible().unwrap_or(false) {
                show(&window);
            }
        }
    });
}
