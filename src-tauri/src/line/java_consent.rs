//! A short-lived consent for one Java download, bound to the ZIP and operation.
//! It is recomputed from current state; it is not a path or a permanent trust grant.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JavaDownloadPlan {
    pub schema: u8,
    pub server_id: String,
    pub instance_id: String,
    pub release_sha256: String,
    pub major: u16,
    /// Either "loader" or "launch". Approval for one does not approve the other.
    pub purpose: String,
    /// "adoptium" on supported Windows x64; otherwise "mojang".
    pub source: String,
    pub prepare_only: bool,
    pub test_mode: bool,
}

impl JavaDownloadPlan {
    pub fn is_approved_by(&self, approved: Option<&Self>) -> bool {
        approved == Some(self)
    }
}

#[derive(Clone)]
pub struct JavaConsent {
    pub server_id: String,
    pub instance_id: String,
    pub release_sha256: String,
    pub prepare_only: bool,
    pub test_mode: bool,
    pub approved: Option<JavaDownloadPlan>,
}

impl JavaConsent {
    pub fn require(&self, major: u16, purpose: &str, source: &str) -> super::error::LineResult<()> {
        let plan = JavaDownloadPlan {
            schema: 1,
            server_id: self.server_id.clone(),
            instance_id: self.instance_id.clone(),
            release_sha256: self.release_sha256.clone(),
            major,
            purpose: purpose.into(),
            source: source.into(),
            prepare_only: self.prepare_only,
            test_mode: self.test_mode,
        };
        if plan.is_approved_by(self.approved.as_ref()) {
            return Ok(());
        }
        let mut error = super::error::LineError::new(super::error::ErrorCode::ConfirmationRequired,
            format!("Нужна Java {major}. Подтвердите отдельную загрузку Java или выберите установленную в настройках."), false);
        error.java_download = Some(Box::new(plan));
        Err(error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn consent_is_specific_to_revision_purpose_version_and_source() {
        let plan = JavaDownloadPlan {
            schema: 1,
            server_id: "server".into(),
            instance_id: "instance".into(),
            release_sha256: "a".repeat(64),
            major: 17,
            purpose: "loader".into(),
            source: "adoptium".into(),
            prepare_only: false,
            test_mode: false,
        };
        assert!(plan.is_approved_by(Some(&plan)));
        let mut changed = plan.clone();
        changed.major = 21;
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.purpose = "launch".into();
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.source = "mojang".into();
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.release_sha256 = "b".repeat(64);
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.prepare_only = true;
        assert!(!plan.is_approved_by(Some(&changed)));
        assert!(!plan.is_approved_by(None));
    }
}
