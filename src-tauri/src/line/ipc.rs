//! One-shot private launch-ticket channel. Unix socket / Windows named pipe.
//! The JVM receives only a random channel id, never the provider token/ticket.
//! The listener is created before the child is spawned, so a fast mod cannot
//! lose a connect-before-bind race.
use super::error::{ErrorCode, LineError, LineResult};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::{timeout_at, Instant};
use uuid::Uuid;
use zeroize::Zeroizing;

pub const IPC_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_MESSAGE: usize = 16 * 1024;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct TicketRequest {
    #[serde(rename = "type")]
    kind: String,
    channel: String,
}

/// Everything the mod receives alongside the one-shot ticket. Grouped so the
/// IPC entry point stays within clippy's argument budget and the binding set is
/// named in one place.
pub struct TicketGrant<'a> {
    pub exchange_url: &'a str,
    pub server_id: &'a str,
    pub sha256: &'a str,
    pub username: &'a str,
    pub expires_in: u64,
}

#[derive(Serialize)]
struct TicketResponse<'a> {
    #[serde(rename = "type")]
    kind: &'static str,
    ticket: &'a str,
    exchange_url: &'a str,
    server_id: &'a str,
    sha256: &'a str,
    username: &'a str,
}

pub struct PrivateChannel {
    pub id: String,
    #[cfg(unix)]
    pub socket_path: std::path::PathBuf,
    #[cfg(unix)]
    dir: std::path::PathBuf,
    #[cfg(unix)]
    listener: tokio::net::UnixListener,
    #[cfg(windows)]
    pub pipe_name: String,
    #[cfg(windows)]
    server: tokio::net::windows::named_pipe::NamedPipeServer,
}

impl PrivateChannel {
    pub fn create() -> LineResult<Self> {
        let id = Uuid::new_v4().to_string();
        #[cfg(unix)]
        {
            // A short, stable path shared by Rust and the reference Java client.
            // java.io.tmpdir/TMPDIR differ on macOS and can exceed sun_path.
            let dir = std::path::PathBuf::from("/tmp").join(format!("line-ipc-{id}"));
            use std::os::unix::fs::DirBuilderExt;
            std::fs::DirBuilder::new()
                .mode(0o700)
                .create(&dir)
                .map_err(|e| LineError::io(&e))?;
            let socket_path = dir.join("ticket.sock");
            let created = (|| {
                let listener =
                    tokio::net::UnixListener::bind(&socket_path).map_err(|e| LineError::io(&e))?;
                // The 0700 directory is the primary boundary; tighten the socket too.
                std::fs::set_permissions(
                    &socket_path,
                    std::os::unix::fs::PermissionsExt::from_mode(0o600),
                )
                .map_err(|e| LineError::io(&e))?;
                Ok(Self {
                    id: id.clone(),
                    socket_path,
                    dir: dir.clone(),
                    listener,
                })
            })();
            if created.is_err() {
                let _ = std::fs::remove_dir_all(&dir);
            }
            created
        }
        #[cfg(windows)]
        {
            let pipe_name = format!(r"\\.\pipe\line-launcher-{id}");
            let server = create_user_pipe(&pipe_name)?;
            Ok(Self {
                id,
                pipe_name,
                server,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            let _ = id;
            Err(LineError::new(
                ErrorCode::Internal,
                "Приватный IPC недоступен на этой ОС.",
                false,
            ))
        }
    }

    /// Wait for the spawned game process, verify its OS peer credentials, read
    /// one bounded request and write one response. The ticket is zeroized afterwards.
    /// The whole exchange shares one deadline, capped by the provider ticket TTL.
    pub async fn serve_once(
        self,
        expected_pid: u32,
        ticket: Zeroizing<String>,
        grant: TicketGrant<'_>,
    ) -> LineResult<()> {
        let ttl = Duration::from_secs(grant.expires_in.clamp(1, 120)).min(IPC_TIMEOUT);
        let deadline = Instant::now() + ttl;
        #[cfg(unix)]
        let stream = {
            let (stream, _) = timeout_at(deadline, self.listener.accept())
                .await
                .map_err(|_| {
                    LineError::new(
                        ErrorCode::AuthRequired,
                        "Мод не запросил launch ticket вовремя.",
                        false,
                    )
                })?
                .map_err(|e| LineError::io(&e))?;
            let cred = stream.peer_cred().map_err(|e| LineError::io(&e))?;
            let expected_uid = unsafe { libc::geteuid() };
            let peer_pid_ok = cred
                .pid()
                .is_some_and(|pid| pid > 0 && pid as u32 == expected_pid);
            if cred.uid() != expected_uid || !peer_pid_ok {
                return Err(LineError::new(
                    ErrorCode::AuthRequired,
                    "К приватному каналу обратился посторонний процесс.",
                    false,
                ));
            }
            stream
        };
        #[cfg(windows)]
        let stream = {
            timeout_at(deadline, self.server.connect())
                .await
                .map_err(|_| {
                    LineError::new(
                        ErrorCode::AuthRequired,
                        "Мод не запросил launch ticket вовремя.",
                        false,
                    )
                })?
                .map_err(|e| LineError::io(&e))?;
            let mut pid = 0u32;
            let ok = unsafe {
                windows_sys::Win32::System::Pipes::GetNamedPipeClientProcessId(
                    std::os::windows::io::AsRawHandle::as_raw_handle(&self.server) as *mut _,
                    &mut pid,
                )
            };
            if ok == 0 || pid != expected_pid {
                return Err(LineError::new(
                    ErrorCode::AuthRequired,
                    "К приватному каналу обратился посторонний процесс.",
                    false,
                ));
            }
            self.server
        };
        #[cfg(not(any(unix, windows)))]
        {
            let _ = (expected_pid, ticket, grant, deadline);
            return Err(LineError::new(
                ErrorCode::Internal,
                "Приватный IPC недоступен на этой ОС.",
                false,
            ));
        }

        let (mut read, mut write) = tokio::io::split(stream);
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = timeout_at(deadline, read.read(&mut buffer))
                .await
                .map_err(|_| {
                    LineError::new(ErrorCode::AuthRequired, "Мод не ответил вовремя.", false)
                })?
                .map_err(|e| LineError::io(&e))?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.len() > MAX_MESSAGE {
                return Err(LineError::input("Некорректный запрос мода."));
            }
            if let Some(pos) = bytes.iter().position(|&b| b == b'\n') {
                if pos != bytes.len() - 1 {
                    return Err(LineError::input("Некорректный запрос мода."));
                }
                break;
            }
        }
        if bytes.last() != Some(&b'\n') {
            return Err(LineError::input("Некорректный запрос мода."));
        }
        let line = std::str::from_utf8(&bytes[..bytes.len() - 1])
            .map_err(|_| LineError::input("Некорректный запрос мода."))?;
        let request: TicketRequest = serde_json::from_str(line)
            .map_err(|_| LineError::input("Некорректный запрос мода."))?;
        if request.kind != "line.launch-ticket.request" || request.channel != self.id {
            return Err(LineError::new(
                ErrorCode::AuthRequired,
                "Мод предъявил неверный канал.",
                false,
            ));
        }
        let response = TicketResponse {
            kind: "line.launch-ticket.response",
            ticket: &ticket,
            exchange_url: grant.exchange_url,
            server_id: grant.server_id,
            sha256: grant.sha256,
            username: grant.username,
        };
        let mut response_bytes =
            Zeroizing::new(serde_json::to_vec(&response).map_err(|_| LineError::storage())?);
        response_bytes.push(b'\n');
        timeout_at(deadline, write.write_all(&response_bytes))
            .await
            .map_err(|_| {
                LineError::new(
                    ErrorCode::AuthRequired,
                    "Не удалось передать ticket моду.",
                    false,
                )
            })?
            .map_err(|e| LineError::io(&e))?;
        timeout_at(deadline, write.shutdown())
            .await
            .map_err(|_| {
                LineError::new(
                    ErrorCode::AuthRequired,
                    "Не удалось завершить передачу ticket.",
                    false,
                )
            })?
            .map_err(|e| LineError::io(&e))?;
        Ok(())
    }
}

#[cfg(unix)]
impl Drop for PrivateChannel {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
}

#[cfg(windows)]
fn create_user_pipe(name: &str) -> LineResult<tokio::net::windows::named_pipe::NamedPipeServer> {
    let mut security = WindowsPipeSecurity::current_user()?;
    unsafe {
        tokio::net::windows::named_pipe::ServerOptions::new()
            .first_pipe_instance(true)
            .reject_remote_clients(true)
            .max_instances(1)
            .create_with_security_attributes_raw(
                name,
                security.attributes_mut() as *mut _ as *mut std::ffi::c_void,
            )
    }
    .map_err(|e| LineError::io(&e))
}

#[cfg(windows)]
struct WindowsPipeSecurity {
    descriptor: *mut std::ffi::c_void,
    attributes: windows_sys::Win32::Security::SECURITY_ATTRIBUTES,
}

#[cfg(windows)]
impl WindowsPipeSecurity {
    fn current_user() -> LineResult<Self> {
        use windows_sys::Win32::Foundation::{CloseHandle, LocalFree};
        use windows_sys::Win32::Security::Authorization::{
            ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
        };
        use windows_sys::Win32::Security::{
            GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
        };
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
        unsafe {
            let mut token = std::ptr::null_mut();
            if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) == 0 {
                return Err(LineError::storage());
            }
            let mut size = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut size);
            if size == 0 {
                CloseHandle(token);
                return Err(LineError::storage());
            }
            // usize allocation guarantees alignment for TOKEN_USER.
            let words = (size as usize).div_ceil(std::mem::size_of::<usize>());
            let mut buffer = vec![0usize; words];
            let ok = GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr() as *mut _,
                size,
                &mut size,
            );
            CloseHandle(token);
            if ok == 0 {
                return Err(LineError::storage());
            }
            let user = &*(buffer.as_ptr() as *const TOKEN_USER);
            let mut sid = std::ptr::null_mut();
            if ConvertSidToStringSidW(user.User.Sid, &mut sid) == 0 {
                return Err(LineError::storage());
            }
            let len = (0..).take_while(|&i| *sid.add(i) != 0).count();
            let sid_text = String::from_utf16_lossy(std::slice::from_raw_parts(sid, len));
            LocalFree(sid as *mut _);
            let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid_text})")
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
            let mut descriptor = std::ptr::null_mut();
            let ok = ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                1,
                &mut descriptor,
                std::ptr::null_mut(),
            );
            if ok == 0 || descriptor.is_null() {
                return Err(LineError::storage());
            }
            Ok(Self {
                descriptor,
                attributes: windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
                    nLength: std::mem::size_of::<windows_sys::Win32::Security::SECURITY_ATTRIBUTES>(
                    ) as u32,
                    lpSecurityDescriptor: descriptor,
                    bInheritHandle: 0,
                },
            })
        }
    }

    fn attributes_mut(&mut self) -> &mut windows_sys::Win32::Security::SECURITY_ATTRIBUTES {
        &mut self.attributes
    }
}

#[cfg(windows)]
impl Drop for WindowsPipeSecurity {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::LocalFree(self.descriptor as *mut _);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::UnixStream;

    async fn connect(path: &std::path::Path) -> UnixStream {
        UnixStream::connect(path).await.unwrap()
    }

    #[tokio::test]
    async fn unix_channel_is_bound_private_and_one_shot() {
        let channel = PrivateChannel::create().unwrap();
        let path = channel.socket_path.clone();
        let dir = channel.dir.clone();
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        // The listener exists before any child/connect race.
        let mut client = connect(&path).await;
        let id = channel.id.clone();
        let server = tokio::spawn(async move {
            channel
                .serve_once(
                    std::process::id(),
                    Zeroizing::new("ticket-secret".into()),
                    TicketGrant {
                        exchange_url: "https://auth.example.com/exchange",
                        server_id: "survival",
                        sha256: &"a".repeat(64),
                        username: "player",
                        expires_in: 60,
                    },
                )
                .await
        });
        client
            .write_all(
                format!("{{\"type\":\"line.launch-ticket.request\",\"channel\":\"{id}\"}}\n")
                    .as_bytes(),
            )
            .await
            .unwrap();
        let mut response = String::new();
        client.read_to_string(&mut response).await.unwrap();
        assert!(response.contains("ticket-secret"));
        server.await.unwrap().unwrap();
        assert!(!path.exists());
        assert!(UnixStream::connect(&path).await.is_err());
    }

    #[tokio::test]
    async fn unix_channel_rejects_wrong_channel_and_oversize() {
        let channel = PrivateChannel::create().unwrap();
        let path = channel.socket_path.clone();
        let mut client = connect(&path).await;
        let server = tokio::spawn(async move {
            channel
                .serve_once(
                    std::process::id(),
                    Zeroizing::new("secret".into()),
                    TicketGrant {
                        exchange_url: "https://auth.example.com/exchange",
                        server_id: "survival",
                        sha256: &"a".repeat(64),
                        username: "player",
                        expires_in: 60,
                    },
                )
                .await
        });
        let _ = client
            .write_all(b"{\"type\":\"line.launch-ticket.request\",\"channel\":\"wrong\"}\n")
            .await;
        assert_eq!(
            server.await.unwrap().unwrap_err().code,
            ErrorCode::AuthRequired
        );

        let channel = PrivateChannel::create().unwrap();
        let path = channel.socket_path.clone();
        let mut client = connect(&path).await;
        let server = tokio::spawn(async move {
            channel
                .serve_once(
                    std::process::id(),
                    Zeroizing::new("secret".into()),
                    TicketGrant {
                        exchange_url: "https://auth.example.com/exchange",
                        server_id: "survival",
                        sha256: &"a".repeat(64),
                        username: "player",
                        expires_in: 60,
                    },
                )
                .await
        });
        let _ = client.write_all(&vec![b'a'; MAX_MESSAGE + 1]).await;
        assert_eq!(
            server.await.unwrap().unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }
}
