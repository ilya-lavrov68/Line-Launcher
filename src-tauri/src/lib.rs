pub mod line;

use line::state::LineState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            app.manage(LineState::new()?);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            line::config_commands::get_cached_config,
            line::config_commands::fetch_line_config,
            line::auth::line_login,
            line::auth::line_register,
            line::auth::line_logout,
            line::install::download_and_extract_zip,
            line::install::cancel_install,
            line::install::get_installed_build,
            line::launch::launch_game,
            line::launch::stop_game,
            line::launch::get_game_status,
            line::rollback::list_release_history,
            line::rollback::rollback_release,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Line Launcher");
}
