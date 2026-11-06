pub mod auth;
pub mod config;
pub mod config_commands;
#[cfg(feature = "dev-provider-ca")]
pub mod dev_ca;
pub mod error;
pub mod http;
pub mod install;
pub mod ipc;
pub mod java;
pub mod launch;
pub mod launch_manifest;
pub mod rollback;
pub mod state;
pub mod storage;

pub const LAUNCHER_VERSION: &str = env!("CARGO_PKG_VERSION");
