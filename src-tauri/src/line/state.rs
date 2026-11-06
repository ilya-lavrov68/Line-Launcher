use super::config::LineConfig;
use super::error::{ErrorCode, LineError, LineResult};
use super::launch::{GamePhase, GameStatus};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use zeroize::Zeroizing;

pub fn epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Private backend state. Debug output and IPC serialization cannot expose the token.
#[derive(Clone)]
pub struct ProviderSession {
    token: Arc<Zeroizing<String>>,
    pub username: String,
    pub expires_at: u64,
}

impl std::fmt::Debug for ProviderSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProviderSession")
            .field("token", &"[REDACTED]")
            .field("username", &self.username)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl ProviderSession {
    pub fn new(token: String, username: String, expires_in: u64) -> Self {
        Self {
            token: Arc::new(Zeroizing::new(token)),
            username,
            expires_at: epoch_millis().saturating_add(expires_in.saturating_mul(1000)),
        }
    }

    /// Only the future Rust game-launch/IPC module may call this; no Tauri command
    /// returns a token to the WebView. Arc copies are zeroized when the last drops.
    pub fn secret_token(&self) -> Arc<Zeroizing<String>> {
        self.token.clone()
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSessionInfo {
    pub server_id: String,
    pub username: String,
    pub expires_at: u64,
}

#[derive(Default)]
pub struct LineState {
    pub http: reqwest::Client,
    inner: Mutex<Inner>,
    /// Serializes config publication so an older slow response cannot overwrite
    /// a newer config/session invalidation. Never hold a std mutex over await.
    pub config_publish: tokio::sync::Mutex<()>,
    pub config_generation: std::sync::atomic::AtomicU64,
    /// Monotonic across the whole process so the WebView can drop reordered
    /// events instead of guessing from the phase alone.
    game_revision: std::sync::atomic::AtomicU64,
}

#[derive(Default)]
struct Inner {
    active: Option<(String, LineConfig)>,
    active_fetched_at: u64,
    sessions: HashMap<String, ProviderSession>,
    installations: HashSet<String>,
    operations: HashMap<String, Arc<AtomicBool>>,
    launches: HashMap<String, Arc<AtomicBool>>,
    rollbacks: HashSet<String>,
    running: HashMap<String, RunningGame>,
    game_status: HashMap<String, GameStatus>,
}

#[derive(Debug, Clone)]
pub struct RunningGame {
    pub sha256: String,
    pub started_at: u64,
    pub stop: Arc<AtomicBool>,
}

impl LineState {
    pub fn new() -> LineResult<Self> {
        let http = reqwest::Client::builder()
            .user_agent(concat!("LineLauncher/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| {
                LineError::new(
                    ErrorCode::Internal,
                    "Не удалось инициализировать HTTP-клиент.",
                    false,
                )
            })?;
        Ok(Self {
            http,
            inner: Mutex::new(Inner::default()),
            config_publish: tokio::sync::Mutex::new(()),
            config_generation: std::sync::atomic::AtomicU64::new(0),
            game_revision: std::sync::atomic::AtomicU64::new(0),
        })
    }

    fn lock(&self) -> LineResult<std::sync::MutexGuard<'_, Inner>> {
        self.inner
            .lock()
            .map_err(|_| LineError::new(ErrorCode::Internal, "Внутренняя ошибка состояния.", false))
    }

    pub fn set_config(&self, url: String, config: LineConfig, fetched_at: u64) -> LineResult<()> {
        let mut inner = self.lock()?;
        if !inner.installations.is_empty()
            || !inner.launches.is_empty()
            || !inner.rollbacks.is_empty()
            || !inner.running.is_empty()
        {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Дождитесь завершения установки или игры перед сменой конфигурации.",
                false,
            ));
        }
        self.config_generation.fetch_add(1, Ordering::Release);
        // Changing providers/endpoints must not reuse a session from the old config.
        if inner.active.as_ref().is_some_and(|(old_url, old)| {
            old_url != &url
                || old.provider.id != config.provider.id
                || old.servers.iter().any(|old_server| {
                    config
                        .server(&old_server.id)
                        .is_ok_and(|new_server| old_server.auth != new_server.auth)
                })
        }) {
            inner.sessions.clear();
        }
        let ids: HashSet<_> = config.servers.iter().map(|s| s.id.clone()).collect();
        inner.sessions.retain(|id, _| ids.contains(id));
        inner.game_status.retain(|id, _| ids.contains(id));
        inner.active = Some((url, config));
        inner.active_fetched_at = fetched_at;
        Ok(())
    }

    pub fn active_config(&self) -> LineResult<(String, LineConfig)> {
        self.lock()?
            .active
            .clone()
            .ok_or_else(|| LineError::input("Сначала загрузите конфигурацию провайдера."))
    }

    /// Cache is for display only. Auth/install require a config within its TTL.
    pub fn fresh_config(&self) -> LineResult<(String, LineConfig)> {
        let inner = self.lock()?;
        let (url, config) = inner
            .active
            .as_ref()
            .ok_or_else(|| LineError::input("Сначала загрузите конфигурацию провайдера."))?;
        if epoch_millis().saturating_sub(inner.active_fetched_at)
            > config.ttl_seconds().saturating_mul(1000)
        {
            return Err(LineError::new(
                ErrorCode::AuthRequired,
                "Конфигурация устарела. Обновите её перед входом и установкой.",
                false,
            ));
        }
        Ok((url.clone(), config.clone()))
    }

    pub fn generation(&self) -> u64 {
        self.config_generation.load(Ordering::Acquire)
    }

    pub fn save_session(
        &self,
        id: String,
        session: ProviderSession,
        generation: u64,
    ) -> LineResult<AuthSessionInfo> {
        let info = AuthSessionInfo {
            server_id: id.clone(),
            username: session.username.clone(),
            expires_at: session.expires_at,
        };
        let mut inner = self.lock()?;
        if inner.installations.contains(&id)
            || inner.launches.contains_key(&id)
            || inner.rollbacks.contains(&id)
            || inner.running.contains_key(&id)
        {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Нельзя изменить сессию во время установки, отката или игры.",
                false,
            ));
        }
        if self.generation() != generation {
            return Err(LineError::new(
                ErrorCode::AuthRequired,
                "Конфигурация изменилась. Повторите вход.",
                false,
            ));
        }
        inner.sessions.retain(|_, s| s.expires_at > epoch_millis());
        inner.sessions.insert(id, session);
        Ok(info)
    }

    pub fn session(&self, id: &str) -> LineResult<ProviderSession> {
        self.lock()?
            .sessions
            .get(id)
            .filter(|s| s.expires_at > epoch_millis())
            .cloned()
            .ok_or_else(|| {
                LineError::new(
                    ErrorCode::AuthRequired,
                    "Войдите в аккаунт провайдера перед установкой.",
                    false,
                )
            })
    }

    pub fn logout(&self, id: &str) -> LineResult<()> {
        let mut inner = self.lock()?;
        if inner.installations.contains(id)
            || inner.launches.contains_key(id)
            || inner.rollbacks.contains(id)
            || inner.running.contains_key(id)
        {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Выход из аккаунта недоступен во время установки, отката или игры.",
                false,
            ));
        }
        inner.sessions.remove(id);
        Ok(())
    }

    pub fn begin_install(
        &self,
        server_id: &str,
        operation_id: &str,
    ) -> LineResult<Arc<AtomicBool>> {
        let mut inner = self.lock()?;
        if inner.installations.contains(server_id)
            || inner.launches.contains_key(server_id)
            || inner.rollbacks.contains(server_id)
            || inner.running.contains_key(server_id)
            || inner.operations.contains_key(operation_id)
        {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Установка этого сервера уже выполняется.",
                false,
            ));
        }
        inner.installations.insert(server_id.to_owned());
        let cancel = Arc::new(AtomicBool::new(false));
        inner
            .operations
            .insert(operation_id.to_owned(), cancel.clone());
        Ok(cancel)
    }

    pub fn finish_install(&self, server_id: &str, operation_id: &str) {
        if let Ok(mut inner) = self.lock() {
            inner.installations.remove(server_id);
            inner.operations.remove(operation_id);
        }
    }

    pub fn begin_launch(&self, server_id: &str) -> LineResult<Arc<AtomicBool>> {
        let mut inner = self.lock()?;
        if inner.installations.contains(server_id)
            || inner.launches.contains_key(server_id)
            || inner.rollbacks.contains(server_id)
            || inner.running.contains_key(server_id)
        {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Этот сервер уже устанавливается, откатывается или игра запущена.",
                false,
            ));
        }
        let stop = Arc::new(AtomicBool::new(false));
        inner.launches.insert(server_id.to_owned(), stop.clone());
        Ok(stop)
    }

    pub fn begin_rollback(&self, server_id: &str) -> LineResult<()> {
        let mut inner = self.lock()?;
        if inner.installations.contains(server_id)
            || inner.launches.contains_key(server_id)
            || inner.rollbacks.contains(server_id)
            || inner.running.contains_key(server_id)
        {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Откат недоступен во время установки, запуска или игры.",
                false,
            ));
        }
        inner.rollbacks.insert(server_id.to_owned());
        Ok(())
    }

    pub fn finish_rollback(&self, server_id: &str) {
        if let Ok(mut inner) = self.lock() {
            inner.rollbacks.remove(server_id);
        }
    }

    pub fn finish_launch(&self, server_id: &str) {
        if let Ok(mut inner) = self.lock() {
            inner.launches.remove(server_id);
        }
    }

    /// Atomically transfer the starting reservation into a running game. The
    /// same stop flag remains valid, so a stop requested during startup is not lost.
    pub fn register_running(
        &self,
        server_id: &str,
        sha256: &str,
        stop: Arc<AtomicBool>,
    ) -> LineResult<RunningGame> {
        let mut inner = self.lock()?;
        if !inner.launches.contains_key(server_id) || inner.running.contains_key(server_id) {
            return Err(LineError::new(
                ErrorCode::Busy,
                "Запуск уже отменён или игра запущена.",
                false,
            ));
        }
        inner.launches.remove(server_id);
        let game = RunningGame {
            sha256: sha256.to_owned(),
            started_at: epoch_millis(),
            stop,
        };
        inner.running.insert(server_id.to_owned(), game.clone());
        Ok(game)
    }

    pub fn finish_game(&self, server_id: &str) {
        if let Ok(mut inner) = self.lock() {
            inner.running.remove(server_id);
        }
    }

    /// Stamp a status with the next revision and remember it, so a later
    /// `get_game_status` poll cannot resurrect an older phase.
    pub fn publish_game_status(&self, mut status: GameStatus) -> GameStatus {
        status.revision = self.game_revision.fetch_add(1, Ordering::AcqRel) + 1;
        if let Ok(mut inner) = self.lock() {
            inner
                .game_status
                .insert(status.server_id.clone(), status.clone());
        }
        status
    }

    pub fn game_status(&self, server_id: &str) -> LineResult<GameStatus> {
        Ok(self
            .lock()?
            .game_status
            .get(server_id)
            .cloned()
            .unwrap_or(GameStatus {
                server_id: server_id.to_owned(),
                revision: 0,
                phase: GamePhase::Idle,
                sha256: None,
                started_at: None,
                exit_code: None,
                message: None,
            }))
    }

    pub fn stop_game(&self, server_id: &str) -> LineResult<bool> {
        let inner = self.lock()?;
        if let Some(stop) = inner.launches.get(server_id) {
            stop.store(true, Ordering::Release);
            return Ok(true);
        }
        Ok(inner
            .running
            .get(server_id)
            .map(|game| {
                game.stop.store(true, Ordering::Release);
                true
            })
            .unwrap_or(false))
    }

    pub fn is_launching(&self, server_id: &str) -> LineResult<bool> {
        Ok(self.lock()?.launches.contains_key(server_id))
    }

    pub fn is_busy_with_build(&self, server_id: &str) -> LineResult<bool> {
        let inner = self.lock()?;
        Ok(inner.installations.contains(server_id)
            || inner.launches.contains_key(server_id)
            || inner.rollbacks.contains(server_id)
            || inner.running.contains_key(server_id))
    }

    pub fn running_release(&self, server_id: &str) -> LineResult<Option<String>> {
        Ok(self
            .lock()?
            .running
            .get(server_id)
            .map(|game| game.sha256.clone()))
    }

    pub fn cancel(&self, operation_id: &str) -> LineResult<bool> {
        Ok(self
            .lock()?
            .operations
            .get(operation_id)
            .map(|cancel| {
                cancel.store(true, Ordering::Release);
                true
            })
            .unwrap_or(false))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn late_auth_cannot_republish_session_after_config_change() {
        let state = LineState::new().unwrap();
        let config: LineConfig =
            serde_json::from_str(include_str!("../../../examples/config.json")).unwrap();
        state
            .set_config(
                "https://provider.example/config.json".into(),
                config.clone(),
                epoch_millis(),
            )
            .unwrap();
        let generation = state.generation();
        state
            .set_config(
                "https://new-provider.example/config.json".into(),
                config,
                epoch_millis(),
            )
            .unwrap();
        let session = ProviderSession::new("secret".into(), "player".into(), 60);
        let result = state.save_session("survival".into(), session, generation);
        assert_eq!(result.unwrap_err().code, ErrorCode::AuthRequired);
        assert_eq!(
            state.session("survival").unwrap_err().code,
            ErrorCode::AuthRequired
        );
    }

    #[test]
    fn duplicate_install_and_operation_are_rejected() {
        let state = LineState::new().unwrap();
        let _cancel = state.begin_install("survival", "operation-1").unwrap();
        assert_eq!(
            state
                .begin_install("survival", "operation-2")
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        assert!(state.cancel("operation-1").unwrap());
        state.finish_install("survival", "operation-1");
        assert!(state.begin_install("survival", "operation-3").is_ok());
    }

    #[test]
    fn token_is_redacted_and_session_can_expire() {
        let session = ProviderSession::new("super-secret-token".into(), "player".into(), 60);
        assert!(!format!("{session:?}").contains("super-secret"));
        assert_eq!(&**session.secret_token(), "super-secret-token");
        let expired = ProviderSession {
            expires_at: 0,
            ..session
        };
        assert!(expired.expires_at < epoch_millis());
    }

    #[test]
    fn stop_during_startup_survives_running_registration() {
        let state = LineState::new().unwrap();
        let stop = state.begin_launch("survival").unwrap();
        assert!(state.is_launching("survival").unwrap());
        assert!(state.stop_game("survival").unwrap());
        let game = state
            .register_running("survival", &"a".repeat(64), stop.clone())
            .unwrap();
        assert!(!state.is_launching("survival").unwrap());
        assert!(game.stop.load(Ordering::Acquire));
        assert!(state.is_busy_with_build("survival").unwrap());
        state.finish_game("survival");
        assert!(!state.is_busy_with_build("survival").unwrap());
    }

    #[test]
    fn rollback_logout_and_config_change_are_blocked_while_active() {
        let state = LineState::new().unwrap();
        let config: LineConfig =
            serde_json::from_str(include_str!("../../../examples/config.json")).unwrap();
        state
            .set_config(
                "https://provider.example/config.json".into(),
                config.clone(),
                epoch_millis(),
            )
            .unwrap();
        let _stop = state.begin_launch("survival").unwrap();
        assert_eq!(
            state.begin_rollback("survival").unwrap_err().code,
            ErrorCode::Busy
        );
        assert_eq!(state.logout("survival").unwrap_err().code, ErrorCode::Busy);
        assert_eq!(
            state
                .set_config(
                    "https://provider.example/config.json".into(),
                    config,
                    epoch_millis()
                )
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        state.finish_launch("survival");
        assert!(state.begin_rollback("survival").is_ok());
        assert_eq!(
            state.begin_launch("survival").unwrap_err().code,
            ErrorCode::Busy
        );
        state.finish_rollback("survival");
    }

    #[test]
    fn game_status_revisions_are_monotonic_and_polls_keep_terminal_state() {
        use crate::line::launch::{GamePhase, GameStatus};
        let state = LineState::new().unwrap();
        let idle = state.game_status("survival").unwrap();
        assert_eq!(idle.phase, GamePhase::Idle);
        assert_eq!(idle.revision, 0);
        let status = |phase| GameStatus {
            server_id: "survival".into(),
            revision: 0,
            phase,
            sha256: Some("a".repeat(64)),
            started_at: Some(1),
            exit_code: None,
            message: None,
        };
        let starting = state.publish_game_status(status(GamePhase::Starting));
        let running = state.publish_game_status(status(GamePhase::Running));
        let failed = state.publish_game_status(status(GamePhase::Failed));
        assert!(starting.revision < running.revision);
        assert!(running.revision < failed.revision);
        // A poll after the terminal event must return the terminal event itself.
        let polled = state.game_status("survival").unwrap();
        assert_eq!(polled.phase, GamePhase::Failed);
        assert_eq!(polled.revision, failed.revision);
        // Another server has its own idle status but shares the counter.
        assert_eq!(state.game_status("creative").unwrap().revision, 0);
    }

    #[test]
    fn changing_launch_endpoints_invalidates_session() {
        let state = LineState::new().unwrap();
        let mut config: LineConfig =
            serde_json::from_str(include_str!("../../../examples/config.json")).unwrap();
        config.servers[0].auth.launch_ticket_url = Some("https://auth.example.com/ticket".into());
        config.servers[0].auth.session_exchange_url =
            Some("https://auth.example.com/exchange".into());
        state
            .set_config(
                "https://provider.example/config.json".into(),
                config.clone(),
                epoch_millis(),
            )
            .unwrap();
        let generation = state.generation();
        state
            .save_session(
                "survival".into(),
                ProviderSession::new("secret".into(), "player".into(), 60),
                generation,
            )
            .unwrap();
        config.servers[0].auth.session_exchange_url =
            Some("https://new.example.com/exchange".into());
        state
            .set_config(
                "https://provider.example/config.json".into(),
                config,
                epoch_millis(),
            )
            .unwrap();
        assert_eq!(
            state.session("survival").unwrap_err().code,
            ErrorCode::AuthRequired
        );
    }
}
