pub mod line;

use line::state::LineState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Startup order is deliberate. Only what a command cannot run
            // without blocks the window here; everything else is deferred to a
            // task so the WebView starts loading while `setup` is still cheap.
            // `LineState::new` builds the HTTP client, which several commands
            // already hold through `State`, so it stays; reading the settings
            // file (and running `sysinfo` for the heap ceiling) does not.
            app.manage(LineState::new()?);
            // The log has to exist before any command can fail, so it is set up
            // first — right after the state it will describe.
            if let Ok(root) = app.path().app_data_dir() {
                line::logger::init(root);
            }
            line::logger::info(
                line::logger::Area::App,
                "launcher started",
                &[
                    line::logger::Field::text("version", line::LAUNCHER_VERSION),
                    line::logger::Field::text("os", std::env::consts::OS),
                    line::logger::Field::text("arch", std::env::consts::ARCH),
                ],
            );
            app.manage(line::minecraft::MinecraftState::default());
            // Reading the settings file parses JSON and refreshes `sysinfo` for
            // the total-memory figure. Neither is needed to paint the window,
            // and the download limiter defaults to "unlimited" until this runs,
            // so it can happen a beat later without changing any behaviour.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                line::settings::init_download_limit(&handle);
            });
            // "Скрыть в трей" needs somewhere to go. A failed tray is not
            // fatal (see tray.rs): the setting then behaves like "minimise".
            // Building the menu and decoding the icon is cheap, but it is not
            // needed for the first frame either, so it is queued on the main
            // thread instead of run inline; the tray appears a few milliseconds
            // later. It has to be the main thread: GTK will not build a tray
            // icon anywhere else.
            let handle = app.handle().clone();
            let _ = app.run_on_main_thread(move || {
                if let Err(error) = line::tray::install(&handle) {
                    eprintln!("[tray] notification icon unavailable: {error}");
                }
            });
            // The window starts hidden (`"visible": false`); the interface
            // reveals it once the first frame is painted, so no player watches
            // a blank WebView. The fallback covers the case where the frontend
            // dies before it can ask: a hidden window would look like a
            // launcher that never started.
            line::window::arm_fallback(app.handle().clone(), std::time::Duration::from_secs(6));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            line::config_commands::get_cached_config,
            line::config_commands::fetch_line_config,
            line::config_commands::ensure_fresh_config,
            line::auth::line_login,
            line::auth::line_register,
            line::auth::line_logout,
            line::auth::line_session,
            line::install::download_and_extract_zip,
            line::install::cancel_install,
            line::install::get_installed_build,
            line::launch::launch_game,
            line::launch::stop_game,
            line::launch::get_game_status,
            line::launch::check_resource_packs,
            line::rollback::list_release_history,
            line::rollback::rollback_release,
            line::settings::get_settings,
            line::settings::save_settings,
            line::settings::list_java_runtimes,
            line::settings::probe_java_path,
            line::settings::clear_config_cache,
            line::minecraft::mc_install,
            line::minecraft::mc_list_installed,
            line::minecraft::mc_launch,
            line::minecraft::mc_play,
            line::minecraft::mc_stop,
            line::minecraft::mc_status,
            line::wardrobe::get_skin,
            line::skin_library::list_skin_library,
            line::skin_library::add_skin_to_library,
            line::skin_library::rename_skin,
            line::skin_library::delete_skin_from_library,
            line::skin_library::read_skin_texture,
            line::skin_library::set_active_skin,
            line::skin_library::sync_active_skin,
            line::skin_library::forget_synced_skin,
            line::support::open_logs_folder,
            line::support::copy_diagnostics,
            line::support::open_mail_draft,
            line::window::show_main_window,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Line Launcher");
}
