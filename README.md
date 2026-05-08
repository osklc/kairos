[English](README.md) | [Türkçe](README.tr.md)

<div align="center">

<img src="docs/screenshots/hero.jpeg" alt="Kairos: Screen Time Tracker" width="800"/>

# Kairos: Screen Time Tracker

**Know where your time goes. Take it back.**

![GitHub Release](https://img.shields.io/github/v/release/osklc/kairos?include_prereleases&style=flat-square&color=blue)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D4?style=flat-square&logo=windows)](https://github.com/osklc/kairos/releases)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-FFC131?style=flat-square&logo=tauri)](https://tauri.app)
[![Rust](https://img.shields.io/badge/backend-Rust-CE422B?style=flat-square&logo=rust)](https://www.rust-lang.org)
[![License: GPL v3](https://img.shields.io/badge/license-GPL%20v3-green?style=flat-square)](LICENSE)

[⬇ Download for Windows](https://github.com/osklc/kairos/releases/latest)&nbsp;&nbsp;·&nbsp;&nbsp;[Releases](https://github.com/osklc/kairos/releases)&nbsp;&nbsp;·&nbsp;&nbsp;[Report Bug](https://github.com/osklc/kairos/issues)

</div>

---

## Contents

- [What is Kairos?](#what-is-kairos)
- [✨ Features](#-features)
- [📸 Screenshots](#-screenshots)
    - [🏠 Overview](#-overview)
    - [🔔 Smart App Categorisation](#-smart-app-categorisation)
    - [📱 App Usage](#-app-usage)
    - [📊 Daily Charts](#-daily-charts)
    - [⚡ Electricity Usage](#-electricity-usage)
    - [🍅 Pomodoro Timer](#-pomodoro-timer)
    - [🎵 Focus Sounds](#-focus-sounds)
    - [✅ To-Do List](#-to-do-list)
    - [🎨 Themes](#-themes)
- [🎬 Demo Video](#-demo-video)
- [🏗️ Architecture](#-architecture)
    - [Key Design Decisions](#key-design-decisions)
    - [Tech Stack](#tech-stack)
- [⚙️ Installation](#-installation)
    - [Option 1 — Download the Installer (Recommended)](#option-1--download-the-installer-recommended)
    - [Option 2 — Build from Source](#option-2--build-from-source)
- [🛠️ Configuration](#-configuration)
- [🗺️ Roadmap](#-roadmap)
- [🤝 Contributing](#-contributing)
- [📄 License](#-license)

## What is Kairos?

Kairos is a **lightweight, privacy-first screen time tracker** for Windows that runs silently in your system tray and tells you exactly where your attention went throughout the day — broken down by app, website, and category.

Unlike cloud-based alternatives, **all data stays on your machine** in a local SQLite database. There are no subscriptions, no accounts, and no telemetry. Kairos also goes beyond simple time tracking by integrating a **Pomodoro timer**, **ambient focus sounds**, a **to-do list**, and a **live electricity usage monitor** so you can see the environmental and financial cost of your screen time.

---


## ✨ Features

| Feature | Description |
|---|---|
| 🪟 **Automatic App Tracking** | Silently detects your active window every second — no manual input required |
| 🧠 **Smart Classification** | Automatically categorises apps as Productive, Neutral, or Distracting |
| 🌐 **Browser-Level Granularity** | Distinguishes `Chrome (GitHub)` from `Chrome (YouTube)` |
| ⚡ **Live Electricity Monitor** | Real-time system watt draw from GPU/CPU sensors or battery telemetry |
| 📊 **Daily Charts** | 7-day screen time bar chart, energy consumption chart, and category pie chart |
| 🍅 **Pomodoro Timer** | Built-in focus timer with animated ring, configurable intervals, and break tracking |
| 🎵 **Focus Sounds** | Ambient soundscapes (rain, forest, white noise) with a live audio visualiser |
| ✅ **To-Do List** | Persistent task list that lives alongside your stats |
| 🎨 **7 Themes** | Hegemon Classic, Black, Midnight, Nord, Cyberpunk, Rose Pine, Forest |
| 🌍 **Bilingual** | Full English and Turkish interface |
| 🚀 **Runs on Startup** | Optional autostart — always tracking, always in the background |
| 🔒 **100% Local** | No cloud, no accounts, no data leaves your machine |

---

## 📸 Screenshots

### 🏠 Overview
> At a glance: active window, total screen time, productive vs. distracting split, break count, and longest session.

<img src="docs/screenshots/overview.png" alt="Overview page" width="760"/>

---

### 🔔 Smart App Categorisation
> When Kairos detects an unknown application for the first time, it asks you to categorise it. Your choice is saved permanently and applied to all future sessions.

<video src="https://github.com/user-attachments/assets/1cb44252-4027-4bbb-abe2-e036ccc4b828" controls muted loop autoplay style="max-width: 100%; height: auto;"></video>

---

### 📱 App Usage
> A ranked list of every application you used today, with time spent and colour-coded category badges.

<img src="docs/screenshots/app-usage.png" alt="App usage list" width="760"/>

---

### 📊 Daily Charts
> Three charts in one view: your 7-day screen time history (bar), daily energy consumption (bar), and today's productive/distracting/neutral time split (pie).

<img src="docs/screenshots/daily-charts.png" alt="Daily charts" width="760"/>

---

### ⚡ Electricity Usage
> Live system power draw updated every 10 seconds. Kairos automatically picks the most accurate source — battery telemetry on laptops, NVML/ADL sensor on desktops — and shows cumulative kWh consumed today.

<video src="https://github.com/user-attachments/assets/b56aa050-e2e9-4450-bceb-989fe5a1b160" controls muted loop autoplay style="max-width: 100%; height: auto;"></video>

---

### 🍅 Pomodoro Timer
> A clean circular countdown with automatic focus → short break → long break cycling. Today's completed sessions and total focus time are tracked automatically.

<video src="https://github.com/user-attachments/assets/6214010d-d962-4443-aad0-7a0174c980dd" controls muted loop autoplay style="max-width: 100%; height: auto;"></video>

---

### 🎵 Focus Sounds
> Three layered ambient soundscapes — **Pluvia** (rain), **Silva** (forest), **Focus Static** (white noise) — each with independent volume control and a live canvas audio visualiser.

<video src="https://github.com/user-attachments/assets/07b5f763-4c62-453d-93ca-83487076392c" controls loop autoplay style="max-width: 100%; height: auto;"></video>

---

### ✅ To-Do List
> Keep your day organized with a built-in task list for quick reminders, follow-ups, and focus goals — all stored locally alongside your screen time data.

<img src="docs/screenshots/to-do.png" alt="To-do list" width="760"/>

---

### 🎨 Themes
> Switch instantly between 7 hand-crafted themes. Your selection persists across restarts.

<video src="https://github.com/user-attachments/assets/7fc48e66-c60b-4fa8-942e-74cebece5c0a" controls muted loop autoplay style="max-width: 100%; height: auto;"></video>

---

## 🎬 Demo Video

> *(Coming soon — a 3-minute walkthrough of all features)*

<!-- Replace the link below once the video is uploaded -->
[![Watch the demo](docs/screenshots/hero.jpeg)](https://github.com/osklc/kairos/releases)

---

## 🏗️ Architecture

Kairos is a **Tauri 2** application: a Rust backend exposed to a Vanilla JS frontend over a zero-overhead IPC bridge. Everything runs as a single native binary with an embedded WebView — no Electron, no Node.js runtime.

### Key Design Decisions

- **Session flushing every ≥5 s** — the tracker thread writes `UPDATE sessions SET end_time = now` on every tick for the current session. This means category changes made mid-session take effect immediately in charts, with no stale data.
- **YouTube intelligence** — browser sessions containing YouTube are further classified by title keywords. Educational content (`tutorial`, `lecture`, `coding`, …) → `Productive`; entertainment (`shorts`, `gameplay`, `trailer`, …) → `Distracting`; ambiguous content after 2 minutes → flagged for review.
- **Power source hierarchy** — battery discharge rate (laptop) → NVML (NVIDIA GPU) → ADL2 (AMD GPU, `atiadlxx.dll`) → LibreHardwareMonitor WMI → WMI GPU engine utilisation → CPU % × TDP estimate + 30 W base draw. The smoothing ring buffer prevents spikes from misleading averages.
- **Close-to-tray** — the `CloseRequested` window event is intercepted; the window hides rather than quits, so tracking is never interrupted by accidentally closing the window.

### Tech Stack

| Layer | Technology |
|---|---|
| App framework | [Tauri 2](https://tauri.app) |
| Backend language | Rust (edition 2021) |
| Database | SQLite via `rusqlite` (bundled, no install needed) |
| Window detection | `active-win-pos-rs` |
| System info | `sysinfo` |
| Battery | `battery` |
| NVIDIA GPU | `nvml-wrapper` |
| AMD GPU | `libloading` (ADL2 / `atiadlxx.dll`), `wmi` |
| Async runtime | `tokio` |
| Frontend charting | [Chart.js](https://www.chartjs.org) |
| Fonts | [Cinzel](https://fonts.google.com/specimen/Cinzel) + [Inter](https://fonts.google.com/specimen/Inter) |

---

## ⚙️ Installation

### Option 1 — Download the Installer (Recommended)

1. Go to the [**Releases**](https://github.com/osklc/kairos/releases/latest) page.
2. Download `Kairos_x.x.x_x64-setup.exe`.
3. Run the installer — Windows SmartScreen may warn you since the binary is unsigned; click **More info → Run anyway**.
> **Note on Windows Security:** Since this is an independent open-source project and not digitally signed with a paid certificate, Windows SmartScreen may show a warning. You can proceed by clicking **More info** and **Run anyway**. The code is fully open‑source for your audit.
4. Kairos starts tracking immediately and appears in your system tray.

> **[⬇ Download latest release](https://github.com/osklc/kairos/releases/download/v1.1.0/Kairos_1.1.0_x64_en-US.msi)**

---

### Option 2 — Build from Source

#### Prerequisites

| Tool | Version | Install |
|---|---|---|
| Rust | ≥ 1.78 | [rustup.rs](https://rustup.rs) |
| Node.js | ≥ 18 | [nodejs.org](https://nodejs.org) |
| WebView2 | latest | Pre-installed on Windows 11; [download for Win 10](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) |

#### Steps

```powershell
# 1. Clone the repository
git clone https://github.com/osklc/kairos.git
cd kairos

# 2. Install Tauri CLI
npm install

# 3. Run in development mode (hot-reload)
npm run tauri dev

# 4. Build a production installer
npm run tauri build
# Output: src-tauri/target/release/bundle/nsis/Kairos_x.x.x_x64-setup.exe
```

> **Note:** On first build, Cargo will compile ~200 crates which may take 5–10 minutes. Subsequent builds are incremental.

#### AMD GPU Power Reading (optional)

Kairos reads AMD GPU power via the **ADL2** interface (`atiadlxx.dll`), which ships with AMD Radeon Software. If you do not have Radeon Software installed, Kairos automatically falls back to WMI-based GPU utilisation estimation — no manual configuration needed.

---

## 🛠️ Configuration

All settings are stored in the application's data directory:

```
%APPDATA%\com.osklc.kairos\
  tracker.db       ← SQLite database (sessions, categories, settings)
```

You can manage everything from the **Settings** page inside the app:

| Setting | Description |
|---|---|
| **Theme** | Choose from 7 built-in themes |
| **Language** | English / Turkish |
| **Launch on Startup** | Register Kairos with Windows autostart via `tauri-plugin-autostart` |
| **Disable category prompts** | Suppress the "New App Detected" modal |
| **Categorise Apps** | Manually override the category of any tracked application |

---

## 🗺️ Roadmap

- [x] Auto-start: Runs silently in the background when the computer starts up.
- [ ] Auto-update feature: Notifies the user when a new version is available and allows them to download it.
- [ ] Export data to CSV/JSON format: Allows users to own and back up their own data.
- [ ] Weekly and monthly summary reports: Enabling historical analysis of data.
- [ ] Memento Mori Widget: A sleek, transparent, and minimalist progress bar showing the time remaining until the end of the day.

---

## 🤝 Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'feat: add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

Kairos is free software: you can redistribute it and/or modify it under the terms of the **GNU General Public License v3.0** as published by the Free Software Foundation.

See [LICENSE](LICENSE) for the full license text.

---

<div align="center">

Made with ☕ and Rust &nbsp;·&nbsp; © 2026 osklc

</div>
