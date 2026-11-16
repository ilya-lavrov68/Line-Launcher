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

/// Exact component intent from the archive, not proof that anything is installed.
/// LWJGL is retained because replacing Prism metadata with the default Mojang
/// version can silently change the instance. A future executor must resolve and
/// verify every one of these pins before it can launch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrismRequirements {
    pub minecraft: String,
    pub loader: Option<(LoaderChoice, String)>,
    pub lwjgl: Option<(String, String)>,
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

    /// Build exact, fail-closed requirements without fetching or executing code.
    /// Cached versions are not authoritative; custom patches and components
    /// cannot be silently replaced by a default runtime.
    pub fn requirements(
        &self,
        has_patches: bool,
        hint: Option<&str>,
    ) -> LineResult<PrismRequirements> {
        if has_patches {
            return Err(LineError::input("Экземпляр Prism содержит пользовательские patches; их применение пока не поддерживается."));
        }
        let mut minecraft = None;
        let mut loader = None;
        let mut lwjgl = None;
        for component in self.components.iter().filter(|c| !c.disabled) {
            let pinned = || {
                component.version.clone().ok_or_else(|| LineError::input(format!(
                "В mmc-pack.json не закреплена версия компонента {}. CachedVersion недостаточно для установки.", component.uid
            )))
            };
            match component.uid.as_str() {
                "net.minecraft" => minecraft = Some(pinned()?),
                "org.lwjgl" | "org.lwjgl3" => {
                    let value = (component.uid.clone(), pinned()?);
                    if lwjgl.replace(value).is_some() {
                        return Err(LineError::input(
                            "В экземпляре Prism указано несколько версий LWJGL.",
                        ));
                    }
                }
                _ => {
                    let kind = Self::loader(component).ok_or_else(|| LineError::input(format!(
                        "Компонент Prism {} пока не поддерживается; запуск остановлен, чтобы не пропустить его.", component.uid
                    )))?;
                    let value = (kind, pinned()?);
                    if loader.replace(value).is_some() {
                        return Err(LineError::input(
                            "В экземпляре Prism указано несколько загрузчиков.",
                        ));
                    }
                }
            }
        }
        let minecraft = minecraft.ok_or_else(|| {
            LineError::input("В mmc-pack.json отсутствует активный компонент Minecraft.")
        })?;
        if hint.is_some_and(|hint| hint.trim() != minecraft) {
            return Err(LineError::input(
                "Версия Minecraft у сервера не совпадает с закреплённой версией в mmc-pack.json.",
            ));
        }
        Ok(PrismRequirements {
            minecraft,
            loader,
            lwjgl,
        })
    }

    /// A profile's Maven coordinates must actually contain the pinned LWJGL
    /// runtime, with no conflicting version. The caller supplies both the
    /// selected profile and its inherited vanilla profile. This is an identity
    /// check only; it does not verify the downloaded jar bytes.
    pub fn verify_lwjgl<'a>(&self, libraries: impl IntoIterator<Item = &'a str>) -> LineResult<()> {
        let components: Vec<_> = self
            .components
            .iter()
            .filter(|c| !c.disabled && matches!(c.uid.as_str(), "org.lwjgl" | "org.lwjgl3"))
            .collect();
        if components.is_empty() {
            return Ok(());
        }
        if components.len() != 1 {
            return Err(LineError::input(
                "В экземпляре Prism указано несколько версий LWJGL.",
            ));
        }
        let component = components[0];
        let expected = component
            .version
            .as_deref()
            .ok_or_else(|| LineError::input("В mmc-pack.json не закреплена версия LWJGL."))?;
        let group = if component.uid == "org.lwjgl3" {
            "org.lwjgl"
        } else {
            "org.lwjgl.lwjgl"
        };
        let mut found = false;
        for name in libraries {
            let mut parts = name.split(':');
            let (Some(actual_group), Some(artifact), Some(version)) =
                (parts.next(), parts.next(), parts.next())
            else {
                continue;
            };
            if actual_group != group || !(artifact == "lwjgl" || artifact.starts_with("lwjgl-")) {
                continue;
            }
            found = true;
            if version != expected {
                return Err(LineError::input(
                    "Версия LWJGL в профиле не совпадает с mmc-pack.json.",
                ));
            }
        }
        if !found {
            return Err(LineError::input(
                "Профиль не подтверждает закреплённую версию LWJGL из mmc-pack.json.",
            ));
        }
        Ok(())
    }

    /// Ensure a Mojang-style profile describes the same pinned components as
    /// the Prism manifest. This is not proof that its libraries are complete.
    pub fn verify_profile_identity(
        &self,
        minecraft: &str,
        loader: Option<(LoaderChoice, &str)>,
        has_patches: bool,
    ) -> LineResult<()> {
        if has_patches {
            return Err(LineError::input("Экземпляр Prism содержит пользовательские patches; их применение пока не поддерживается."));
        }
        let mut selected_mc = None;
        let mut selected_loader: Option<(LoaderChoice, &str)> = None;
        for component in self.components.iter().filter(|c| !c.disabled) {
            match component.uid.as_str() {
                "net.minecraft" => {
                    selected_mc = Some(component.version.as_deref().ok_or_else(|| {
                        LineError::input("В mmc-pack.json не закреплена версия Minecraft.")
                    })?);
                }
                "org.lwjgl" | "org.lwjgl3" => {}
                _ => {
                    let kind = Self::loader(component).ok_or_else(|| LineError::input(format!(
                        "Компонент Prism {} пока не поддерживается; запуск остановлен, чтобы не пропустить его.", component.uid
                    )))?;
                    let version = component.version.as_deref().ok_or_else(|| {
                        LineError::input("В mmc-pack.json не закреплена версия загрузчика.")
                    })?;
                    if selected_loader.replace((kind, version)).is_some() {
                        return Err(LineError::input(
                            "В экземпляре Prism указано несколько загрузчиков.",
                        ));
                    }
                }
            }
        }
        if selected_mc != Some(minecraft) {
            return Err(LineError::input(
                "Версия Minecraft в профиле не совпадает с mmc-pack.json.",
            ));
        }
        let same = match (selected_loader, loader) {
            (None, None) => true,
            (Some((expected_kind, expected)), Some((actual_kind, actual)))
                if expected_kind == actual_kind =>
            {
                // Forge-family profile coordinates can prefix the Minecraft version.
                if matches!(expected_kind, LoaderChoice::Forge | LoaderChoice::NeoForge) {
                    let prefix = format!("{minecraft}-");
                    expected.strip_prefix(&prefix).unwrap_or(expected)
                        == actual.strip_prefix(&prefix).unwrap_or(actual)
                } else {
                    expected == actual
                }
            }
            _ => false,
        };
        if !same {
            return Err(LineError::input(
                "Загрузчик или его версия в профиле не совпадает с mmc-pack.json.",
            ));
        }
        Ok(())
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
    fn requirements_keep_exact_pins_and_ignore_disabled_components() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.neoforged","version":"47.1.106"},{"uid":"org.lwjgl3","version":"3.3.1"},{"uid":"net.minecraftforge","version":"47.0.0","disabled":true}]}"#).unwrap();
        let plan = profile.requirements(false, Some("1.20.1")).unwrap();
        assert_eq!(plan.minecraft, "1.20.1");
        assert_eq!(
            plan.loader,
            Some((LoaderChoice::NeoForge, "47.1.106".into()))
        );
        assert_eq!(plan.lwjgl, Some(("org.lwjgl3".into(), "3.3.1".into())));
        assert!(profile.requirements(true, None).is_err());
        assert!(profile.requirements(false, Some("1.20.2")).is_err());
    }

    #[test]
    fn requirements_reject_unpinned_unknown_and_ambiguous_components() {
        for bytes in [
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","cachedVersion":"1.20.1"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"org.lwjgl3","cachedVersion":"3.3.1"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"custom.patch","version":"1"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"org.lwjgl","version":"2"},{"uid":"org.lwjgl3","version":"3"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.fabricmc.fabric-loader","version":"1"},{"uid":"net.minecraftforge","version":"2"}]}"#[..],
            &br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1","disabled":true}]}"#[..],
        ] {
            assert!(PrismProfile::parse(bytes).unwrap().requirements(false, None).is_err());
        }
    }

    #[test]
    fn lwjgl_identity_needs_exact_evidence_and_rejects_conflicts() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"org.lwjgl3","version":"3.3.1"}]}"#).unwrap();
        assert!(profile
            .verify_lwjgl([
                "org.lwjgl:lwjgl:3.3.1",
                "org.lwjgl:lwjgl-glfw:3.3.1:natives-windows"
            ])
            .is_ok());
        assert!(profile.verify_lwjgl(["org.lwjgl:lwjgl:3.3.2"]).is_err());
        assert!(profile
            .verify_lwjgl(["org.lwjgl:lwjgl:3.3.1", "org.lwjgl:lwjgl-openal:3.3.2"])
            .is_err());
        assert!(profile.verify_lwjgl(["example:lwjgl:3.3.1"]).is_err());
        let legacy = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.6.4"},{"uid":"org.lwjgl","version":"2.9.1"}]}"#).unwrap();
        assert!(legacy.verify_lwjgl(["org.lwjgl.lwjgl:lwjgl:2.9.1"]).is_ok());
        assert!(legacy.verify_lwjgl(["org.lwjgl:lwjgl:2.9.1"]).is_err());
    }

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
    fn identity_check_refuses_mismatches_unknown_components_and_patches() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.neoforged","version":"47.1.106"},{"uid":"org.lwjgl3","version":"3.3.1"}]}"#).unwrap();
        assert!(profile
            .verify_profile_identity(
                "1.20.1",
                Some((LoaderChoice::NeoForge, "1.20.1-47.1.106")),
                false
            )
            .is_ok());
        assert!(profile
            .verify_profile_identity("1.20.1", None, false)
            .is_err());
        assert!(profile
            .verify_profile_identity("1.20.1", Some((LoaderChoice::Forge, "47.1.106")), false)
            .is_err());
        assert!(profile
            .verify_profile_identity("1.20.2", Some((LoaderChoice::NeoForge, "47.1.106")), false)
            .is_err());
        assert!(profile
            .verify_profile_identity("1.20.1", Some((LoaderChoice::NeoForge, "47.1.106")), true)
            .is_err());
        let custom = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"example.custom","version":"1.0"}]}"#).unwrap();
        assert!(custom
            .verify_profile_identity("1.20.1", None, false)
            .is_err());
        let unpinned = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","cachedVersion":"1.20.1"}]}"#).unwrap();
        assert!(unpinned
            .verify_profile_identity("1.20.1", None, false)
            .is_err());
    }

    #[test]
    fn conflicting_loaders_are_reported_not_selected() {
        let profile = PrismProfile::parse(br#"{"formatVersion":1,"components":[{"uid":"net.minecraft","version":"1.20.1"},{"uid":"net.minecraftforge","version":"47.3.0"},{"uid":"net.neoforged","version":"47.1.106"}]}"#).unwrap();
        assert!(profile.summary().contains("несколько загрузчиков"));
    }
}
