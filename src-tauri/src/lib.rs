mod db;

use std::sync::Mutex;

use rusqlite::Connection;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;

/// The directory Cairn keeps its files in, preferring `D:\Cairn` — the user keeps
/// data off the space-constrained C: drive. Falls back to the app data dir if that
/// location can't be created, so the app still runs on a machine without a D: drive.
fn data_dir(app: &tauri::AppHandle) -> std::path::PathBuf {
    let preferred = std::path::PathBuf::from(r"D:\Cairn");
    if std::fs::create_dir_all(&preferred).is_ok() {
        return preferred;
    }
    let fallback = app
        .path()
        .app_data_dir()
        .expect("no writable data directory available");
    let _ = std::fs::create_dir_all(&fallback);
    fallback
}

/// Open the SQLite database under [`data_dir`].
fn open_db(app: &tauri::App) -> Connection {
    let conn = Connection::open(data_dir(app.handle()).join("cairn.db"))
        .expect("failed to open database");
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
    note: String,
    path: String,
    milestones: Vec<String>,
) -> Result<db::Project, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::create_project(&conn, &title, &priority, &note, &path, &milestones).map_err(|e| e.to_string())
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
    note: String,
    path: String,
    milestones: Vec<db::MilestoneInput>,
) -> Result<db::Project, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::update_project(&conn, &id, &title, &priority, &note, &path, &milestones).map_err(|e| e.to_string())
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

#[tauri::command]
fn list_todos(state: tauri::State<'_, Mutex<Connection>>) -> Result<Vec<db::Todo>, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::list_todos(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_todo(
    state: tauri::State<'_, Mutex<Connection>>,
    text: String,
) -> Result<db::Todo, String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::create_todo(&conn, &text).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_todo_done(
    state: tauri::State<'_, Mutex<Connection>>,
    todo_id: String,
    done: bool,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::set_todo_done(&conn, &todo_id, done).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_todo(state: tauri::State<'_, Mutex<Connection>>, todo_id: String) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::delete_todo(&conn, &todo_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn reorder_todos(
    state: tauri::State<'_, Mutex<Connection>>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let conn = state.lock().map_err(|e| e.to_string())?;
    db::reorder_todos(&conn, &ordered_ids).map_err(|e| e.to_string())
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

/// The PowerShell run inside each opened tab: enable the local proxy (`px` is
/// defined in the user's Windows PowerShell profile, which loads by default) so
/// Claude can reach the API, then resume the project's most recent conversation.
/// Kept in a real `.ps1` file so the Windows Terminal command line needs no
/// semicolon escaping.
fn session_script_contents() -> &'static str {
    "px\r\nclaude --continue --dangerously-skip-permissions\r\n"
}

/// Build the Windows Terminal invocation that opens the project as a tab in a
/// single shared "Cairn" window (`-w Cairn`), starting in `path`, titled after the
/// project, and running Windows PowerShell against the session helper script. Kept
/// pure so the argument construction is unit-testable without spawning. Opening
/// several projects therefore stacks tabs in one window instead of new windows.
fn build_terminal_command(path: &str, title: &str, script_path: &str) -> (String, Vec<String>) {
    (
        "wt.exe".to_string(),
        vec![
            "-w".into(),
            "Cairn".into(),
            "new-tab".into(),
            "-d".into(),
            path.into(),
            "--title".into(),
            title.into(),
            "powershell.exe".into(),
            "-NoExit".into(),
            "-File".into(),
            script_path.into(),
        ],
    )
}

/// Open the project in a Windows Terminal tab (grouped in one window) and resume
/// its most recent Claude session. Errors if the path is empty or not an existing
/// directory — the caller disables the menu item when a project has no path, so
/// this is a backstop. Falls back to a standalone PowerShell window on machines
/// without Windows Terminal.
#[tauri::command]
fn open_in_terminal(app: tauri::AppHandle, path: String, title: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("项目未设置路径".into());
    }
    if !std::path::Path::new(&path).is_dir() {
        return Err(format!("项目路径不存在或不是目录：{path}"));
    }

    // Write the helper script next to the database so the terminal command line
    // stays free of shell escaping.
    let script_path = data_dir(&app).join("open-session.ps1");
    std::fs::write(&script_path, session_script_contents())
        .map_err(|e| format!("写入会话脚本失败：{e}"))?;
    let script_str = script_path.to_string_lossy().to_string();

    let (program, args) = build_terminal_command(&path, &title, &script_str);
    if std::process::Command::new(&program).args(&args).spawn().is_ok() {
        return Ok(());
    }

    // Fallback: no Windows Terminal — a standalone PowerShell window (each open is
    // its own window rather than a tab).
    let mut fallback = std::process::Command::new("powershell.exe");
    fallback.args(["-NoExit", "-File", &script_str]).current_dir(&path);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        fallback.creation_flags(CREATE_NEW_CONSOLE);
    }
    fallback.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
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
            open_in_terminal,
            reorder_projects,
            list_todos,
            create_todo,
            set_todo_done,
            delete_todo,
            reorder_todos
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_terminal_command_opens_grouped_wt_tab() {
        let (program, args) =
            build_terminal_command(r"D:\repos\Cairn", "Cairn", r"D:\Cairn\open-session.ps1");
        assert_eq!(program, "wt.exe");
        // Repeated opens become tabs in one named window rather than new windows.
        let w = args.iter().position(|a| a == "-w").expect("-w flag present");
        assert_eq!(args[w + 1], "Cairn");
        // A new tab, opened in the project directory, titled after the project.
        assert!(args.iter().any(|a| a == "new-tab"));
        let d = args.iter().position(|a| a == "-d").expect("-d flag present");
        assert_eq!(args[d + 1], r"D:\repos\Cairn");
        let t = args.iter().position(|a| a == "--title").expect("--title present");
        assert_eq!(args[t + 1], "Cairn");
        // Runs Windows PowerShell against the helper script and stays open after.
        assert!(args.iter().any(|a| a == "powershell.exe"));
        assert!(args.iter().any(|a| a == "-NoExit"));
        let f = args.iter().position(|a| a == "-File").expect("-File flag present");
        assert_eq!(args[f + 1], r"D:\Cairn\open-session.ps1");
    }

    #[test]
    fn session_script_enables_proxy_then_continues() {
        let s = session_script_contents();
        assert!(s.contains("px"));
        assert!(s.contains("claude --continue --dangerously-skip-permissions"));
    }
}
