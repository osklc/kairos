use active_win_pos_rs::get_active_window;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::Serialize;
use std::time::Duration;
use chrono::{Utc, Local, Timelike};
use tauri::{Emitter, Manager};
use std::fs;

#[derive(Clone, Serialize)]
struct ActiveWindowPayload {
    title: String,
    app_name: String,
}

#[derive(Serialize)]
struct TodaySummary {
    total_screen_time_seconds: i64,
    productive_time_seconds: i64,
    break_count: i64,
    longest_session_seconds: i64,
}

#[derive(Clone, Serialize)]
struct AskCategoryPayload {
    app_name: String,
}

#[derive(Serialize)]
struct DailyStat {
    day: String,
    total_seconds: i64,
}

struct CurrentSession {
    app_name: String,
    start_time: i64,
}

fn normalize_app_name(raw_name: &str, title: &str) -> String {
    let raw_lower = raw_name.to_lowercase();
    let title_lower = title.to_lowercase();
    
    if raw_lower.contains("spotify") {
        return "Spotify".to_string();
    } else if raw_lower.contains("chrome") || raw_lower.contains("msedge") || raw_lower.contains("brave") || raw_lower.contains("firefox") {
        let base_name = if raw_lower.contains("chrome") {
            "Google Chrome"
        } else if raw_lower.contains("msedge") {
            "Microsoft Edge"
        } else if raw_lower.contains("brave") {
            "Brave Browser"
        } else {
            "Firefox"
        };
        
        if title_lower.contains("stackoverflow") || title_lower.contains("github") || title_lower.contains("university") {
            return format!("{} (Productive)", base_name);
        } else if title_lower.contains("twitch") {
            return format!("{} (Twitch)", base_name);
        } else if title_lower.contains("youtube") {
            if title_lower.contains("shorts") {
                return format!("{} (YouTube Shorts)", base_name);
            } else if title_lower.contains("ders") || title_lower.contains("eğitim") || title_lower.contains("tutorial") || title_lower.contains("software") || title_lower.contains("lecture") || title_lower.contains("üniversite") {
                return format!("{} (YouTube Edu)", base_name);
            } else {
                return format!("{} (YouTube)", base_name);
            }
        } else {
            return base_name.to_string();
        }
    } else if raw_lower.contains("code") {
        return "VS Code".to_string();
    } else if raw_lower.contains("discord") {
        return "Discord".to_string();
    } else if raw_lower.contains("slack") {
        return "Slack".to_string();
    } else if raw_lower.contains("whatsapp") {
        return "WhatsApp".to_string();
    } else if raw_lower.contains("steam") {
        return "Steam".to_string();
    } else if raw_lower.contains("notion") {
        return "Notion".to_string();
    } else if raw_lower.contains("outlook") {
        return "Outlook".to_string();
    } else if raw_lower.contains("epicgames") || raw_lower.contains("epic") {
        return "Epic Games".to_string();
    } else if raw_lower.contains("unity") {
        return "Unity".to_string();
    } else if raw_lower.contains("antigravity") {
        return "Antigravity".to_string();
    } else if raw_lower.contains("kairos") || raw_lower.contains("screen-time-tracker") {
        return "Kairos".to_string();
    } else if raw_lower.contains("searchhost") {
        return "Windows Search".to_string();
    } else if raw_lower.contains("windowsterminal") {
        return "Terminal".to_string();
    } else if raw_lower.contains("taskmgr") {
        return "Task Manager".to_string();
    } else if raw_lower.contains("idea") || title_lower.contains("intellij") {
        return "IntelliJ IDEA".to_string();
    } else if raw_lower.contains("explorer") || title_lower.contains("windows gezgini") || raw_lower.contains("gezgin") {
        return "File Explorer".to_string();
    } else if raw_lower.contains("shellhost") || raw_lower.contains("shellexperiencehost") {
        return "Windows Shell".to_string();
    }
    
    let mut cleaned = raw_name.replace(".exe", "");
    if let Some(first) = cleaned.chars().next() {
        if first.is_lowercase() {
            let mut chars = cleaned.chars();
            cleaned = format!("{}{}", chars.next().unwrap().to_uppercase(), chars.as_str());
        }
    }
    cleaned
}

fn should_ignore_window(app_name: &str, title: &str) -> bool {
    let name_lower = app_name.to_lowercase();
    let title_lower = title.to_lowercase();
    
    // Skip empty or whitespace-only names/titles
    if app_name.trim().is_empty() || title.trim().is_empty() {
        return true;
    }
    
    // Skip known transient/system windows
    let ignored_titles = [
        "bir uygulama seçin",
        "task switching",
        "task view",
        "dosya gezgini",
        "program manager",
        "windows input experience",
        "new notification",
        "start",
        "search",
        "görev görünümü",
        "başlat",
    ];
    
    let ignored_names = [
        "applicationframehost",
        "startmenuexperiencehost",
        "lockapp",
        "textinputhost",
        "searchui",
        "cortana",
        "systemsettings",
    ];
    
    for ignored in &ignored_titles {
        if title_lower == *ignored {
            return true;
        }
    }
    
    for ignored in &ignored_names {
        if name_lower.contains(ignored) {
            return true;
        }
    }
    
    false
}

fn init_db(app_handle: &tauri::AppHandle) -> SqlResult<Connection> {
    let app_data_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
    }
    
    let db_path = app_data_dir.join("tracker.db");
    let conn = Connection::open(db_path)?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY,
            app_name TEXT NOT NULL,
            start_time INTEGER NOT NULL,
            end_time INTEGER NOT NULL
        )",
        [],
    )?;
    
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_categories (
            app_name TEXT PRIMARY KEY,
            category TEXT NOT NULL
        )",
        [],
    )?;
    
    Ok(conn)
}

#[tauri::command]
fn get_today_summary(app_handle: tauri::AppHandle) -> Result<TodaySummary, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let today_start = Local::now()
        .with_hour(0).unwrap()
        .with_minute(0).unwrap()
        .with_second(0).unwrap()
        .timestamp();
    
    let mut total_stmt = conn.prepare("SELECT SUM(end_time - start_time) FROM sessions WHERE end_time >= ?1").map_err(|e| e.to_string())?;
    let total_screen_time_seconds: i64 = total_stmt.query_row([today_start], |row| row.get(0)).unwrap_or(0);
    
    let mut longest_stmt = conn.prepare("SELECT MAX(end_time - start_time) FROM sessions WHERE end_time >= ?1").map_err(|e| e.to_string())?;
    let longest_session_seconds: i64 = longest_stmt.query_row([today_start], |row| row.get(0)).unwrap_or(0);
    
    let mut prod_stmt = conn.prepare(
        "SELECT SUM(s.end_time - s.start_time) 
         FROM sessions s
         JOIN app_categories c ON s.app_name = c.app_name
         WHERE s.end_time >= ?1 AND c.category = 'productive'"
    ).map_err(|e| e.to_string())?;
    let productive_time_seconds: i64 = prod_stmt.query_row([today_start], |row| row.get(0)).unwrap_or(0);

    Ok(TodaySummary {
        total_screen_time_seconds,
        productive_time_seconds,
        break_count: 0, // Handled by separate Pomodoro logic later
        longest_session_seconds,
    })
}

#[tauri::command]
fn get_sessions(app_handle: tauri::AppHandle) -> Result<String, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare("SELECT id, app_name, start_time, end_time FROM sessions ORDER BY id DESC LIMIT 10").map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(format!(
            "ID: {}, App: {}, Start: {}, End: {}",
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?
        ))
    }).map_err(|e| e.to_string())?;
    
    let mut result = Vec::new();
    for row in rows {
        if let Ok(val) = row {
            result.push(val);
        }
    }
    
    Ok(result.join("\n"))
}

#[derive(Serialize)]
struct AppCategory {
    app_name: String,
    category: String,
}

#[tauri::command]
fn get_all_apps(app_handle: tauri::AppHandle) -> Result<Vec<AppCategory>, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "SELECT DISTINCT s.app_name, COALESCE(c.category, 'uncategorized') as category 
         FROM sessions s 
         LEFT JOIN app_categories c ON s.app_name = c.app_name 
         ORDER BY s.app_name ASC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(AppCategory {
            app_name: row.get(0)?,
            category: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut apps = Vec::new();
    for row in rows {
        if let Ok(app) = row {
            apps.push(app);
        }
    }
    
    Ok(apps)
}

#[tauri::command]
fn set_app_category(app_handle: tauri::AppHandle, app_name: String, category: String) -> Result<(), String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT OR REPLACE INTO app_categories (app_name, category) VALUES (?1, ?2)",
        params![app_name, category],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

#[derive(Serialize)]
struct AppUsage {
    app_name: String,
    duration_seconds: i64,
}

#[tauri::command]
fn get_app_usage(app_handle: tauri::AppHandle) -> Result<Vec<AppUsage>, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let today_start = Local::now()
        .with_hour(0).unwrap()
        .with_minute(0).unwrap()
        .with_second(0).unwrap()
        .timestamp();

    let mut stmt = conn.prepare(
        "SELECT app_name, SUM(end_time - start_time) as duration 
         FROM sessions 
         WHERE end_time >= ?1 
         GROUP BY app_name 
         ORDER BY duration DESC"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([today_start], |row| {
        Ok(AppUsage {
            app_name: row.get(0)?,
            duration_seconds: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut usages = Vec::new();
    for row in rows {
        if let Ok(usage) = row {
            usages.push(usage);
        }
    }
    
    Ok(usages)
}

#[tauri::command]
fn get_daily_stats(app_handle: tauri::AppHandle) -> Result<Vec<DailyStat>, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "SELECT strftime('%Y-%m-%d', datetime(start_time, 'unixepoch', 'localtime')) as day, 
         SUM(end_time - start_time) as total_duration 
         FROM sessions 
         GROUP BY day 
         ORDER BY day ASC 
         LIMIT 7"
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |row| {
        Ok(DailyStat {
            day: row.get(0)?,
            total_seconds: row.get(1)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut stats = Vec::new();
    for row in rows {
        if let Ok(stat) = row {
            stats.push(stat);
        }
    }
    Ok(stats)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let app_handle = app.handle().clone();
            
            // ── System Tray ──
            let tray_handle = app.handle().clone();
            let show_item = tauri::menu::MenuItem::with_id(app, "show", "Göster", true, None::<&str>)?;
            let quit_item = tauri::menu::MenuItem::with_id(app, "quit", "Çıkış", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&show_item, &quit_item])?;
            
            let icon = app.default_window_icon().cloned().unwrap();
            let _tray = tauri::tray::TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .tooltip("Kairos: Screen Time Tracker")
                .on_menu_event(move |app, event| {
                    match event.id().as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::DoubleClick { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // ── Close to tray instead of quitting ──
            let window = app.get_webview_window("main").unwrap();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    if let Some(win) = tray_handle.get_webview_window("main") {
                        let _ = win.hide();
                    }
                }
            });
            
            let conn = init_db(&app_handle).expect("Failed to initialize DB");
            
            std::thread::spawn(move || {
                let mut current_session: Option<CurrentSession> = None;
                
                loop {
                    let now = Utc::now().timestamp();
                    let active_window = get_active_window().ok();
                    
                    let mut changed = false;
                    let mut new_app_name = String::new();
                    
                    if let Some(window) = &active_window {
                        let raw_name = &window.app_name;
                        let raw_title = &window.title;
                        
                        if should_ignore_window(raw_name, raw_title) {
                            std::thread::sleep(std::time::Duration::from_secs(3));
                            continue;
                        }
                        
                        new_app_name = normalize_app_name(raw_name, raw_title);
                        
                        let payload = ActiveWindowPayload {
                            title: window.title.clone(),
                            app_name: new_app_name.clone(),
                        };
                        let _ = app_handle.emit("active_window", payload);
                    }
                    
                    if let Some(session) = &current_session {
                        if session.app_name != new_app_name {
                            changed = true;
                        }
                    } else if !new_app_name.is_empty() {
                        changed = true;
                    }
                    
                    if changed {
                        if let Some(session) = current_session {
                            let duration = now - session.start_time;
                            if duration >= 5 {
                                let _ = conn.execute(
                                    "INSERT INTO sessions (app_name, start_time, end_time) VALUES (?1, ?2, ?3)",
                                    params![session.app_name, session.start_time, now],
                                );
                            }
                        }
                        
                        if !new_app_name.is_empty() {
                            let count: i64 = conn.query_row(
                                "SELECT COUNT(*) FROM app_categories WHERE app_name = ?1",
                                params![&new_app_name],
                                |row| row.get(0)
                            ).unwrap_or(0);

                            if count == 0 {
                                let mut auto_category = "uncategorized";
                                let name_lower = new_app_name.to_lowercase();
                                
                                if name_lower.contains("(productive)") || name_lower.contains("(youtube edu)") || name_lower.contains("antigravity") || name_lower.contains("vs code") || name_lower.contains("intellij") || name_lower.contains("notion") || name_lower.contains("figma") || name_lower.contains("slack") || name_lower.contains("zoom") || name_lower.contains("teams") || name_lower.contains("cursor") || name_lower.contains("unity") || name_lower.contains("outlook") {
                                    auto_category = "productive";
                                } else if name_lower.contains("(twitch)") || name_lower.contains("(youtube)") || name_lower.contains("spotify") || name_lower.contains("discord") || name_lower.contains("steam") || name_lower.contains("epic") {
                                    auto_category = "distracting";
                                } else if name_lower.contains("kairos") || name_lower.contains("screen time") || name_lower.contains("brave") || name_lower.contains("chrome") || name_lower.contains("edge") || name_lower.contains("firefox") || name_lower.contains("explorer") || name_lower.contains("gezgin") || name_lower.contains("whatsapp") || name_lower.contains("search") || name_lower.contains("shell") || name_lower.contains("terminal") || name_lower.contains("task manager") {
                                    auto_category = "neutral";
                                }
                                
                                let _ = conn.execute(
                                    "INSERT INTO app_categories (app_name, category) VALUES (?1, ?2)",
                                    params![&new_app_name, auto_category]
                                );

                                if auto_category == "uncategorized" {
                                    let _ = app_handle.emit("ask_category", AskCategoryPayload { app_name: new_app_name.clone() });
                                }
                            }

                            current_session = Some(CurrentSession {
                                app_name: new_app_name,
                                start_time: now,
                            });
                        } else {
                            current_session = None;
                        }
                    }
                    
                    std::thread::sleep(Duration::from_secs(1));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, get_sessions, get_today_summary, get_all_apps, set_app_category, get_app_usage, get_daily_stats])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
