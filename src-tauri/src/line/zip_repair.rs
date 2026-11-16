//! A consent request for one ZIP revision and its current repair actions.
//! The value is re-created from trusted state before every use, never used as
//! filesystem input, and is not a security credential or a permanent receipt.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ZipRepairPlan {
    pub schema: u8,
    pub server_id: String,
    pub instance_id: String,
    pub release_sha256: String,
    pub minecraft_version: String,
    pub profile_id: String,
    pub detected_loader: Option<String>,
    pub requested_loader: Option<String>,
    pub generated_profile: bool,
    pub install_loader: bool,
    pub missing_from_archive: Vec<String>,
    pub live_asset_issues: u64,
    pub live_asset_bytes: u64,
    pub prepare_only: bool,
    pub test_mode: bool,
}

impl ZipRepairPlan {
    /// Never reuse a consent for a different release, instance or action.
    pub fn is_approved_by(&self, approved: Option<&Self>) -> bool {
        approved == Some(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn example() -> ZipRepairPlan {
        ZipRepairPlan {
            schema: 1,
            server_id: "server".into(),
            instance_id: "server".into(),
            release_sha256: "a".repeat(64),
            minecraft_version: "1.20.1".into(),
            profile_id: "1.20.1".into(),
            detected_loader: None,
            requested_loader: None,
            generated_profile: false,
            install_loader: false,
            missing_from_archive: vec!["assets".into()],
            live_asset_issues: 0,
            live_asset_bytes: 0,
            prepare_only: true,
            test_mode: false,
        }
    }
    #[test]
    fn only_identical_plan_is_approved() {
        let plan = example();
        assert!(!plan.is_approved_by(None));
        assert!(plan.is_approved_by(Some(&plan.clone())));
        let mut changed = plan.clone();
        changed.release_sha256 = "b".repeat(64);
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.missing_from_archive.push("libraries".into());
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.live_asset_issues = 1;
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.install_loader = true;
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.prepare_only = false;
        assert!(!plan.is_approved_by(Some(&changed)));
        changed = plan.clone();
        changed.server_id = "other".into();
        assert!(!plan.is_approved_by(Some(&changed)));
    }
}
