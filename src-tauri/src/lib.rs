use active_win_pos_rs::get_active_window;
use battery::{units::power::watt, Manager as BatteryManager};
use nvml_wrapper::Nvml;
use rusqlite::{params, Connection, Result as SqlResult};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use chrono::{Utc, Local, Timelike};
use sysinfo::System;
use tauri::{Emitter, Manager};
use std::fs;

#[cfg(target_os = "windows")]
use wmi::{COMLibrary, WMIConnection};

#[derive(Clone, Serialize)]
struct ActiveWindowPayload {
    title: String,
    app_name: String,
}

#[derive(Serialize)]
struct TodaySummary {
    total_screen_time_seconds: i64,
    productive_time_seconds: i64,
    distracting_time_seconds: i64,
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
    last_title: String,
    last_title_change: i64,
    short_view_count: u32,
    is_youtube: bool,
    category_override: Option<String>,
    needs_review: bool,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum PowerSmoothingMode {
    Eco,
    Balanced,
    Performance,
}

impl PowerSmoothingMode {
    fn window_seconds(self) -> u64 {
        match self {
            PowerSmoothingMode::Eco => 15 * 60,
            PowerSmoothingMode::Balanced => 5 * 60,
            PowerSmoothingMode::Performance => 60,
        }
    }

    fn label(self) -> &'static str {
        match self {
            PowerSmoothingMode::Eco => "eco",
            PowerSmoothingMode::Balanced => "balanced",
            PowerSmoothingMode::Performance => "performance",
        }
    }
}

#[derive(Clone)]
struct PowerMonitorState {
    smoothing_mode: Arc<Mutex<PowerSmoothingMode>>,
}

#[derive(Clone)]
struct PowerSample {
    ts: i64,
    watts: f64,
}

#[derive(Clone, Serialize)]
struct PowerUsagePayload {
    timestamp: i64,
    avg_watts: f64,
    instant_watts: f64,
    sample_interval_seconds: u64,
    averaging_window_seconds: u64,
    sample_count: usize,
    source: String,
    device_type: String,
    cpu_model: String,
    gpu_model: String,
    smoothing_mode: String,
}

#[cfg(target_os = "windows")]
fn detect_amd_gpu() -> Option<String> {
    use serde::Deserialize;
    
    #[derive(Deserialize, Debug, Clone)]
    #[serde(rename_all = "PascalCase")]
    #[allow(dead_code)]
    struct VideoController {
        name: String,
        adapter_compatibility: Option<String>,
    }

    let result = (|| -> Result<Option<String>, Box<dyn std::error::Error>> {
        let com_lib = COMLibrary::new()?;
        let wmi_conn = WMIConnection::new(com_lib)?;

        // Query video controllers with compatibility info to distinguish discrete vs integrated
        let results: Vec<VideoController> = wmi_conn
            .raw_query("SELECT Name, AdapterCompatibility FROM Win32_VideoController")?;

        // First pass: prefer discrete AMD/Radeon GPUs (filter out integrated)
        let mut fallback: Option<String> = None;
        for result in &results {
            let name = result.name.trim();
            if name.is_empty() || name.contains("Microsoft") || name.contains("Virtual") {
                continue;
            }
            if name.contains("AMD") || name.contains("Radeon") || name.contains("ATI") {
                // Prefer discrete: names containing "RX", "Vega", "VII", "XT" are typically discrete
                let is_discrete = name.contains("RX") || name.contains("Vega") 
                    || name.contains("VII") || name.contains("XT") || name.contains("PRO");
                if is_discrete {
                    return Ok(Some(name.to_string()));
                }
                if fallback.is_none() {
                    fallback = Some(name.to_string());
                }
            }
        }

        Ok(fallback)
    })();

    result.ok().flatten()
}

/// Read AMD GPU power via ADL2 (scans all sensor slots for any live power reading).
#[cfg(target_os = "windows")]
#[allow(dead_code)]
fn read_amd_gpu_power_adl() -> Option<f64> {
    use libloading::Library;
    use std::ffi::c_void;

    const MAX_SENSORS: usize = 256;

    #[repr(C)]
    struct ADLPMLogDataOutput {
        i_version:             i32,
        ul_active_sample_rate: u32,
        ul_last_updated:       i64,
        ul_values:             [[u32; 2]; MAX_SENSORS],
        ul_num_valid_samples:  u32,
    }

    unsafe extern "C" fn adl_malloc(size: i32) -> *mut c_void {
        let layout = std::alloc::Layout::from_size_align_unchecked(size as usize, 8);
        std::alloc::alloc(layout) as *mut c_void
    }

    unsafe {
        let lib = Library::new("atiadlxx.dll")
            .or_else(|_| Library::new("atiadlxy.dll"))
            .ok()?;

        type CreateFn       = unsafe extern "C" fn(*const c_void, i32, *mut *mut c_void) -> i32;
        type AdapterCountFn = unsafe extern "C" fn(*mut c_void, *mut i32) -> i32;
        type PMLogGetFn     = unsafe extern "C" fn(*mut c_void, i32, *mut ADLPMLogDataOutput) -> i32;
        type DestroyFn      = unsafe extern "C" fn(*mut c_void) -> i32;

        let create    = lib.get::<CreateFn>(b"ADL2_Main_Control_Create").ok()?;
        let get_count = lib.get::<AdapterCountFn>(b"ADL2_Adapter_NumberOfAdapters_Get").ok()?;
        let pmlog_get = lib.get::<PMLogGetFn>(b"ADL2_New_QueryPMLogData_Get").ok()?;
        let destroy   = lib.get::<DestroyFn>(b"ADL2_Main_Control_Destroy").ok()?;

        let mut context: *mut c_void = std::ptr::null_mut();
        if create(adl_malloc as *const c_void, 1, &mut context) != 0 { return None; }

        let mut adapter_count = 0i32;
        if get_count(context, &mut adapter_count) != 0 || adapter_count == 0 {
            destroy(context);
            return None;
        }

        // Named power sensors (index, min_plausible_W, max_plausible_W, label)
        let power_sensors: &[(usize, u32, u32, &str)] = &[
            (16, 5, 600, "SocketPower"),
            (26, 5, 600, "GfxPower"),
            (44, 5, 600, "TotalBoardPower"),
        ];

        // Scan all adapters; use adapter 0 (usually the physical GPU)
        let mut result_watts: Option<f64> = None;

        // Log all non-zero sensor values on first call only
        static ADL_SCANNED: std::sync::atomic::AtomicBool =
            std::sync::atomic::AtomicBool::new(false);
        let do_full_scan = !ADL_SCANNED.swap(true, std::sync::atomic::Ordering::Relaxed);

        'outer: for idx in 0..adapter_count.min(3) {
            let mut data: ADLPMLogDataOutput = std::mem::zeroed();
            if pmlog_get(context, idx, &mut data) != 0 { continue; }

            if do_full_scan && idx == 0 {
                eprintln!("[Kairos:ADL] Full sensor scan for adapter 0:");
                for s in 0..MAX_SENSORS {
                    let [v, sup] = data.ul_values[s];
                    if v > 0 {
                        eprintln!("  [{}] value={} supported={}", s, v, sup);
                    }
                }
            }

            for &(sensor_idx, min_w, max_w, label) in power_sensors {
                let [value, _] = data.ul_values[sensor_idx];
                if value >= min_w && value <= max_w {
                    eprintln!("[Kairos:ADL] Adapter {} sensor[{}]={} = {}W", idx, sensor_idx, label, value);
                    result_watts = Some(value as f64);
                    break 'outer;
                }
            }
        }

        destroy(context);
        result_watts
    }
}


/// Try AMD GPU power via WMI (fallback when ADL unavailable).
#[cfg(target_os = "windows")]
fn read_amd_gpu_power_wmi() -> Option<f64> {
    use serde::Deserialize;
    use std::collections::HashMap;

    // Strategy A: LibreHardwareMonitor / OpenHardwareMonitor WMI namespace
    let lhm_result = (|| -> Result<Option<f64>, Box<dyn std::error::Error>> {
        let com_lib = COMLibrary::new()?;
        let mon_conn = WMIConnection::with_namespace_path("root\\LibreHardwareMonitor", com_lib)
            .or_else(|_| WMIConnection::with_namespace_path("root\\OpenHardwareMonitor", COMLibrary::new()?))?;

        #[derive(Deserialize)]
        struct HwSensor {
            #[serde(rename = "Identifier")]
            identifier: String,
            #[serde(rename = "Value")]
            value: f64,
        }

        let sensors: Vec<HwSensor> = mon_conn
            .raw_query("SELECT Identifier, Value FROM Sensor WHERE SensorType='Power'")
            .unwrap_or_default();

        let gpu_power: f64 = sensors.iter()
            .filter(|s| s.identifier.to_lowercase().contains("gpu"))
            .map(|s| s.value)
            .sum();

        Ok(if gpu_power > 0.0 { Some(gpu_power) } else { None })
    })();

    if let Ok(Some(w)) = lhm_result {
        eprintln!("[Kairos:WMI] LibreHardwareMonitor GPU power = {:.1}W", w);
        return Some(w);
    }

    // Strategy B: WMI GPU Engine utilization counters
    // Fix: group by unique engine (LUID+engine#), SUM per-process utilizations per engine,
    // then sum across all active engines. This avoids the bug of averaging 394 rows
    // (most 0%) which always gives 0.0%.
    let wmi_result = (|| -> Result<Option<f64>, Box<dyn std::error::Error>> {
        let com_lib = COMLibrary::new()?;
        let wmi_conn = WMIConnection::new(com_lib)?;

        let rows: Vec<HashMap<String, serde_json::Value>> = wmi_conn
            .raw_query("SELECT * FROM Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine")
            .unwrap_or_default();

        if rows.is_empty() { return Ok(None); }

        let util_keys = ["UtilizationPercentage", "PercentUsage", "Utilization"];

        // Sum utilization per unique engine (luid + engine_number)
        // Row name format: pid_XXX_luid_A_B_phys_0_eng_N_engtype_TYPE
        let mut engine_sums: HashMap<String, f64> = HashMap::new();

        for row in &rows {
            let name = row.get("Name").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if !name.contains("3d") && !name.contains("compute") && !name.contains("copy") { continue; }

            // Build unique engine key from LUID + engine number
            let engine_key = {
                let parts: Vec<&str> = name.split('_').collect();
                let luid_pos  = parts.iter().position(|&p| p == "luid");
                let eng_pos   = parts.iter().position(|&p| p == "eng");
                match (luid_pos, eng_pos) {
                    (Some(l), Some(e)) => format!("{}_{}_{}",
                        parts.get(l+1).unwrap_or(&"?"),
                        parts.get(l+2).unwrap_or(&"?"),
                        parts.get(e+1).unwrap_or(&"?"),
                    ),
                    _ => name.clone(),
                }
            };

            for key in &util_keys {
                if let Some(u) = row.get(*key).and_then(|v| v.as_f64()) {
                    if u > 0.0 {
                        eprintln!("[Kairos:WMI] engine='{}' {}={:.1}%", engine_key, key, u);
                    }
                    *engine_sums.entry(engine_key.clone()).or_insert(0.0) += u;
                    break;
                }
            }
        }

        if engine_sums.is_empty() { return Ok(None); }

        // Each engine's total utilization capped at 100%, then sum all engines
        // (3D engines drive most GPU power; copy engines less so)
        let total_util: f64 = engine_sums.values()
            .map(|&v| v.min(100.0))
            .sum::<f64>()
            .min(200.0); // cap at 200% total (handles dual-engine setups)

        // Normalize to 0-100% assuming max realistic sum is ~150% for heavy workloads
        let normalized = (total_util / 150.0 * 100.0).min(100.0);

        eprintln!("[Kairos:WMI] {} unique engines, sum_util={:.1}%, normalized={:.1}%",
            engine_sums.len(), total_util, normalized);

        // RX 6700 XT TDP ~230W; scale: idle=10W, full load=220W
        let watts = 10.0 + (normalized / 100.0) * 210.0;
        eprintln!("[Kairos:WMI] estimated GPU power = {:.1}W", watts);
        Ok(Some(watts))
    })();

    wmi_result.ok().flatten()
}

#[cfg(not(target_os = "windows"))]
fn detect_amd_gpu() -> Option<String> {
    None
}

#[cfg(not(target_os = "windows"))]
fn read_amd_gpu_power_wmi() -> Option<f64> {
    None
}


fn read_system_power_watts(
    system: &mut System,
    battery_manager: Option<&mut BatteryManager>,
    nvml: Option<&Nvml>,
) -> (f64, String, String, String, String) {
    let cpu_model = system
        .cpus()
        .first()
        .map(|cpu| cpu.brand().to_string())
        .filter(|model| !model.trim().is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let mut gpu_model = "Unknown GPU".to_string();

    // Detect whether machine has a battery (Laptop) or not (Desktop).
    let mut has_battery = false;
    let mut observed_battery_watts = 0.0f64;
    let mut any_battery_reporting = false;
    if let Some(manager) = battery_manager {
        if let Ok(batteries) = manager.batteries() {
            for battery in batteries.flatten() {
                has_battery = true;
                let battery_watts = battery.energy_rate().get::<watt>().abs();
                if battery_watts.is_finite() && battery_watts > 0.0 {
                    observed_battery_watts += battery_watts as f64;
                    any_battery_reporting = true;
                }
            }
        }
    }

    // If we have a battery and it reports a discharge rate, prefer battery sensor as full-system consumption.
    if has_battery && any_battery_reporting {
        return (
            observed_battery_watts as f64,
            "battery-sensor".to_string(),
            cpu_model,
            gpu_model,
            "Laptop".to_string(),
        );
    }

    system.refresh_cpu_usage();
    let cpu_usage = system.global_cpu_info().cpu_usage() as f64;
    let estimated_cpu_watts = 4.0 + (cpu_usage.clamp(0.0, 100.0) / 100.0) * 41.0;

    eprintln!("[Kairos:DEBUG] CPU usage={:.1}% → est. CPU watts={:.1}W", cpu_usage, estimated_cpu_watts);

    let mut total_watts = estimated_cpu_watts;
    let mut source = String::from("cpu-estimated");

    // Try NVIDIA GPU first
    if let Some(nvml_api) = nvml {
        if let Ok(device_count) = nvml_api.device_count() {
            let mut total_gpu_watts = 0.0;
            for idx in 0..device_count {
                if let Ok(device) = nvml_api.device_by_index(idx) {
                    if gpu_model == "Unknown GPU" {
                        if let Ok(name) = device.name() {
                            if !name.trim().is_empty() {
                                gpu_model = name;
                            }
                        }
                    }
                    if let Ok(power_mw) = device.power_usage() {
                        total_gpu_watts += power_mw as f64 / 1000.0;
                    }
                }
            }

            if total_gpu_watts > 0.0 {
                eprintln!("[Kairos:DEBUG] NVIDIA GPU ({}) = {:.1}W (NVML)", gpu_model, total_gpu_watts);
                total_watts += total_gpu_watts;
                source.push_str("+gpu-nvml");
            }
        }
    }

    // Try AMD GPU if NVIDIA not found
    if gpu_model == "Unknown GPU" {
        if let Some(amd_gpu) = detect_amd_gpu() {
            gpu_model = amd_gpu;

            // Priority 1: ADL2 direct (same source as Radeon Software)
            let adl_result = read_amd_gpu_power_adl();
            eprintln!("[Kairos:DEBUG] ADL2 result for {} = {:?}", gpu_model,
                adl_result.map(|w| format!("{:.1}W", w)));

            // Priority 2: WMI fallback
            let wmi_result = if adl_result.is_none() {
                let w = read_amd_gpu_power_wmi();
                eprintln!("[Kairos:DEBUG] WMI fallback result = {:?}",
                    w.map(|v| format!("{:.1}W", v)));
                w
            } else { None };

            let (gpu_power, suffix) = if let Some(w) = adl_result {
                (w, "+gpu-adl")
            } else if let Some(w) = wmi_result {
                (w, "+gpu-amd-wmi")
            } else {
                eprintln!("[Kairos:DEBUG] AMD GPU: all sensor methods failed, using 20W estimate");
                (20.0, "+gpu-amd-est")
            };

            eprintln!("[Kairos:DEBUG] AMD GPU ({}) = {:.1}W (source={})", gpu_model, gpu_power, suffix);
            total_watts += gpu_power;
            if source.contains("cpu-estimated") {
                source = format!("cpu-estimated{}", suffix);
            } else {
                source.push_str(suffix);
            }
        } else {
            eprintln!("[Kairos:DEBUG] No AMD GPU detected by WMI");
        }
    }

    // Add base system power draw for desktop components (PSU, motherboard, drives, etc.)
    let base_draw = 30.0_f64;
    total_watts += base_draw;

    eprintln!("[Kairos:DEBUG] Base draw = {:.1}W | TOTAL = {:.1}W (source={})",
        base_draw, total_watts, source);

    // Determine device type: if battery exists but never reports discharge (likely always on AC/full), treat as Desktop
    let device_type = if has_battery && !any_battery_reporting { "Desktop" } else if has_battery { "Laptop" } else { "Desktop" };

    (total_watts.max(0.0), source, cpu_model, gpu_model, device_type.to_string())
}

fn spawn_power_emitter(app_handle: tauri::AppHandle, power_state: PowerMonitorState) {
    tauri::async_runtime::spawn(async move {
        let mut system = System::new_all();

        let sample_interval_seconds = 10u64;
        let mut samples: VecDeque<PowerSample> = VecDeque::new();

        // Initialize NVML once and reuse across all iterations
        let nvml = match Nvml::init() {
            Ok(n) => {
                eprintln!("[Kairos] NVML initialized successfully");
                Some(n)
            }
            Err(e) => {
                eprintln!("[Kairos] NVML init failed (no NVIDIA GPU or driver issue): {}", e);
                None
            }
        };

        loop {
            let should_collect = app_handle
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(true);

            if !should_collect {
                tokio::time::sleep(Duration::from_secs(sample_interval_seconds)).await;
                continue;
            }

            let now = Utc::now().timestamp();
            let (watts, source, cpu_model, gpu_model, device_type) = {
                let mut battery_manager = BatteryManager::new().ok();
                read_system_power_watts(&mut system, battery_manager.as_mut(), nvml.as_ref())
            };

            samples.push_back(PowerSample { ts: now, watts });

            let smoothing_mode = power_state
                .smoothing_mode
                .lock()
                .map(|v| *v)
                .unwrap_or(PowerSmoothingMode::Balanced);

            let averaging_window_seconds = smoothing_mode.window_seconds();

            while let Some(front) = samples.front() {
                if now - front.ts > averaging_window_seconds as i64 {
                    let _ = samples.pop_front();
                } else {
                    break;
                }
            }

            let avg_watts = if samples.is_empty() {
                0.0
            } else {
                samples.iter().map(|sample| sample.watts).sum::<f64>() / samples.len() as f64
            };

            let payload = PowerUsagePayload {
                timestamp: now,
                avg_watts,
                instant_watts: watts,
                sample_interval_seconds,
                averaging_window_seconds,
                sample_count: samples.len(),
                source,
                device_type,
                cpu_model,
                gpu_model,
                smoothing_mode: smoothing_mode.label().to_string(),
            };

            let _ = app_handle.emit("power_usage_avg", payload);
            tokio::time::sleep(Duration::from_secs(sample_interval_seconds)).await;
        }
    });
}

#[tauri::command]
fn set_power_smoothing_mode(state: tauri::State<PowerMonitorState>, mode: PowerSmoothingMode) -> Result<(), String> {
    let mut guard = state
        .smoothing_mode
        .lock()
        .map_err(|_| "Failed to lock power monitor settings".to_string())?;
    *guard = mode;
    Ok(())
}

#[tauri::command]
fn get_power_smoothing_mode(state: tauri::State<PowerMonitorState>) -> Result<PowerSmoothingMode, String> {
    let guard = state
        .smoothing_mode
        .lock()
        .map_err(|_| "Failed to lock power monitor settings".to_string())?;
    Ok(*guard)
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
        
        if title_lower.contains("stackoverflow") {
            return format!("{} (StackOverflow)", base_name);
        } else if title_lower.contains("github") {
            return format!("{} (GitHub)", base_name);
        } else if let Some(site) = ["chatgpt", "claude", "gemini", "perplexity", "deepseek", "scholar", "jstor", "dergipark"]
           .iter().find(|&&k| title_lower.contains(k)) {
            let site_name = match *site {
                "chatgpt" => "ChatGPT",
                "scholar" => "Google Scholar",
                "dergipark" => "DergiPark",
                s => &format!("{}{}", &s[..1].to_uppercase(), &s[1..]),
            };
            return format!("{} ({})", base_name, site_name);
        } else if let Some(site) = ["instagram", "facebook", "twitter", "x.com", "tiktok", "reddit", "twitch"]
           .iter().find(|&&k| title_lower.contains(k)) {
            let site_name = match *site {
                "x.com" => "Twitter",
                "twitter" => "Twitter",
                "tiktok" => "TikTok",
                s => &format!("{}{}", &s[..1].to_uppercase(), &s[1..]),
            };
            return format!("{} ({})", base_name, site_name);
        } else if title_lower.contains("youtube") {
            let is_productive = ["ders", "eğitim", "tutorial", "course", "lecture", "konu anlatımı", "nasıl yapılır", "belgesel", "coding"]
                .iter().any(|&k| title_lower.contains(k));
                
            let is_distracting = ["shorts", "gameplay", "komik", "parodi", "müzik", "official video", "trailer", "twitch"]
                .iter().any(|&k| title_lower.contains(k));

            if is_productive {
                return format!("{} (YouTube Productive)", base_name);
            } else if is_distracting {
                return format!("{} (YouTube Distracting)", base_name);
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
    } else if raw_lower.contains("antigravity") || raw_lower.contains("cursor") {
        return "Antigravity".to_string();
    } else if raw_lower.contains("obsidian") {
        return "Obsidian".to_string();
    } else if raw_lower.contains("evernote") {
        return "Evernote".to_string();
    } else if raw_lower.contains("onenote") {
        return "OneNote".to_string();
    } else if raw_lower.contains("acrobat") || raw_lower.contains("reader") || title_lower.contains(".pdf") {
        return "Adobe Acrobat".to_string();
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
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN category_override TEXT", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN needs_review BOOLEAN DEFAULT 0", []);
    let _ = conn.execute("ALTER TABLE sessions ADD COLUMN window_title TEXT", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
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
         LEFT JOIN app_categories c ON s.app_name = c.app_name
         WHERE s.end_time >= ?1 AND COALESCE(s.category_override, c.category) = 'productive'"
    ).map_err(|e| e.to_string())?;
    let productive_time_seconds: i64 = prod_stmt.query_row([today_start], |row| row.get(0)).unwrap_or(0);

    let mut dist_stmt = conn.prepare(
        "SELECT SUM(s.end_time - s.start_time) 
         FROM sessions s
         LEFT JOIN app_categories c ON s.app_name = c.app_name
         WHERE s.end_time >= ?1 AND COALESCE(s.category_override, c.category) = 'distracting'"
    ).map_err(|e| e.to_string())?;
    let distracting_time_seconds: i64 = dist_stmt.query_row([today_start], |row| row.get(0)).unwrap_or(0);

    Ok(TodaySummary {
        total_screen_time_seconds,
        productive_time_seconds,
        distracting_time_seconds,
        break_count: 0, // Handled by separate Pomodoro logic later
        longest_session_seconds,
    })
}

#[derive(Serialize)]
struct PendingReview {
    id: i64,
    app_name: String,
    window_title: Option<String>,
    duration_seconds: i64,
}

#[tauri::command]
fn get_pending_reviews(app_handle: tauri::AppHandle) -> Result<Vec<PendingReview>, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    
    let mut stmt = conn.prepare("SELECT id, app_name, window_title, (end_time - start_time) as duration FROM sessions WHERE needs_review = 1 ORDER BY id DESC").map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map([], |row| {
        Ok(PendingReview {
            id: row.get(0)?,
            app_name: row.get(1)?,
            window_title: row.get(2)?,
            duration_seconds: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;
    
    let mut reviews = Vec::new();
    for row in rows {
        if let Ok(val) = row {
            reviews.push(val);
        }
    }
    
    Ok(reviews)
}

#[tauri::command]
fn resolve_review(app_handle: tauri::AppHandle, id: i64, category: String) -> Result<(), String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    
    conn.execute(
        "UPDATE sessions SET category_override = ?1, needs_review = 0 WHERE id = ?2",
        params![category, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
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
         HAVING duration >= 60
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

#[tauri::command]
fn get_setting(app_handle: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    let result: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .ok();
    Ok(result)
}

#[tauri::command]
fn set_setting(app_handle: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    let db_path = app_handle.path().app_data_dir().unwrap().join("tracker.db");
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_audio_file(app_handle: tauri::AppHandle, filename: String) -> Result<Vec<u8>, String> {
    use std::path::PathBuf;

    // Sanitize filename to prevent path traversal
    let safe_name = PathBuf::from(&filename)
        .file_name()
        .ok_or("Invalid filename")?
        .to_string_lossy()
        .to_string();

    // 1. Try resource dir (production bundle)
    if let Ok(resource_dir) = app_handle.path().resource_dir() {
        let p = resource_dir.join("assets").join("sounds").join(&safe_name);
        if p.exists() {
            return fs::read(&p).map_err(|e| e.to_string());
        }
        // Some Tauri versions flatten resources — try directly under resource_dir
        let p2 = resource_dir.join(&safe_name);
        if p2.exists() {
            return fs::read(&p2).map_err(|e| e.to_string());
        }
    }

    // 2. Dev mode: look relative to the crate's source directory
    let manifest_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
    let dev_path = manifest_dir.join("assets").join("sounds").join(&safe_name);
    if dev_path.exists() {
        return fs::read(&dev_path).map_err(|e| e.to_string());
    }

    Err(format!("Audio file not found: {}", safe_name))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(PowerMonitorState {
            smoothing_mode: Arc::new(Mutex::new(PowerSmoothingMode::Balanced)),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .setup(|app| {
            let app_handle = app.handle().clone();
            let power_state = app.state::<PowerMonitorState>().inner().clone();
            
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

            // Emit normalized power telemetry every 10 seconds while main window is visible.
            spawn_power_emitter(app_handle.clone(), power_state);
            
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
                    
                    if let Some(session) = &mut current_session {
                        if session.app_name != new_app_name {
                            changed = true;
                        } else if let Some(window) = &active_window {
                            if session.is_youtube && session.last_title != window.title {
                                let time_spent = now - session.last_title_change;
                                if time_spent < 60 {
                                    session.short_view_count += 1;
                                } else if session.short_view_count > 0 {
                                    session.short_view_count -= 1;
                                }
                                
                                if session.short_view_count >= 3 {
                                    session.category_override = Some("distracting".to_string());
                                }
                                
                                session.last_title = window.title.clone();
                                session.last_title_change = now;
                            }
                        }
                    } else if !new_app_name.is_empty() {
                        changed = true;
                    }
                    
                    if changed {
                        if let Some(mut session) = current_session.take() {
                            let duration = now - session.start_time;
                            if duration >= 5 {
                                if session.is_youtube && session.category_override.is_none() && duration > 120 {
                                    if session.app_name.ends_with("(YouTube)") {
                                        session.category_override = Some("neutral".to_string());
                                        session.needs_review = true;
                                    }
                                }

                                let _ = conn.execute(
                                    "INSERT INTO sessions (app_name, start_time, end_time, window_title, category_override, needs_review) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                                    params![session.app_name, session.start_time, now, session.last_title, session.category_override, session.needs_review],
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
                                
                                if name_lower.contains("(productive)") || name_lower.contains("(youtube edu)") || name_lower.contains("antigravity") || name_lower.contains("vs code") || name_lower.contains("intellij") || name_lower.contains("notion") || name_lower.contains("figma") || name_lower.contains("slack") || name_lower.contains("zoom") || name_lower.contains("teams") || name_lower.contains("cursor") || name_lower.contains("unity") || name_lower.contains("outlook") || name_lower.contains("chatgpt") || name_lower.contains("claude") || name_lower.contains("gemini") || name_lower.contains("perplexity") || name_lower.contains("deepseek") || name_lower.contains("obsidian") || name_lower.contains("evernote") || name_lower.contains("onenote") || name_lower.contains("scholar") || name_lower.contains("jstor") || name_lower.contains("dergipark") || name_lower.contains("pdf") || name_lower.contains("acrobat") {
                                    auto_category = "productive";
                                } else if name_lower.contains("(distracting)") || name_lower.contains("(twitch)") || name_lower.contains("(youtube shorts)") || name_lower.contains("(youtube distracting)") || name_lower.contains("spotify") || name_lower.contains("discord") || name_lower.contains("steam") || name_lower.contains("epic") || name_lower.contains("instagram") || name_lower.contains("facebook") || name_lower.contains("twitter") || name_lower.contains("tiktok") || name_lower.contains("reddit") {
                                    auto_category = "distracting";
                                } else if name_lower.contains("kairos") || name_lower.contains("screen time") || name_lower.contains("brave") || name_lower.contains("chrome") || name_lower.contains("edge") || name_lower.contains("firefox") || name_lower.contains("explorer") || name_lower.contains("gezgin") || name_lower.contains("whatsapp") || name_lower.contains("search") || name_lower.contains("shell") || name_lower.contains("terminal") || name_lower.contains("task manager") || name_lower.contains("(youtube)") {
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
                                is_youtube: new_app_name.to_lowercase().contains("youtube"),
                                app_name: new_app_name,
                                start_time: now,
                                last_title: active_window.as_ref().map(|w| w.title.clone()).unwrap_or_default(),
                                last_title_change: now,
                                short_view_count: 0,
                                category_override: None,
                                needs_review: false,
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
        .invoke_handler(tauri::generate_handler![greet, get_sessions, get_today_summary, get_all_apps, set_app_category, get_app_usage, get_daily_stats, get_pending_reviews, resolve_review, get_setting, set_setting, get_audio_file, set_power_smoothing_mode, get_power_smoothing_mode])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
