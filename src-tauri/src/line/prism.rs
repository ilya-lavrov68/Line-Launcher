//! Read-only inspection of a Prism/MultiMC `mmc-pack.json` component list.
//!
//! This module does not resolve, download, or execute components. Cached versions
//! are displayed only as hints: only a pinned `version` can define a future
//! installation plan. Custom/unknown components must not be silently dropped.
use super::error::{ErrorCode, LineError, LineResult};
use super::minecraft_core::{validate_version_id, LoaderChoice};
use serde_json::Value;
use std::collections::BTreeSet;

const MAX_METADATA_BYTES: usize = 256 * 1024;
const MAX_COMPONENTS: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrismComponent {
    pub uid: String,
    /// A cached version is informational and must not be used as a pin.
    pub version: Option<String>,
    pub cached_version: Option<String>,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrismProfile {
    pub components: Vec<PrismComponent>,
}

fn invalid() -> LineError {
    LineError::input("Некорректный mmc-pack.json: проверьте метаданные экземпляра Prism.")
}

fn version(value: Option<&Value>) -> LineResult<Option<String>> {
    match value {
        None => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) => validate_version_id(value).map(Some),
        _ => Err(invalid()),
    }
}

impl PrismProfile {
    pub fn parse(bytes: &[u8]) -> LineResult<Self> {
        if bytes.len() > MAX_METADATA_BYTES {
            return Err(LineError::input("mmc-pack.json превышает лимит 256 КиБ."));
        }
        let root: Value = serde_json::from_slice(bytes).map_err(|_| invalid())?;
        if root.get("formatVersion").and_then(Value::as_u64) != Some(1) {
            return Err(LineError::new(
                ErrorCode::UnsupportedVersion,
                "Версия формата mmc-pack.json не поддерживается.",
                false,
            ));
        }
        let entries = root
            .get("components")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?;
        if entries.is_empty() || entries.len() > MAX_COMPONENTS {
            return Err(invalid());
        }
        let mut seen = BTreeSet::new();
        let mut components = Vec::with_capacity(entries.len());
        for entry in entries {
            let uid = entry
                .get("uid")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?;
            if uid.is_empty()
                || uid.len() > 128
                || !uid
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
                || !seen.insert(uid.to_string())
            {
                return Err(invalid());
            }
            let disabled = match entry.get("disabled") {
                None => false,
                Some(Value::Bool(value)) => *value,
                _ => return Err(invalid()),
            };
            components.push(PrismComponent {
                uid: uid.to_string(),
                version: version(entry.get("version"))?,
                cached_version: version(entry.get("cachedVersion"))?,
                disabled,
            });
        }
        Ok(Self { components })
    }

    /// Information for a future plan, not evidence that a loader is installed.
    pub fn loader(component: &PrismComponent) -> Option<LoaderChoice> {
        match component.uid.as_str() {
            "net.fabricmc.fabric-loader" => Some(LoaderChoice::Fabric),
            "org.quiltmc.quilt-loader" => Some(LoaderChoice::Quilt),
            "net.minecraftforge" => Some(LoaderChoice::Forge),
            "net.neoforged" => Some(LoaderChoice::NeoForge),
            _ => None,
        }
    }

    pub fn summary(&self) -> String {
        let active: Vec<_> = self.components.iter().filter(|c| !c.disabled).collect();
        let minecraft = active.iter().find(|c| c.uid == "net.minecraft");
        let version = minecraft
            .and_then(|c| c.version.as_deref())
            .unwrap_or("не закреплена");
        let loaders: Vec<_> = active
            .iter()
            .filter_map(|c| Self::loader(c).map(|kind| (kind, *c)))
            .collect();
        let loader = match loaders.as_slice() {
            [] => "не указан".to_owned(),
            [(kind, component)] => format!(
                "{kind:?} {}",
                component
                    .version
                    .as_deref()
                    .unwrap_or("(версия не закреплена)")
            ),
            _ => "несколько загрузчиков — требуется проверка".to_owned(),
        };
        format!("Minecraft: {version}; загрузчик: {loader}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_pinned_versions_and_does_not_treat_disabled_loader_as_active() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.neoforged","version":"47.1.106"},{"uid":"net.minecraftforge","version":"47.3.0","disabled":true},{"uid":"org.lwjgl3","cachedVersion":"3.3.2"}]}"#).unwrap();
        assert_eq!(
            profile.summary(),
            "Minecraft: 1.20.1; загрузчик: NeoForge 47.1.106."
        );
        assert_eq!(profile.components[3].version, None);
        assert_eq!(
            profile.components[3].cached_version.as_deref(),
            Some("3.3.2")
        );
    }

    #[test]
    fn does_not_present_cached_version_as_pinned_or_hide_unknown_components() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","cachedVersion":"1.20.1"},{"uid":"example.custom","version":"1.0"}]}"#).unwrap();
        assert!(profile.summary().contains("не закреплена"));
        assert_eq!(profile.components[1].uid, "example.custom");
    }

    #[test]
    fn rejects_duplicate_or_bad_data_and_unknown_format() {
        for bytes in [
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft"},{"uid":"net.minecraft"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"../escape"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"../../bad"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","disabled":"true"}]}"#[..],
            &br#"{"formatVersion":2,"components":[]}"#[..],
        ] {
            assert!(PrismProfile::parse(bytes).is_err());
        }
        assert!(PrismProfile::parse(&vec![b' '; MAX_METADATA_BYTES + 1]).is_err());
    }

    #[test]
    fn conflicting_loaders_are_reported_not_selected() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.minecraftforge","version":"47.3.0"},{"uid":"net.neoforged","version":"47.1.106"}]}"#).unwrap();
        assert!(profile.summary().contains("несколько загрузчиков"));
    }
}
