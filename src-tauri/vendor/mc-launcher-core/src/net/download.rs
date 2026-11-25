//! Download plans and execution.

use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
};

use crate::{
    io::hash::sha1_file,
    progress::{ProgressEvent, ProgressReporter, SkipReason},
    LauncherError, Result,
};

/// Supported checksum validation methods for downloaded files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Checksum {
    /// SHA-1 checksum.
    Sha1(String),
    /// SHA-256 checksum.
    Sha256(String),
}

/// One file download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DownloadTask {
    /// Source URL.
    pub url: String,
    /// Destination path.
    pub destination: PathBuf,
    /// Optional checksum used for skip and validation decisions.
    pub checksum: Option<Checksum>,
    /// Human-readable task label reported in progress events.
    pub label: String,
}

/// A batch of download tasks.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DownloadPlan {
    /// Tasks to execute in order.
    pub tasks: Vec<DownloadTask>,
}

/// Returns whether an existing destination file can be reused.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] if checksum calculation fails.
pub fn should_skip_existing(task: &DownloadTask) -> Result<bool> {
    if !task.destination.is_file() {
        return Ok(false);
    }

    match &task.checksum {
        Some(Checksum::Sha1(expected)) => Ok(sha1_file(&task.destination)? == *expected),
        Some(Checksum::Sha256(_)) => Ok(false),
        None => Ok(true),
    }
}

/// Executes a download plan in order.
///
/// Existing files with matching checksums are skipped. Each completed SHA-1
/// download is verified before it replaces the destination. A temporary file
/// prevents interrupted downloads from being mistaken for complete files on a
/// later run.
///
/// # Errors
///
/// Returns [`crate::LauncherError`] for network, filesystem, or checksum
/// failures.
pub fn execute_plan(plan: &DownloadPlan, reporter: &mut dyn ProgressReporter) -> Result<()> {
    let client = super::http::client()?;
    for task in &plan.tasks {
        if should_skip_existing(task)? {
            reporter.report(ProgressEvent::TaskSkipped {
                label: task.label.clone(),
                reason: if task.checksum.is_some() {
                    SkipReason::ChecksumMatched
                } else {
                    SkipReason::FileExistsWithoutChecksum
                },
            });
            continue;
        }

        reporter.report(ProgressEvent::TaskStarted {
            label: task.label.clone(),
            path: task.destination.clone(),
        });

        if let Some(parent) = task.destination.parent() {
            fs::create_dir_all(parent)?;
        }
        download_task(&client, task)?;

        reporter.report(ProgressEvent::TaskFinished {
            label: task.label.clone(),
        });
    }
    Ok(())
}

fn download_task(client: &reqwest::blocking::Client, task: &DownloadTask) -> Result<()> {
    let candidates = super::http::fallback_urls(&task.url);
    let parent = task
        .destination
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."));
    let mut last_error = None;

    'candidate: for (candidate_index, url) in candidates.iter().enumerate() {
        for attempt in 0..3 {
            let mut response = match client.get(url).send().and_then(|r| r.error_for_status()) {
                Ok(response) => response,
                Err(error) => {
                    let retryable = super::http::is_retryable(&error);
                    last_error = Some(LauncherError::Network { source: error });
                    if !retryable {
                        return Err(last_error.expect("error was just stored"));
                    }
                    if attempt < 2 {
                        std::thread::sleep(std::time::Duration::from_millis(
                            if attempt == 0 { 350 } else { 900 },
                        ));
                    }
                    continue;
                }
            };

            let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
            if let Err(error) = io::copy(&mut response, temporary.as_file_mut()) {
                let retryable = matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut
                        | io::ErrorKind::ConnectionReset
                        | io::ErrorKind::ConnectionAborted
                        | io::ErrorKind::UnexpectedEof
                        | io::ErrorKind::BrokenPipe
                        | io::ErrorKind::Interrupted
                );
                last_error = Some(LauncherError::Io { source: error });
                if !retryable {
                    return Err(last_error.expect("error was just stored"));
                }
                if attempt < 2 {
                    std::thread::sleep(std::time::Duration::from_millis(
                        if attempt == 0 { 350 } else { 900 },
                    ));
                }
                continue;
            }
            temporary.as_file_mut().flush()?;

            if let Some(Checksum::Sha1(expected)) = &task.checksum {
                let actual = sha1_file(temporary.path())?;
                if actual != *expected {
                    let error = LauncherError::ChecksumMismatch {
                        path: task.destination.clone(),
                        expected: expected.clone(),
                        actual,
                    };
                    if candidate_index + 1 < candidates.len() {
                        last_error = Some(error);
                        continue 'candidate;
                    }
                    return Err(error);
                }
            }

            temporary
                .persist(&task.destination)
                .map_err(|error| LauncherError::Io { source: error.error })?;
            return Ok(());
        }
    }

    Err(last_error.expect("at least one download attempt was made"))
}
