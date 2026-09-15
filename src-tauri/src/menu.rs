//! Native application menu.
//!
//! Menu items carry the same ids as the frontend keymap actions (see
//! `src/lib/keymap.ts`); activating an item emits an `app-menu` event with
//! that id and the frontend routes it through its command bus. Accelerators
//! follow the DataGrip defaults for each platform.

use tauri::menu::{AboutMetadata, CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Wry};
use tauri_plugin_opener::OpenerExt;

pub const MENU_EVENT: &str = "app-menu";
pub const REPO_URL: &str = "https://github.com/camuig/querycraft";

const THEME_IDS: [&str; 3] = ["theme:system", "theme:light", "theme:dark"];

/// Check items of the "View → Theme" submenu, kept to reflect the current preference.
pub struct ThemeMenu {
    items: Vec<(String, CheckMenuItem<Wry>)>,
}

impl ThemeMenu {
    fn set_checked(&self, theme: &str) {
        for (id, item) in &self.items {
            let _ = item.set_checked(id == &format!("theme:{theme}"));
        }
    }
}

fn item(app: &AppHandle, id: &str, text: &str, accel: Option<&str>) -> tauri::Result<MenuItem<Wry>> {
    MenuItem::with_id(app, id, text, true, accel)
}

fn sep(app: &AppHandle) -> tauri::Result<PredefinedMenuItem<Wry>> {
    PredefinedMenuItem::separator(app)
}

/// Platform-specific accelerator: `(macOS, other)`.
fn accel(mac: &'static str, other: &'static str) -> Option<&'static str> {
    Some(if cfg!(target_os = "macos") { mac } else { other })
}

pub fn build(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let about = AboutMetadata {
        name: Some("QueryCraft".into()),
        version: Some(app.package_info().version.to_string()),
        website: Some(REPO_URL.into()),
        website_label: Some("GitHub".into()),
        ..Default::default()
    };

    let menu = Menu::new(app)?;

    #[cfg(target_os = "macos")]
    {
        let app_menu = Submenu::with_items(
            app,
            "QueryCraft",
            true,
            &[
                &PredefinedMenuItem::about(app, Some("About QueryCraft"), Some(about.clone()))?,
                &sep(app)?,
                &item(app, "openSettings", "Settings…", Some("Cmd+,"))?,
                &sep(app)?,
                &PredefinedMenuItem::services(app, None)?,
                &sep(app)?,
                &PredefinedMenuItem::hide(app, None)?,
                &PredefinedMenuItem::hide_others(app, None)?,
                &PredefinedMenuItem::show_all(app, None)?,
                &sep(app)?,
                &PredefinedMenuItem::quit(app, None)?,
            ],
        )?;
        menu.append(&app_menu)?;
    }

    let file = Submenu::new(app, "File", true)?;
    file.append_items(&[
        &item(app, "newConnection", "New Connection…", None)?,
        &item(app, "newConsole", "New Query Console", Some("Ctrl+Shift+Q"))?,
        &sep(app)?,
        &item(app, "closeTab", "Close Tab", accel("Cmd+W", "Ctrl+F4"))?,
    ])?;
    #[cfg(not(target_os = "macos"))]
    file.append_items(&[
        &sep(app)?,
        &item(app, "openSettings", "Settings…", Some("Ctrl+Alt+S"))?,
        &sep(app)?,
        &PredefinedMenuItem::quit(app, None)?,
    ])?;
    menu.append(&file)?;

    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    menu.append(&edit)?;

    let theme_items: Vec<(String, CheckMenuItem<Wry>)> = THEME_IDS
        .iter()
        .zip(["System", "Light", "Dark"])
        .map(|(id, text)| {
            CheckMenuItem::with_id(app, *id, text, true, *id == "theme:system", None::<&str>)
                .map(|i| (id.to_string(), i))
        })
        .collect::<tauri::Result<_>>()?;
    let theme = Submenu::new(app, "Theme", true)?;
    for (_, i) in &theme_items {
        theme.append(i)?;
    }
    app.manage(ThemeMenu { items: theme_items });

    let view = Submenu::new(app, "View", true)?;
    view.append_items(&[
        &theme,
        &sep(app)?,
        &item(app, "refresh", "Refresh", accel("Cmd+R", "Ctrl+F5"))?,
        &item(app, "focusExplorer", "Database Explorer", accel("Cmd+1", "Alt+1"))?,
        &sep(app)?,
        &item(app, "nextTab", "Next Tab", accel("Cmd+Shift+]", "Alt+Right"))?,
        &item(app, "prevTab", "Previous Tab", accel("Cmd+Shift+[", "Alt+Left"))?,
    ])?;
    #[cfg(target_os = "macos")]
    view.append_items(&[&sep(app)?, &PredefinedMenuItem::fullscreen(app, None)?])?;
    menu.append(&view)?;

    let run = Submenu::with_items(
        app,
        "Run",
        true,
        &[
            &item(app, "executeStatement", "Execute", Some("CmdOrCtrl+Enter"))?,
            &item(app, "executeScript", "Execute Script", Some("CmdOrCtrl+Shift+Enter"))?,
            &item(app, "cancelQuery", "Cancel Running Query", Some("CmdOrCtrl+F2"))?,
        ],
    )?;
    menu.append(&run)?;

    // Items sharing an accelerator with the editor (Cmd+Enter, Cmd+Backspace) get none here:
    // the frontend resolves those keys by context.
    let data = Submenu::with_items(
        app,
        "Data",
        true,
        &[
            &item(app, "submitChanges", "Submit Changes", None)?,
            &item(app, "revertChanges", "Revert Changes", accel("Cmd+Alt+Z", "Ctrl+Alt+Z"))?,
            &sep(app)?,
            &item(app, "addRow", "Add Row", accel("Cmd+N", "Alt+Insert"))?,
            &item(app, "deleteRow", "Delete Row", None)?,
            &item(app, "setNull", "Set NULL", accel("Cmd+Alt+N", "Ctrl+Alt+N"))?,
            &sep(app)?,
            &item(app, "prevPage", "Previous Page", accel("Cmd+Alt+Up", "Ctrl+Alt+Up"))?,
            &item(app, "nextPage", "Next Page", accel("Cmd+Alt+Down", "Ctrl+Alt+Down"))?,
        ],
    )?;
    menu.append(&data)?;

    #[cfg(target_os = "macos")]
    {
        let window = Submenu::with_items(
            app,
            "Window",
            true,
            &[
                &PredefinedMenuItem::minimize(app, None)?,
                &PredefinedMenuItem::maximize(app, None)?,
            ],
        )?;
        menu.append(&window)?;
    }

    let help = Submenu::new(app, "Help", true)?;
    help.append_items(&[
        &item(app, "help:github", "QueryCraft on GitHub", None)?,
        &item(app, "help:issue", "Report an Issue…", None)?,
    ])?;
    #[cfg(not(target_os = "macos"))]
    help.append_items(&[
        &sep(app)?,
        &PredefinedMenuItem::about(app, Some("About QueryCraft"), Some(about))?,
    ])?;
    menu.append(&help)?;

    Ok(menu)
}

pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "help:github" => {
            let _ = app.opener().open_url(REPO_URL, None::<&str>);
        }
        "help:issue" => {
            let _ = app
                .opener()
                .open_url(format!("{REPO_URL}/issues/new/choose"), None::<&str>);
        }
        _ => {
            if let Some(theme) = id.strip_prefix("theme:") {
                if let Some(menu) = app.try_state::<ThemeMenu>() {
                    menu.set_checked(theme);
                }
            }
            let _ = app.emit(MENU_EVENT, id);
        }
    }
}

/// Called by the frontend whenever the theme preference changes.
#[tauri::command]
pub fn set_theme_menu(app: AppHandle, theme: String) {
    if let Some(menu) = app.try_state::<ThemeMenu>() {
        menu.set_checked(&theme);
    }
}
