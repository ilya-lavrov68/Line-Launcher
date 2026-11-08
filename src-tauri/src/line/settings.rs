//! Player settings, persisted in the per-user app-data directory.
//!
//! Deliberately narrow. The launch hardening in `launch.rs` rejects `-javaagent`
//! and classpath injection, so there is no free-form JVM argument field here:
//! the player picks a heap size and one of the Java runtimes the launcher itself
//! discovered or explicitly selected. A stored Java path is never trusted on
//! its own: Rust resolves it and executes `java -version` before saving/launch.
use super::error::{LineError, LineResult};
use super::launch::{heap_ceiling, validate_heap};
use super::storage::atomic_write;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const MIN_WINDOW_WIDTH: u32 = 800;
pub const MIN_WINDOW_HEIGHT: u32 = 560;
pub const MAX_WINDOW_DIMENSION: u32 = 15_360;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AfterLaunch {
    /// Leave the launcher window as it is.
    #[default]
    Keep,
    Minimize,
    Close,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct LauncherSettings {
    /// None = derive from physical memory exactly as before.
    pub heap_mb: Option<u32>,
    /// Must match a runtime the launcher discovers; revalidated before launch.
    pub java_path: Option<String>,
    /// Persisted so the navigation stays the way the player left it.
    pub sidebar_collapsed: bool,
    pub after_launch: AfterLaunch,
    pub window_width: u32,
    pub window_height: u32,
    pub window_maximized: bool,
}

impl Default for LauncherSettings {
    fn default() -> Self {
        Self {
            heap_mb: None,
            java_path: None,
            sidebar_collapsed: false,
            after_launch: AfterLaunch::Keep,
            window_width: 1100,
            window_height: 720,
            window_maximized: false,
        }
    }
}

impl LauncherSettings {
    /// Reject out-of-range values instead of silently clamping, so the UI and
    /// the stored document can never disagree about what was saved.
    pub fn validate(&self, total_memory_bytes: u64) -> LineResult<()> {
        if let Some(heap) = self.heap_mb {
            validate_heap(heap, total_memory_bytes)?;
        }
        if let Some(path) = &self.java_path {
            super::java::validate_path(path)?;
        }
        if !(MIN_WINDOW_WIDTH..=MAX_WINDOW_DIMENSION).contains(&self.window_width)
            || !(MIN_WINDOW_HEIGHT..=MAX_WINDOW_DIMENSION).contains(&self.window_height)
        {
            return Err(LineError::input("Недопустимый размер окна."));
        }
        Ok(())
    }
}

fn settings_path(app: &AppHandle) -> LineResult<PathBuf> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|_| LineError::storage())?
        .join("settings.json"))
}

/// A corrupt or unreadable document must not brick startup: fall back to
/// defaults. Values are still validated against this machine's memory.
pub fn load(app: &AppHandle, total_memory_bytes: u64) -> LauncherSettings {
    let Ok(path) = settings_path(app) else {
        return LauncherSettings::default();
    };
    let Ok(bytes) = std::fs::read(path) else {
        return LauncherSettings::default();
    };
    if bytes.len() > 64 * 1024 {
        return LauncherSettings::default();
    }
    match serde_json::from_slice::<LauncherSettings>(&bytes) {
        Ok(settings) if settings.validate(total_memory_bytes).is_ok() => settings,
        _ => LauncherSettings::default(),
    }
}

pub fn save(
    app: &AppHandle,
    settings: &LauncherSettings,
    total_memory_bytes: u64,
) -> LineResult<()> {
    settings.validate(total_memory_bytes)?;
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| {
        LineError::new(super::error::ErrorCode::Internal, "Ошибка настроек.", false)
    })?;
    atomic_write(&settings_path(app)?, &bytes)
}

fn total_memory() -> u64 {
    let mut system = sysinfo::System::new();
    system.refresh_memory();
    system.total_memory()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsSnapshot {
    pub settings: LauncherSettings,
    pub heap_ceiling_mb: u32,
    pub suggested_heap_mb: u32,
    pub total_memory_mb: u32,
}

fn snapshot(settings: LauncherSettings, total: u64) -> SettingsSnapshot {
    SettingsSnapshot {
        settings,
        heap_ceiling_mb: heap_ceiling(total),
        suggested_heap_mb: super::launch::optimal_heap_mb(total),
        total_memory_mb: (total / (1024 * 1024)) as u32,
    }
}

#[tauri::command]
pub async fn get_settings(app: AppHandle) -> LineResult<SettingsSnapshot> {
    let total = total_memory();
    Ok(snapshot(load(&app, total), total))
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    mut settings: LauncherSettings,
) -> LineResult<SettingsSnapshot> {
    let total = total_memory();
    // An explicit path need not be on PATH/JAVA_HOME. Resolve and execute it
    // directly, then persist the canonical executable rather than the hint.
    if let Some(requested) = &settings.java_path {
        let runtime = super::java::inspect_path(requested).await?;
        settings.java_path = Some(runtime.path.to_string_lossy().into_owned());
    }
    save(&app, &settings, total)?;
    Ok(snapshot(settings, total))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JavaRuntimeInfo {
    pub path: String,
    pub major: u16,
    pub version: String,
}

/// Verifies a player-supplied java.exe/JDK path and returns actionable failure.
#[tauri::command]
pub async fn probe_java_path(path: String) -> LineResult<JavaRuntimeInfo> {
    let runtime = super::java::inspect_path(&path).await?;
    Ok(JavaRuntimeInfo {
        path: runtime.path.to_string_lossy().into_owned(),
        major: runtime.major,
        version: runtime.version,
    })
}

#[tauri::command]
pub async fn list_java_runtimes() -> LineResult<Vec<JavaRuntimeInfo>> {
    Ok(super::java::list_runtimes()
        .await
        .into_iter()
        .map(|r| JavaRuntimeInfo {
            path: r.path.to_string_lossy().into_owned(),
            major: r.major,
            version: r.version,
        })
        .collect())
}

/// Removes only the cached provider config. Installed builds and history live
/// under instances/ and are never touched by this command.
#[tauri::command]
pub async fn clear_config_cache(app: AppHandle) -> LineResult<bool> {
    let path = super::config_commands::cache_file_path(&app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(LineError::io(&error)),
    }
}
