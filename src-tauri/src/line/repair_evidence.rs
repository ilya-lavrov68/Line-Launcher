//! Resolves only archive-level hints contradicted by a complete live audit.
//! Evidence must be recomputed under the instance lock, not persisted as a receipt.

pub fn unresolved_archive_hints(
    hints: &[&'static str],
    verified_client: bool,
    verified_assets: bool,
) -> Vec<&'static str> {
    hints
        .iter()
        .copied()
        .filter(|hint| match *hint {
            "client-jar" => !verified_client,
            "assets" => !verified_assets,
            _ => true,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_complete_live_evidence_removes_matching_stale_hints() {
        let hints = ["client-jar", "assets", "asset-index", "libraries"];
        assert_eq!(unresolved_archive_hints(&hints, false, false), hints);
        assert_eq!(
            unresolved_archive_hints(&hints, true, false),
            vec!["assets", "asset-index", "libraries"]
        );
        assert_eq!(
            unresolved_archive_hints(&hints, false, true),
            vec!["client-jar", "asset-index", "libraries"]
        );
        assert_eq!(
            unresolved_archive_hints(&hints, true, true),
            vec!["asset-index", "libraries"]
        );
    }

    #[test]
    fn unknown_hints_are_never_discarded() {
        assert_eq!(
            unresolved_archive_hints(&["future-part"], true, true),
            vec!["future-part"]
        );
    }
}
