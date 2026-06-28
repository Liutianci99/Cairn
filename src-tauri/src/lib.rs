use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager,
};
use tauri_plugin_autostart::MacosLauncher;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
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

            // Dark acrylic frosted glass — frosts the real desktop behind the window.
            #[cfg(target_os = "windows")]
            {
                use window_vibrancy::apply_acrylic;
                let _ = apply_acrylic(&window, Some((10, 12, 20, 120)));
            }

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

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
