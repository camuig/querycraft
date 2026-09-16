//! What the in-app updater may do with a new release on this installation.

use serde::Serialize;
use tauri::utils::config::BundleType;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateMode {
    /// The files are replaced in place; the new version starts at the next launch.
    Install,
    /// The update is an installer that closes the app, so it runs only when the user restarts.
    InstallOnRestart,
    /// Package-managed installs (deb, rpm) are not touched: the user is only told about the release.
    Notify,
}

pub fn mode_for(bundle: Option<BundleType>) -> UpdateMode {
    match bundle {
        Some(BundleType::AppImage | BundleType::App | BundleType::Dmg) => UpdateMode::Install,
        Some(BundleType::Msi | BundleType::Nsis) => UpdateMode::InstallOnRestart,
        Some(BundleType::Deb | BundleType::Rpm) | None => UpdateMode::Notify,
    }
}

#[tauri::command]
pub fn update_mode() -> UpdateMode {
    mode_for(tauri::utils::platform::bundle_type())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_bundle_types_to_modes() {
        assert_eq!(mode_for(Some(BundleType::AppImage)), UpdateMode::Install);
        assert_eq!(mode_for(Some(BundleType::App)), UpdateMode::Install);
        assert_eq!(mode_for(Some(BundleType::Nsis)), UpdateMode::InstallOnRestart);
        assert_eq!(mode_for(Some(BundleType::Msi)), UpdateMode::InstallOnRestart);
        assert_eq!(mode_for(Some(BundleType::Deb)), UpdateMode::Notify);
        assert_eq!(mode_for(Some(BundleType::Rpm)), UpdateMode::Notify);
        assert_eq!(mode_for(None), UpdateMode::Notify);
    }

    #[test]
    fn serializes_in_camel_case() {
        assert_eq!(
            serde_json::to_string(&UpdateMode::InstallOnRestart).unwrap(),
            "\"installOnRestart\""
        );
    }
}
