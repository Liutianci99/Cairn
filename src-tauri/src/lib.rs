mod db;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;

/// Open the SQLite database, preferring `D:\Cairn\cairn.db` — the user keeps data
/// off the space-constrained C: drive. Falls back to the app data dir if that
/// location can't be created, so the app still runs on a machine without a D: drive.
fn open_db(app: &tauri::App) -> Connection {
    let preferred = std::path::PathBuf::from(r"D:\Cairn");
    let dir = if std::fs::create_dir_all(&preferred).is_ok() {
        preferred
    } else {
        let fallback = app
            .path()
            .app_data_dir()
            .expect("no writable data directory available");
        let _ = std::fs::create_dir_all(&fallback);
        fallback
    };
    let conn = Connection::open(dir.join("cairn.db")).expect("failed to open database");
    db::init_schema(&conn).expect("failed to initialize database schema");
    conn
}

#[tauri::command]
fn list_projects(state: tauri::State<'_, Mutex<Connection>>) -> Result<Vec<db::Project>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::list_projects(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_project(
    state: tauri::State<'_, Mutex<Connection>>,
    title: String,
    priority: String,
    milestones: Vec<String>,
) -> Result<db::Project, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::create_project(&conn, &title, &priority, &milestones).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_milestone_done(
    state: tauri::State<'_, Mutex<Connection>>,
    milestone_id: String,
    done: bool,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::set_milestone_done(&conn, &milestone_id, done).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_project(
    state: tauri::State<'_, Mutex<Connection>>,
    id: String,
    title: String,
    priority: String,
    milestones: Vec<db::MilestoneInput>,
) -> Result<db::Project, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::update_project(&conn, &id, &title, &priority, &milestones).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_project(state: tauri::State<'_, Mutex<Connection>>, id: String) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::delete_project(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn reorder_projects(
    state: tauri::State<'_, Mutex<Connection>>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::reorder_projects(&conn, &ordered_ids).map_err(|e| e.to_string())
}

/// Pin the window to the desktop bottom layer (never above other windows). When
/// `pinned`, the window is non-activating and sits at the bottom of the z-order;
/// when not, it can come forward and take keyboard focus (needed to type in the
/// edit dialog).
#[cfg(target_os = "windows")]
fn set_desktop_pinned(window: &tauri::WebviewWindow, pinned: bool) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, SetWindowPos, GWL_EXSTYLE, HWND_BOTTOM, HWND_TOP,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, WS_EX_NOACTIVATE,
    };
    let raw = match window.hwnd() {
        Ok(h) => h,
        Err(_) => return,
    };
    let hwnd: HWND = raw.0 as _;
    unsafe {
        let mut ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if pinned {
            ex |= WS_EX_NOACTIVATE as isize;
        } else {
            ex &= !(WS_EX_NOACTIVATE as isize);
        }
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
        let after = if pinned { HWND_BOTTOM } else { HWND_TOP };
        SetWindowPos(hwnd, after, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }
}

/// Toggle the window between desktop-pinned (idle) and forward+focusable (while
/// the create/edit dialog is open so its text fields can receive keystrokes).
#[tauri::command]
fn set_editing(window: tauri::WebviewWindow, editing: bool) {
    #[cfg(target_os = "windows")]
    {
        set_desktop_pinned(&window, !editing);
        if editing {
            let _ = window.set_focus();
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (window, editing);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            list_projects,
            create_project,
            set_milestone_done,
            update_project,
            delete_project,
            set_editing,
            reorder_projects
        ])
        .setup(|app| {
            // Open the local SQLite database and hand it to Tauri's managed state
            // so commands can borrow a shared connection.
            app.manage(Mutex::new(open_db(app)));

            // Launch on login. Only the release build self-registers, so running
            // `tauri dev` never pollutes the startup list with the debug exe.
            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            // System tray icon. Cairn is a desktop widget: the window is always
            // shown while running, so the tray exists only to quit. Right-click
            // opens a single "退出" item; left-click does nothing.
            let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_i])?;
            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Cairn")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
                })
                .build(app)?;

            let window = app.get_webview_window("main").unwrap();

            // NB: no acrylic/mica here. The glass look is painted entirely in CSS
            // (see .backdrop), so a window material would only show as a grey ring
            // in the corner gap between the window's ~8px system rounding and the
            // 28px CSS radius. The transparent window lets the CSS shape stand on
            // its own.

            // Pin to the top-right corner of the primary monitor with a margin.
            if let Ok(Some(monitor)) = window.current_monitor() {
                let screen = monitor.size();
                if let Ok(win) = window.outer_size() {
                    let margin = (24.0 * monitor.scale_factor()) as i32;
                    let x = screen.width as i32 - win.width as i32 - margin;
                    let y = margin;
                    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
                }
            }

            // Desktop widget: sit at the bottom of the z-order, never covering
            // other windows. The edit dialog temporarily lifts it via set_editing.
            #[cfg(target_os = "windows")]
            set_desktop_pinned(&window, true);

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
