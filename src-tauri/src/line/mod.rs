pub mod auth;
pub mod config;
pub mod config_commands;
#[cfg(feature = "dev-provider-ca")]
pub mod dev_ca;
pub mod error;
pub mod http;
pub mod install;
pub mod integrity;
pub mod ipc;
pub mod java;
pub mod launch;
pub mod launch_manifest;
pub mod minecraft;
pub mod minecraft_core;
pub mod rollback;
pub mod settings;
pub mod skin_library;
pub mod state;
pub mod storage;
pub mod wardrobe;

pub const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");
