const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

let greetInputEl;
let greetMsgEl;
let activeDictionary = {};
let translationsConfig = null;
let activeLanguage = "en";
let internetDateCache = null;

const LANGUAGE_STORAGE_KEY = "screen-time-language";
const THEME_STORAGE_KEY = "screen-time-theme";
const DISABLE_PROMPT_KEY = "screen-time-disable-prompt";
const POMO_SETTINGS_KEY = "pomodoro-settings";
const POMO_STATS_KEY = "pomodoro-stats";
const POMO_RING_CIRCUMFERENCE = 2 * Math.PI * 90; // ~565.48
const INTERNET_TIME_ENDPOINTS = [
  "https://worldtimeapi.org/api/ip",
  "https://timeapi.io/api/Time/current/zone?timeZone=UTC",
];

const FADE_DURATION = 1000;
const SOUND_FILES = {
  pluvia: "pluvia.mp3",
  silva: "silva.mp3",
  "focus-static": "focus-static.mp3",
};
const soundTracks = {};
let soundSaveTimer = null;
let globalAnalyser = null;
let globalAudioCtx = null;
let visualizerAnimationId = null;

function translate(key) {
  return activeDictionary[key] ?? key;
}

function applyTranslations() {
  const textNodes = document.querySelectorAll("[data-i18n]");
  textNodes.forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) return;
    node.textContent = translate(key);
  });

  const placeholderNodes = document.querySelectorAll("[data-i18n-placeholder]");
  placeholderNodes.forEach((node) => {
    const key = node.getAttribute("data-i18n-placeholder");
    if (!key) return;
    node.setAttribute("placeholder", translate(key));
  });
}

async function loadTranslations() {
  try {
    const response = await fetch("/i18n.json");
    if (!response.ok) return null;

    const i18nConfig = await response.json();
    translationsConfig = i18nConfig;
    return i18nConfig;
  } catch {
    // Keep static English text if translation loading fails.
    return null;
  }
}

function updatePageTitle(pageTitleEl, pageTitleKeys) {
  if (!pageTitleEl) return;
  const activePageKey = document.querySelector(".nav-link.active")?.dataset.page;
  if (!activePageKey) return;
  const titleKey = pageTitleKeys[activePageKey];
  if (!titleKey) return;
  pageTitleEl.textContent = translate(titleKey);
}

function formatDateForLanguage(dateValue, languageCode) {
  const locale = languageCode === "tr" ? "tr-TR" : "en-US";
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(dateValue);
}

function formatDuration(totalSeconds) {
  const hLabel = translate("duration.hours");
  const mLabel = translate("duration.minutes");

  if (!totalSeconds || totalSeconds <= 0) return `0${hLabel} 0${mLabel}`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}${hLabel} ${minutes}${mLabel}`;
  }
  return `${minutes}${mLabel}`;
}

async function fetchAndRenderSummary() {
  const statTotalEl = document.getElementById("stat-total-time");
  const statProdEl = document.getElementById("stat-productive-time");
  const statBreakEl = document.getElementById("stat-break-count");
  const statLongestEl = document.getElementById("stat-longest-session");
  const statDistEl = document.getElementById("stat-distracting-time");

  if (!statTotalEl || !statProdEl || !statBreakEl || !statLongestEl || !statDistEl) return;

  try {
    const summary = await invoke("get_today_summary");
    statTotalEl.textContent = formatDuration(summary.total_screen_time_seconds);
    statProdEl.textContent = formatDuration(summary.productive_time_seconds);
    statDistEl.textContent = formatDuration(summary.distracting_time_seconds);

    // Break count comes from Pomodoro
    const pomoStats = loadPomodoroStats();
    statBreakEl.textContent = pomoStats.breaksTaken.toString();

    statLongestEl.textContent = formatDuration(summary.longest_session_seconds);
  } catch (err) {
    console.error("Failed to fetch summary:", err);
  }
}

async function loadAppCategories() {
  const listEl = document.getElementById("app-category-list");
  if (!listEl) return;

  try {
    const apps = await invoke("get_all_apps");
    listEl.innerHTML = "";

    if (apps.length === 0) {
      listEl.innerHTML = `<p style='text-align:center; color: var(--text-muted); padding: 10px;'>${translate("settings.noApps")}</p>`;
      return;
    }

    apps.forEach(app => {
      const itemEl = document.createElement("div");
      itemEl.className = "app-category-item";

      const nameEl = document.createElement("span");
      nameEl.textContent = app.app_name;

      const selectEl = document.createElement("select");
      const options = [
        { value: "uncategorized", label: translate("categories.uncategorized") },
        { value: "productive", label: translate("categories.productive") },
        { value: "neutral", label: translate("categories.neutral") },
        { value: "distracting", label: translate("categories.distracting") }
      ];

      options.forEach(opt => {
        const optionEl = document.createElement("option");
        optionEl.value = opt.value;
        optionEl.textContent = opt.label;
        if (app.category === opt.value) {
          optionEl.selected = true;
        }
        selectEl.appendChild(optionEl);
      });

      selectEl.addEventListener("change", async (e) => {
        const newCategory = e.target.value;
        try {
          await invoke("set_app_category", { appName: app.app_name, category: newCategory });
          fetchAndRenderSummary();
          renderDailyPieChart();
        } catch (err) {
          console.error("Failed to update category:", err);
        }
      });

      itemEl.appendChild(nameEl);
      itemEl.appendChild(selectEl);
      listEl.appendChild(itemEl);
    });
  } catch (err) {
    console.error("Failed to load apps:", err);
  }
}

async function fetchAndRenderAppUsage() {
  const listEl = document.getElementById("app-usage-list");
  if (!listEl) return;

  try {
    const usages = await invoke("get_app_usage");
    listEl.innerHTML = "";

    if (usages.length === 0) {
      listEl.innerHTML = `<p style='color: var(--text-muted);'>${translate("apps.noActivity")}</p>`;
      return;
    }

    usages.forEach(usage => {
      const li = document.createElement("li");
      li.textContent = `${usage.app_name}: ${formatDuration(usage.duration_seconds)}`;
      listEl.appendChild(li);
    });
  } catch (err) {
    console.error("Failed to fetch app usage:", err);
  }
}

let dailyChart = null;
let dailyEnergyTotalChart = null;
let dailyPieChart = null;
let lastDailyStatsJson = "";

let currentChartPeriod = "daily";

async function fetchAndRenderDailyStats() {
  const canvas = document.getElementById("daily-chart");
  if (!canvas) return;

  try {
    let stats;
    if (currentChartPeriod === "weekly") {
      stats = await invoke("get_weekly_stats");
    } else if (currentChartPeriod === "monthly") {
      stats = await invoke("get_monthly_stats");
    } else {
      stats = await invoke("get_daily_stats");
    }
    const statsJson = JSON.stringify(stats);

    const labels = stats.map(s => s.day);
    const data = stats.map(s => s.total_seconds / 3600); // hours

    const computedStyle = getComputedStyle(document.body);
    const chartBgColor = computedStyle.getPropertyValue('--chart-color').trim() || 'rgba(78, 158, 229, 0.6)';
    const chartBorderColor = computedStyle.getPropertyValue('--accent-color').trim() || 'rgba(78, 158, 229, 1)';
    const chartTextColor = computedStyle.getPropertyValue('--chart-text-color').trim() || '#000000';
    const chartGridColor = computedStyle.getPropertyValue('--chart-grid-color').trim() || 'rgba(0,0,0,0.1)';

    const emptyDiv = document.getElementById("daily-chart-empty");
    if (!data || data.length === 0 || data.every(v => v === 0)) {
      canvas.style.display = "none";
      if (emptyDiv) emptyDiv.style.display = "flex";
      return;
    } else {
      canvas.style.display = "block";
      if (emptyDiv) emptyDiv.style.display = "none";
    }

    // Always recreate chart to ensure colors update with theme
    if (dailyChart) {
      dailyChart.destroy();
      dailyChart = null;
    }

    const ctx = canvas.getContext("2d");
    dailyChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: translate("overview.totalScreenTime"),
          data: data,
          backgroundColor: chartBgColor,
          borderColor: chartBorderColor,
          borderWidth: 1,
          borderRadius: 8,
        }]
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              color: chartTextColor,
              callback: function (value) {
                const hours = Math.floor(value);
                const minutes = Math.round((value - hours) * 60);
                const hLabel = translate("duration.hours");
                const mLabel = translate("duration.minutes");
                if (minutes === 0) return hours + hLabel;
                return `${hours}${hLabel} ${minutes}${mLabel}`;
              }
            },
            title: { color: chartTextColor },
            grid: { color: chartGridColor }
          },
          x: {
            ticks: { color: chartTextColor },
            title: { color: chartTextColor },
            grid: { color: chartGridColor }
          }
        },
        plugins: {
          legend: {
            display: false
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                const value = context.parsed.y;
                const hours = Math.floor(value);
                const minutes = Math.round((value - hours) * 60);
                const hLabel = translate("duration.hours");
                const mLabel = translate("duration.minutes");
                return `${translate("overview.totalScreenTime")}: ${hours}${hLabel} ${minutes}${mLabel}`;
              }
            }
          }
        }
      }
    });
  } catch (err) {
    console.error("Failed to fetch daily stats:", err);
  }
}



function renderDailyEnergyTotalChart() {
  const canvas = document.getElementById("daily-energy-total-chart");
  if (!canvas) return;

  try {
    const labels = [];
    const data = [];
    const now = new Date();

    // Get last 7 days of history from localStorage
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
      const kwh = parseFloat(localStorage.getItem(storageKey) || "0");

      labels.push(dayKey);
      data.push(kwh);
    }

    const computedStyle = getComputedStyle(document.body);
    const accentColor = computedStyle.getPropertyValue('--accent-color').trim() || '#5a9ddf';
    const chartBgColor = computedStyle.getPropertyValue('--chart-color').trim() || 'rgba(90, 157, 223, 0.6)';
    const chartTextColor = computedStyle.getPropertyValue('--chart-text-color').trim() || '#000000';
    const chartGridColor = computedStyle.getPropertyValue('--chart-grid-color').trim() || 'rgba(0,0,0,0.1)';

    const emptyDiv = document.getElementById("daily-energy-empty");
    if (!data || data.length === 0 || data.every(v => v === 0)) {
      canvas.style.display = "none";
      if (emptyDiv) emptyDiv.style.display = "flex";
      return;
    } else {
      canvas.style.display = "block";
      if (emptyDiv) emptyDiv.style.display = "none";
    }

    if (dailyEnergyTotalChart) {
      dailyEnergyTotalChart.destroy();
      dailyEnergyTotalChart = null;
    }

    const ctx = canvas.getContext("2d");
    dailyEnergyTotalChart = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{
          label: translate("daily.energyTotalTitle"),
          data: data,
          backgroundColor: chartBgColor,
          borderColor: accentColor,
          borderWidth: 1,
          borderRadius: 8,
        }]
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              color: chartTextColor,
              callback: function (value) {
                return value.toFixed(2) + " kWh";
              }
            },
            title: {
              display: true,
              text: "kWh",
              color: chartTextColor
            },
            grid: { color: chartGridColor }
          },
          x: {
            ticks: { color: chartTextColor },
            title: { color: chartTextColor },
            grid: { color: chartGridColor }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (context) {
                return context.parsed.y.toFixed(3) + " kWh";
              }
            }
          }
        }
      }
    });
  } catch (err) {
    console.error("Failed to render daily energy total chart:", err);
  }
}

async function renderDailyPieChart() {
  const canvas = document.getElementById("daily-pie-chart");
  if (!canvas) return;

  try {
    const summary = await invoke("get_today_summary");
    const totalSeconds = summary.total_screen_time_seconds || 0;
    const prodSeconds = summary.productive_time_seconds || 0;
    const distSeconds = summary.distracting_time_seconds || 0;
    const neutralSeconds = Math.max(0, totalSeconds - prodSeconds - distSeconds);

    const computedStyle = getComputedStyle(document.body);
    const chartTextColor = computedStyle.getPropertyValue('--chart-text-color').trim() || '#000000';

    // Color palette for pie chart
    const colors = [
      'rgba(76, 175, 80, 0.7)',     // Green for productive
      'rgba(244, 67, 54, 0.7)',     // Red for distracting
      'rgba(158, 158, 158, 0.7)'    // Gray for neutral
    ];

    const emptyDiv = document.getElementById("daily-pie-empty");
    if (totalSeconds === 0) {
      canvas.style.display = "none";
      if (emptyDiv) emptyDiv.style.display = "flex";
      return;
    } else {
      canvas.style.display = "block";
      if (emptyDiv) emptyDiv.style.display = "none";
    }

    if (dailyPieChart) {
      dailyPieChart.destroy();
      dailyPieChart = null;
    }

    const ctx = canvas.getContext("2d");
    dailyPieChart = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: [
          translate("daily.productive"),
          translate("daily.distracting"),
          translate("daily.neutral")
        ],
        datasets: [{
          data: [prodSeconds, distSeconds, neutralSeconds],
          backgroundColor: colors,
          borderColor: [
            'rgba(76, 175, 80, 1)',
            'rgba(244, 67, 54, 1)',
            'rgba(158, 158, 158, 1)'
          ],
          borderWidth: 2,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: chartTextColor,
              padding: 15,
              font: { size: 12 }
            }
          },
          tooltip: {
            callbacks: {
              label: function (context) {
                const seconds = context.parsed;
                const hours = Math.floor(seconds / 3600);
                const mins = Math.floor((seconds % 3600) / 60);
                const hLabel = translate("duration.hours");
                const mLabel = translate("duration.minutes");
                if (mins === 0) return `${hours}${hLabel}`;
                return `${hours}${hLabel} ${mins}${mLabel}`;
              }
            }
          }
        }
      }
    });
  } catch (err) {
    console.error("Failed to render daily pie chart:", err);
  }
}

function renderCurrentDate(currentDateEl) {
  if (!currentDateEl || !internetDateCache) return;
  currentDateEl.textContent = formatDateForLanguage(internetDateCache, activeLanguage);
}

async function fetchDateFromInternet() {
  for (const endpoint of INTERNET_TIME_ENDPOINTS) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) continue;

      const payload = await response.json();
      const rawDateValue = payload.datetime || payload.dateTime;
      if (!rawDateValue) continue;

      const parsedDate = new Date(rawDateValue);
      if (!Number.isNaN(parsedDate.getTime())) {
        return parsedDate;
      }
    } catch {
      // Try next endpoint.
    }
  }

  return null;
}

async function ensureCurrentDate(currentDateEl) {
  if (!internetDateCache) {
    internetDateCache = await fetchDateFromInternet();
  }

  if (!internetDateCache) {
    internetDateCache = new Date();
  }

  renderCurrentDate(currentDateEl);
}

function setLanguage(languageCode, pageTitleEl, pageTitleKeys, currentDateEl) {
  const availableTranslations = translationsConfig?.translations || {};
  const fallbackLanguage = translationsConfig?.defaultLanguage || "en";

  if (!availableTranslations[languageCode]) {
    languageCode = fallbackLanguage;
  }

  activeLanguage = languageCode;
  activeDictionary = availableTranslations[languageCode] || {};
  applyTranslations();
  updatePageTitle(pageTitleEl, pageTitleKeys);
  renderCurrentDate(currentDateEl);
  localStorage.setItem(LANGUAGE_STORAGE_KEY, languageCode);

  // Refresh dynamic content
  fetchAndRenderSummary();
  fetchAndRenderAppUsage();
  if (document.querySelector("#page-settings")?.classList.contains("active")) {
    loadAppCategories();
  }
}

function setTheme(theme, themeButtons) {
  const themes = ["white", "black", "midnight", "nord", "cyberpunk", "rosepine", "forest"];
  const resolvedTheme = themes.includes(theme) ? theme : "white";

  document.body.setAttribute("data-theme", resolvedTheme);
  localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);

  themeButtons.forEach((button) => {
    const buttonTheme = button.getAttribute("data-theme-option");
    const isActive = buttonTheme === resolvedTheme;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });

  // Re-render charts to pick up new theme colors
  fetchAndRenderDailyStats();
  renderDailyEnergyTotalChart();
  renderDailyPieChart();

  // Recreate energy chart with new theme colors
  if (energyState.chart) {
    energyState.chart.destroy();
    energyState.chart = null;
  }
  updateEnergyChart();
}

async function greet() {
  greetMsgEl.textContent = await invoke("greet", { name: greetInputEl.value });
}

// ───── Pomodoro Timer ─────

const pomodoroState = {
  isRunning: false,
  isPaused: false,
  mode: "focus", // "focus" | "shortBreak" | "longBreak"
  timeRemaining: 25 * 60,
  totalDuration: 25 * 60,
  intervalId: null,
  settings: {
    focusDuration: 25,
    shortBreakDuration: 5,
    longBreakDuration: 15,
    longBreakAfter: 4,
  },
};

function getTodayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ───── Energy Dashboard ─────
const ENERGY_STORAGE_PREFIX = "energy-daily-kwh-";
const ENERGY_SETTINGS_KEY = "energy-settings";
const ENERGY_MODE_KEY = "energy-smoothing-mode";
const DEFAULT_POWER_SAMPLE_SECONDS = 10;
const ENERGY_MODE_WINDOWS = {
  eco: 15 * 60,
  balanced: 5 * 60,
  performance: 60,
};

const energyState = {
  mode: "balanced",
  avgWatts: 0,
  instantWatts: 0,
  lastTimestamp: 0,
  lastSource: "-",
  cpuModel: "—",
  gpuModel: "—",
  deviceType: "Desktop",
  initialized: false,
  history: [],
  chart: null,
};

function loadEnergySettings() {
  try {
    const raw = localStorage.getItem(ENERGY_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.mode && ENERGY_MODE_WINDOWS[parsed.mode]) {
        energyState.mode = parsed.mode;
      }
    }
  } catch { }

  try {
    const savedMode = localStorage.getItem(ENERGY_MODE_KEY);
    if (savedMode && ENERGY_MODE_WINDOWS[savedMode]) {
      energyState.mode = savedMode;
    }
  } catch { }

  renderEnergyModeButtons();
}

function saveEnergySettings() {
  try {
    localStorage.setItem(ENERGY_SETTINGS_KEY, JSON.stringify({ mode: energyState.mode }));
    localStorage.setItem(ENERGY_MODE_KEY, energyState.mode);
  } catch { }
}

function getEnergyWindowSeconds(mode = energyState.mode) {
  return ENERGY_MODE_WINDOWS[mode] || ENERGY_MODE_WINDOWS.balanced;
}

function renderEnergyModeButtons() {
  document.querySelectorAll(".energy-mode-btn[data-energy-mode]").forEach((button) => {
    const mode = button.getAttribute("data-energy-mode");
    const isActive = mode === energyState.mode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function addDailyKWh(kwhAmount) {
  try {
    const key = ENERGY_STORAGE_PREFIX + getTodayKey();
    const raw = localStorage.getItem(key);
    const total = (raw ? parseFloat(raw) : 0) + kwhAmount;
    localStorage.setItem(key, String(total));
  } catch { }
}

function loadTodayTotalKWh() {
  try {
    const key = ENERGY_STORAGE_PREFIX + getTodayKey();
    const raw = localStorage.getItem(key);
    return raw ? parseFloat(raw) : 0;
  } catch {
    return 0;
  }
}

function updateEnergyChart() {
  const canvas = document.getElementById("energy-chart");
  if (!canvas) return;

  const labels = energyState.history.map((entry) => entry.label);
  const values = energyState.history.map((entry) => entry.watts);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const computedStyle = getComputedStyle(document.body);
  const lineColor = computedStyle.getPropertyValue("--accent-color").trim() || "#5a9ddf";
  const fillColor = computedStyle.getPropertyValue("--chart-color").trim() || "rgba(90, 157, 223, 0.18)";
  const chartTextColor = computedStyle.getPropertyValue('--chart-text-color').trim() || '#000000';
  const chartGridColor = computedStyle.getPropertyValue('--chart-grid-color').trim() || 'rgba(0,0,0,0.1)';

  if (!energyState.chart) {
    energyState.chart = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: "Average Watt",
          data: values,
          tension: 0.34,
          fill: true,
          borderColor: lineColor,
          backgroundColor: fillColor,
          pointRadius: 0,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (context) => `${context.parsed.y.toFixed(1)} W`,
            },
          },
        },
        scales: {
          x: {
            ticks: { maxTicksLimit: 6, color: chartTextColor },
            grid: { color: chartGridColor, display: true },
          },
          y: {
            beginAtZero: false,
            ticks: {
              color: chartTextColor,
              precision: 0,
              callback: (value) => `${Math.round(value)}W`,
            },
            grid: { color: chartGridColor }
          },
        },
      },
    });
    return;
  }

  energyState.chart.data.labels = labels;
  energyState.chart.data.datasets[0].data = values;
  energyState.chart.update("none");
}

function updateEnergyUI() {
  const avgKW = (energyState.avgWatts || 0) / 1000;
  const periodKWh = avgKW * (getEnergyWindowSeconds() / 3600);

  const avgEl = document.getElementById("energy-avg-kW");
  const currentWEl = document.getElementById("energy-current-w");
  const periodEl = document.getElementById("energy-period-kWh");
  const dailyEl = document.getElementById("energy-daily-total");
  const lastEl = document.getElementById("energy-last-update");
  const sourceEl = document.getElementById("energy-source");
  const cpuEl = document.getElementById("energy-cpu-model");
  const gpuEl = document.getElementById("energy-gpu-model");

  if (avgEl) avgEl.textContent = `${avgKW.toFixed(3)} kW`;
  if (currentWEl) currentWEl.textContent = `${energyState.instantWatts.toFixed(0)}`;
  const rangeEl = document.getElementById("energy-range");
  const deviceTypeEl = document.getElementById("energy-device-type");
  if (rangeEl) {
    const center = Math.round(energyState.instantWatts || energyState.avgWatts || 0);
    const min = center - 5;
    const max = center + 5;
    rangeEl.textContent = `${min}W - ${max}W`;
  }
  if (deviceTypeEl) deviceTypeEl.textContent = energyState.deviceType || "—";
  if (periodEl) periodEl.textContent = `${periodKWh.toFixed(3)} kWh`;
  if (dailyEl) dailyEl.textContent = loadTodayTotalKWh().toFixed(3);
  if (lastEl) lastEl.textContent = energyState.lastTimestamp ? new Date(energyState.lastTimestamp * 1000).toLocaleTimeString() : "—";
  if (sourceEl) {
    let displaySource = energyState.lastSource || "—";
    if (energyState.deviceType === "Laptop") {
      displaySource = translate("energy.sourceBattery");
    } else {
      displaySource = translate("energy.sourceEstimation");
    }
    sourceEl.textContent = displaySource;
  }
  if (cpuEl) cpuEl.textContent = energyState.cpuModel;
  if (gpuEl) gpuEl.textContent = energyState.gpuModel;

  renderEnergyModeButtons();
  updateEnergyChart();
}

async function setEnergyMode(mode) {
  if (!ENERGY_MODE_WINDOWS[mode]) return;

  energyState.mode = mode;
  saveEnergySettings();
  renderEnergyModeButtons();

  try {
    await invoke("set_power_smoothing_mode", { mode });
  } catch (err) {
    console.error("Failed to set power smoothing mode:", err);
  }

  updateEnergyUI();
}

function onPowerUsagePayload(payload) {
  if (!payload) return;

  const avgWatts = Number(payload.avg_watts) || 0;
  const instantWatts = Number(payload.instant_watts ?? payload.avg_watts) || 0;
  const timestamp = Number(payload.timestamp) || Math.floor(Date.now() / 1000);
  const intervalSeconds = Number(payload.sample_interval_seconds) || DEFAULT_POWER_SAMPLE_SECONDS;
  const source = payload.source || "unknown";
  const cpuModel = payload.cpu_model || "—";
  const gpuModel = payload.gpu_model || "—";
  const smoothingMode = payload.smoothing_mode;
  const deviceType = payload.device_type || "Desktop";

  if (smoothingMode && ENERGY_MODE_WINDOWS[smoothingMode]) {
    energyState.mode = smoothingMode;
  }

  if (energyState.lastTimestamp <= 0 || timestamp > energyState.lastTimestamp) {
    addDailyKWh((avgWatts * intervalSeconds) / 3600000);
  }

  energyState.avgWatts = avgWatts;
  energyState.instantWatts = instantWatts;
  energyState.lastTimestamp = timestamp;
  energyState.lastSource = source;
  energyState.cpuModel = cpuModel;
  energyState.gpuModel = gpuModel;
  energyState.deviceType = deviceType;

  energyState.history.push({
    label: new Date(timestamp * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    watts: avgWatts,
  });

  while (energyState.history.length > 60) {
    energyState.history.shift();
  }

  updateEnergyUI();
}

async function initEnergyUI() {
  if (energyState.initialized) return;

  loadEnergySettings();

  document.querySelectorAll(".energy-mode-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.getAttribute("data-energy-mode");
      if (mode) setEnergyMode(mode);
    });
  });

  await listen("power_usage_avg", (event) => {
    onPowerUsagePayload(event.payload);
  });

  await setEnergyMode(energyState.mode);
  energyState.initialized = true;
  updateEnergyUI();
}

function loadPomodoroSettings() {
  try {
    const saved = localStorage.getItem(POMO_SETTINGS_KEY);
    if (saved) {
      Object.assign(pomodoroState.settings, JSON.parse(saved));
    }
  } catch { /* use defaults */ }
}

function savePomodoroSettings() {
  localStorage.setItem(POMO_SETTINGS_KEY, JSON.stringify(pomodoroState.settings));
}

function loadPomodoroStats() {
  try {
    const saved = localStorage.getItem(POMO_STATS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed.date === getTodayKey()) {
        return parsed;
      }
    }
  } catch { /* use defaults */ }
  return { date: getTodayKey(), sessionsCompleted: 0, totalFocusSeconds: 0, breaksTaken: 0 };
}

function savePomodoroStats(stats) {
  stats.date = getTodayKey();
  localStorage.setItem(POMO_STATS_KEY, JSON.stringify(stats));
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 800;
    osc.type = "sine";
    gain.gain.value = 0.3;
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
    setTimeout(() => {
      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.frequency.value = 1000;
      osc2.type = "sine";
      gain2.gain.value = 0.3;
      osc2.start();
      osc2.stop(ctx.currentTime + 0.5);
    }, 300);
  } catch { /* audio not available */ }
}

function updatePomodoroUI() {
  const timeEl = document.getElementById("pomo-time");
  const modeEl = document.getElementById("pomo-mode-label");
  const ringEl = document.getElementById("pomo-ring");
  const startBtn = document.getElementById("pomo-start");
  const pauseBtn = document.getElementById("pomo-pause");
  const sessionsEl = document.getElementById("pomo-sessions");
  const focusTimeEl = document.getElementById("pomo-focus-time");
  const breaksEl = document.getElementById("pomo-breaks");

  if (timeEl) {
    const mins = Math.floor(pomodoroState.timeRemaining / 60);
    const secs = pomodoroState.timeRemaining % 60;
    timeEl.textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  }

  if (modeEl) {
    if (pomodoroState.mode === "focus") {
      modeEl.textContent = translate("pomodoro.focus");
    } else if (pomodoroState.mode === "shortBreak") {
      modeEl.textContent = translate("pomodoro.shortBreak");
    } else {
      modeEl.textContent = translate("pomodoro.longBreak");
    }
  }

  if (ringEl) {
    const progress = pomodoroState.totalDuration > 0
      ? (pomodoroState.totalDuration - pomodoroState.timeRemaining) / pomodoroState.totalDuration
      : 0;
    ringEl.style.strokeDashoffset = POMO_RING_CIRCUMFERENCE * (1 - progress);

    if (pomodoroState.mode === "focus") {
      ringEl.classList.remove("break-mode");
    } else {
      ringEl.classList.add("break-mode");
    }
  }

  if (startBtn && pauseBtn) {
    if (pomodoroState.isRunning && !pomodoroState.isPaused) {
      startBtn.style.display = "none";
      pauseBtn.style.display = "inline-block";
    } else {
      startBtn.style.display = "inline-block";
      pauseBtn.style.display = "none";
      if (pomodoroState.isPaused) {
        startBtn.textContent = translate("pomodoro.start");
      }
    }
  }

  const stats = loadPomodoroStats();
  if (sessionsEl) sessionsEl.textContent = stats.sessionsCompleted;
  if (focusTimeEl) focusTimeEl.textContent = formatDuration(stats.totalFocusSeconds);
  if (breaksEl) breaksEl.textContent = stats.breaksTaken;
}

function applyPomodoroSettingsToUI() {
  const focusDurEl = document.getElementById("pomo-focus-dur");
  const shortDurEl = document.getElementById("pomo-short-dur");
  const longDurEl = document.getElementById("pomo-long-dur");
  const longAfterEl = document.getElementById("pomo-long-after");

  if (focusDurEl) focusDurEl.value = pomodoroState.settings.focusDuration;
  if (shortDurEl) shortDurEl.value = pomodoroState.settings.shortBreakDuration;
  if (longDurEl) longDurEl.value = pomodoroState.settings.longBreakDuration;
  if (longAfterEl) longAfterEl.value = pomodoroState.settings.longBreakAfter;
}

function startPomodoro() {
  if (pomodoroState.isRunning && !pomodoroState.isPaused) return;

  if (!pomodoroState.isRunning) {
    // Fresh start
    if (pomodoroState.mode === "focus") {
      pomodoroState.totalDuration = pomodoroState.settings.focusDuration * 60;
    } else if (pomodoroState.mode === "shortBreak") {
      pomodoroState.totalDuration = pomodoroState.settings.shortBreakDuration * 60;
    } else {
      pomodoroState.totalDuration = pomodoroState.settings.longBreakDuration * 60;
    }
    pomodoroState.timeRemaining = pomodoroState.totalDuration;
  }

  pomodoroState.isRunning = true;
  pomodoroState.isPaused = false;

  pomodoroState.intervalId = setInterval(() => {
    pomodoroState.timeRemaining--;

    if (pomodoroState.timeRemaining <= 0) {
      clearInterval(pomodoroState.intervalId);
      pomodoroState.intervalId = null;
      pomodoroState.isRunning = false;
      pomodoroState.isPaused = false;

      playNotificationSound();
      onPomodoroComplete();
    }

    updatePomodoroUI();
  }, 1000);

  updatePomodoroUI();
}

function pausePomodoro() {
  if (!pomodoroState.isRunning || pomodoroState.isPaused) return;
  pomodoroState.isPaused = true;
  clearInterval(pomodoroState.intervalId);
  pomodoroState.intervalId = null;
  updatePomodoroUI();
}

function resetPomodoro() {
  clearInterval(pomodoroState.intervalId);
  pomodoroState.intervalId = null;
  pomodoroState.isRunning = false;
  pomodoroState.isPaused = false;
  pomodoroState.mode = "focus";
  pomodoroState.totalDuration = pomodoroState.settings.focusDuration * 60;
  pomodoroState.timeRemaining = pomodoroState.totalDuration;
  updatePomodoroUI();
}

function onPomodoroComplete() {
  const stats = loadPomodoroStats();

  if (pomodoroState.mode === "focus") {
    stats.sessionsCompleted++;
    stats.totalFocusSeconds += pomodoroState.totalDuration;
    savePomodoroStats(stats);

    // Decide next break type
    if (stats.sessionsCompleted % pomodoroState.settings.longBreakAfter === 0) {
      pomodoroState.mode = "longBreak";
      pomodoroState.totalDuration = pomodoroState.settings.longBreakDuration * 60;
    } else {
      pomodoroState.mode = "shortBreak";
      pomodoroState.totalDuration = pomodoroState.settings.shortBreakDuration * 60;
    }
  } else {
    // Break completed
    stats.breaksTaken++;
    savePomodoroStats(stats);
    pomodoroState.mode = "focus";
    pomodoroState.totalDuration = pomodoroState.settings.focusDuration * 60;
  }

  pomodoroState.timeRemaining = pomodoroState.totalDuration;
  updatePomodoroUI();
  // Also update overview break count
  fetchAndRenderSummary();
}

window.addEventListener("DOMContentLoaded", async () => {
  const sidebarEl = document.querySelector("#sidebar");
  const sidebarToggleEl = document.querySelector("#sidebar-toggle");
  const analyticsGroupEl = document.querySelector("#analytics-group");
  const analyticsTriggerEl = document.querySelector("#analytics-trigger");
  const navLinks = document.querySelectorAll(".nav-link[data-page]");
  const pages = document.querySelectorAll(".page");
  const pageTitleEl = document.querySelector("#page-title");
  const currentDateEl = document.querySelector("#current-date");
  const languageSelectEl = document.querySelector("#language-select");
  const themeButtons = document.querySelectorAll(".theme-btn");

  const pageTitleKeys = {
    overview: "pages.overview",
    apps: "pages.apps",
    daily: "pages.daily",
    energy: "pages.energy",
    pomodoro: "pages.pomodoro",
    sounds: "pages.sounds",
    todo: "pages.todo",
    settings: "pages.settings",
  };

  const preferredTheme = localStorage.getItem(THEME_STORAGE_KEY) || "white";
  setTheme(preferredTheme, themeButtons);

  await ensureCurrentDate(currentDateEl);

  fetchAndRenderSummary();
  fetchAndRenderAppUsage();

  function refreshActivePage() {
    const activePage = document.querySelector(".page.active");
    if (!activePage) return;
    const pageId = activePage.id;

    if (pageId === "page-overview") {
      fetchAndRenderSummary();
    } else if (pageId === "page-apps") {
      fetchAndRenderAppUsage();
    } else if (pageId === "page-energy") {
      updateEnergyUI();
    } else if (pageId === "page-settings") {
      loadAppCategories();
    } else if (pageId === "page-daily") {
      fetchAndRenderDailyStats();
      renderDailyEnergyTotalChart();
      renderDailyPieChart();
    } else if (pageId === "page-pomodoro") {
      updatePomodoroUI();
    }
    // Always refresh summary so overview stats stay current
    fetchAndRenderSummary();
  }

  setInterval(refreshActivePage, 5000);

  const i18nConfig = await loadTranslations();
  if (i18nConfig) {
    const defaultLanguage = i18nConfig.defaultLanguage || "en";
    const preferredLanguage = localStorage.getItem(LANGUAGE_STORAGE_KEY) || defaultLanguage;
    setLanguage(preferredLanguage, pageTitleEl, pageTitleKeys, currentDateEl);

    if (languageSelectEl) {
      languageSelectEl.value = preferredLanguage;
    }
  } else {
    renderCurrentDate(currentDateEl);
  }

  if (sidebarToggleEl && sidebarEl) {
    sidebarToggleEl.addEventListener("click", () => {
      sidebarEl.classList.toggle("collapsed");
    });
  }

  if (analyticsTriggerEl && analyticsGroupEl) {
    analyticsTriggerEl.addEventListener("click", () => {
      const isOpen = analyticsGroupEl.classList.toggle("open");
      analyticsTriggerEl.setAttribute("aria-expanded", String(isOpen));
    });
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      const pageKey = link.dataset.page;
      if (!pageKey) return;

      navLinks.forEach((item) => item.classList.remove("active"));
      link.classList.add("active");

      pages.forEach((page) => page.classList.remove("active"));
      const targetPage = document.querySelector(`#page-${pageKey}`);
      if (targetPage) targetPage.classList.add("active");

      if (pageKey === "settings") {
        loadAppCategories();
      } else if (pageKey === "apps") {
        fetchAndRenderAppUsage();
      } else if (pageKey === "daily") {
        fetchAndRenderDailyStats();
      } else if (pageKey === "energy") {
        loadEnergySettings();
        updateEnergyUI();
      } else if (pageKey === "pomodoro") {
        loadPomodoroSettings();
        applyPomodoroSettingsToUI();
        updatePomodoroUI();
      }

      updatePageTitle(pageTitleEl, pageTitleKeys);
    });
  });

  if (languageSelectEl) {
    languageSelectEl.addEventListener("change", (event) => {
      const selectedLanguage = event.target.value;
      setLanguage(selectedLanguage, pageTitleEl, pageTitleKeys, currentDateEl);
    });
  }

  themeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const selectedTheme = button.getAttribute("data-theme-option");
      setTheme(selectedTheme, themeButtons);
    });
  });

  const disablePromptToggleEl = document.querySelector("#disable-prompt-toggle");
  if (disablePromptToggleEl) {
    const isPromptDisabled = localStorage.getItem(DISABLE_PROMPT_KEY) === "true";
    disablePromptToggleEl.checked = isPromptDisabled;
    disablePromptToggleEl.addEventListener("change", (e) => {
      localStorage.setItem(DISABLE_PROMPT_KEY, e.target.checked);
    });
  }

  greetInputEl = document.querySelector("#greet-input");
  greetMsgEl = document.querySelector("#greet-msg");
  const greetForm = document.querySelector("#greet-form");

  if (greetForm && greetInputEl && greetMsgEl) {
    greetForm.addEventListener("submit", (e) => {
      e.preventDefault();
      greet();
    });
  }

  // ───── To-Do List Init ─────
  const todoForm = document.getElementById("todo-form");
  const todoInput = document.getElementById("todo-input");
  const todoList = document.getElementById("todo-list");

  let todos = [];
  try {
    const savedTodos = localStorage.getItem("todos");
    if (savedTodos) {
      todos = JSON.parse(savedTodos);
    }
  } catch (e) {
    console.error("Failed to load todos", e);
  }

  function renderTodos() {
    if (!todoList) return;
    todoList.innerHTML = "";
    todos.forEach((todo, index) => {
      const li = document.createElement("li");
      li.className = "todo-item" + (todo.completed ? " completed" : "");
      
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = todo.completed;
      checkbox.addEventListener("change", () => {
        todos[index].completed = checkbox.checked;
        if (checkbox.checked) {
          const audio = new Audio("/assets/sound-effect/mixkit-quick-win-video-game-notification-269.wav");
          audio.volume = 0.5;
          audio.play().catch(e => console.error("Sound play failed:", e));
        }
        saveTodos();
        renderTodos();
      });

      const span = document.createElement("span");
      span.textContent = todo.text;
      span.className = "todo-text";

      const deleteBtn = document.createElement("button");
      deleteBtn.textContent = "×";
      deleteBtn.className = "todo-delete-btn";
      deleteBtn.addEventListener("click", () => {
        todos.splice(index, 1);
        saveTodos();
        renderTodos();
      });

      li.appendChild(checkbox);
      li.appendChild(span);
      li.appendChild(deleteBtn);
      todoList.appendChild(li);
    });
  }

  function saveTodos() {
    localStorage.setItem("todos", JSON.stringify(todos));
  }

  if (todoForm && todoInput && todoList) {
    renderTodos();
    todoForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = todoInput.value.trim();
      if (text) {
        todos.push({ text, completed: false });
        todoInput.value = "";
        saveTodos();
        renderTodos();
      }
    });
  }

  const activeWindowDisplayEl = document.getElementById("active-window-display");
  if (activeWindowDisplayEl) {
    listen("active_window", (event) => {
      const app = event.payload.app_name;
      const title = event.payload.title;
      if (title.toLowerCase().includes(app.toLowerCase())) {
        activeWindowDisplayEl.textContent = title;
      } else {
        activeWindowDisplayEl.textContent = `${app} - ${title}`;
      }
    });
  }

  const showDbBtn = document.getElementById("show-db-btn");
  const dbOutputEl = document.getElementById("db-output");
  if (showDbBtn && dbOutputEl) {
    showDbBtn.addEventListener("click", async () => {
      try {
        const data = await invoke("get_sessions");
        dbOutputEl.textContent = data || "Veritabanı henüz boş veya oturumlar kaydediliyor...";
        dbOutputEl.style.display = "block";
      } catch (e) {
        dbOutputEl.textContent = "Hata: " + e;
        dbOutputEl.style.display = "block";
      }
    });
  }

  const categoryModal = document.getElementById("category-modal");
  const modalAppName = document.getElementById("modal-app-name");
  let currentAskApp = "";
  const askQueue = [];
  let isModalOpen = false;

  function processAskQueue() {
    if (isModalOpen || askQueue.length === 0) return;
    isModalOpen = true;
    currentAskApp = askQueue.shift();
    if (modalAppName) modalAppName.textContent = currentAskApp;
    if (categoryModal) categoryModal.style.display = "block";
  }

  if (categoryModal && modalAppName) {
    listen("ask_category", (event) => {
      const isDisabled = localStorage.getItem(DISABLE_PROMPT_KEY) === "true";
      if (isDisabled) return;

      askQueue.push(event.payload.app_name);
      processAskQueue();
    });

    document.querySelectorAll(".notification-buttons button[data-cat]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const category = btn.getAttribute("data-cat");
        try {
          await invoke("set_app_category", { appName: currentAskApp, category });
          categoryModal.style.display = "none";
          isModalOpen = false;
          fetchAndRenderSummary();
          if (document.querySelector("#page-settings")?.classList.contains("active")) {
            loadAppCategories();
          }
          processAskQueue();
        } catch (err) {
          console.error("Failed to categorize app:", err);
        }
      });
    });

    const skipBtn = document.getElementById("modal-btn-skip");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        categoryModal.style.display = "none";
        isModalOpen = false;
        processAskQueue();
      });
    }
  }

  const soundsPage = document.getElementById("page-sounds");
  const trackEls = soundsPage ? soundsPage.querySelectorAll(".track[data-sound]") : [];

  const savedSoundSettings = await loadSoundSettings();

  for (const trackEl of trackEls) {
    const soundKey = trackEl.dataset.sound;
    if (!soundKey || !SOUND_FILES[soundKey]) continue;

    const savedVolume = savedSoundSettings[soundKey]?.volume ?? 50;

    soundTracks[soundKey] = {
      audio: null,
      ctx: null,
      gainNode: null,
      sourceNode: null,
      playing: false,
      volume: savedVolume,
      blobUrl: null,
      loaded: false,
      el: trackEl,
    };

    const slider = trackEl.querySelector(".track-volume");
    if (slider) {
      slider.value = savedVolume;
      updateSoundSliderFill(slider);
    }

    const toggleBtn = trackEl.querySelector(".track-toggle");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => toggleSoundTrack(soundKey));
    }

    if (slider) {
      slider.addEventListener("input", (e) => {
        const vol = parseInt(e.target.value, 10);
        setSoundVolume(soundKey, vol);
        updateSoundSliderFill(e.target);
        scheduleSoundSave();
      });
    }

    trackEl.classList.add("loading");
    loadSoundAudioFile(soundKey).then(() => {
      trackEl.classList.remove("loading");
    });
  }

  // ───── Pomodoro Init ─────
  loadPomodoroSettings();
  applyPomodoroSettingsToUI();
  updatePomodoroUI();

  const pomoStartBtn = document.getElementById("pomo-start");
  const pomoPauseBtn = document.getElementById("pomo-pause");
  const pomoResetBtn = document.getElementById("pomo-reset");

  if (pomoStartBtn) pomoStartBtn.addEventListener("click", startPomodoro);
  if (pomoPauseBtn) pomoPauseBtn.addEventListener("click", pausePomodoro);
  if (pomoResetBtn) pomoResetBtn.addEventListener("click", resetPomodoro);

  // Save settings on input change
  ["pomo-focus-dur", "pomo-short-dur", "pomo-long-dur", "pomo-long-after"].forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener("change", () => {
        pomodoroState.settings.focusDuration = parseInt(document.getElementById("pomo-focus-dur").value) || 25;
        pomodoroState.settings.shortBreakDuration = parseInt(document.getElementById("pomo-short-dur").value) || 5;
        pomodoroState.settings.longBreakDuration = parseInt(document.getElementById("pomo-long-dur").value) || 15;
        pomodoroState.settings.longBreakAfter = parseInt(document.getElementById("pomo-long-after").value) || 4;
        savePomodoroSettings();

        // Update timer if not running
        if (!pomodoroState.isRunning) {
          resetPomodoro();
        }
      });
    }
  });

  // ───── Autostart Init ─────
  const autostartToggle = document.getElementById("autostart-toggle");
  if (autostartToggle) {
    try {
      const { isEnabled, enable, disable } = window.__TAURI__.plugins.autostart;

      // Get initial state
      const enabled = await isEnabled();
      autostartToggle.checked = enabled;

      autostartToggle.addEventListener("change", async () => {
        try {
          if (autostartToggle.checked) {
            await enable();
          } else {
            await disable();
          }
        } catch (err) {
          console.error("Failed to change autostart state:", err);
          // Revert toggle if failed
          autostartToggle.checked = !autostartToggle.checked;
        }
      });
    } catch (err) {
      console.error("Autostart plugin not found or failed to initialize:", err);
      if (autostartToggle.parentElement) {
        autostartToggle.parentElement.style.display = "none";
      }
    }
  }

  // Initialize Energy UI controls
  initEnergyUI();
  // Wire disclaimer modal button
  try {
    const discBtn = document.getElementById("energy-disclaimer-btn");
    const discModal = document.getElementById("disclaimer-modal");
    const discClose = document.getElementById("disclaimer-close");
    if (discBtn && discModal) {
      discBtn.addEventListener("click", () => { discModal.style.display = "flex"; });
    }
    if (discClose && discModal) {
      discClose.addEventListener("click", () => { discModal.style.display = "none"; });
    }
  } catch (e) { /* ignore */ }
});

// ── Focus Sounds Audio Engine ──

async function loadSoundAudioFile(soundKey) {
  try {
    const bytes = await invoke("get_audio_file", { filename: SOUND_FILES[soundKey] });
    const uint8 = new Uint8Array(bytes);
    const blob = new Blob([uint8], { type: "audio/mpeg" });
    const url = URL.createObjectURL(blob);
    soundTracks[soundKey].blobUrl = url;
    soundTracks[soundKey].loaded = true;
  } catch (err) {
    console.error(`Failed to load ${soundKey}:`, err);
  }
}

function toggleSoundTrack(soundKey) {
  const track = soundTracks[soundKey];
  if (!track || !track.loaded) return;

  if (track.playing) {
    fadeOutSound(soundKey);
  } else {
    fadeInSound(soundKey);
  }
}

function fadeInSound(soundKey) {
  const track = soundTracks[soundKey];

  if (!globalAudioCtx) {
    globalAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }

  if (!track.ctx) {
    track.ctx = globalAudioCtx;

    // Initialize global analyser if not exists
    if (!globalAnalyser) {
      globalAnalyser = globalAudioCtx.createAnalyser();
      globalAnalyser.fftSize = 256;
      globalAnalyser.connect(globalAudioCtx.destination);
    }
  }

  if (!track.audio) {
    track.audio = new Audio(track.blobUrl);
    track.audio.loop = true;
    track.audio.crossOrigin = "anonymous";

    track.sourceNode = track.ctx.createMediaElementSource(track.audio);
    track.gainNode = track.ctx.createGain();

    // Connect chain: Source -> Gain -> Analyser
    track.sourceNode.connect(track.gainNode);
    track.gainNode.connect(globalAnalyser);
  }

  if (track.ctx.state === "suspended") {
    track.ctx.resume();
  }

  const targetGain = track.volume / 100;
  track.gainNode.gain.setValueAtTime(0, track.ctx.currentTime);
  track.gainNode.gain.linearRampToValueAtTime(targetGain, track.ctx.currentTime + FADE_DURATION / 1000);

  track.audio.play().catch(err => console.error("Play error:", err));
  track.playing = true;
  updateSoundTrackUI(soundKey);
  scheduleSoundSave();
  startVisualizer();
}

function fadeOutSound(soundKey) {
  const track = soundTracks[soundKey];
  if (!track.audio || !track.gainNode) return;

  const now = track.ctx.currentTime;
  track.gainNode.gain.setValueAtTime(track.gainNode.gain.value, now);
  track.gainNode.gain.linearRampToValueAtTime(0, now + FADE_DURATION / 1000);

  setTimeout(() => {
    track.audio.pause();
    track.playing = false;
    updateSoundTrackUI(soundKey);
    scheduleSoundSave();
  }, FADE_DURATION);
}

function setSoundVolume(soundKey, vol) {
  const track = soundTracks[soundKey];
  track.volume = vol;

  if (track.gainNode && track.playing) {
    const now = track.ctx.currentTime;
    track.gainNode.gain.setValueAtTime(track.gainNode.gain.value, now);
    track.gainNode.gain.linearRampToValueAtTime(vol / 100, now + 0.1);
  }
}

function updateSoundTrackUI(soundKey) {
  const track = soundTracks[soundKey];
  const el = track.el;
  if (!el) return;

  const playIcon = el.querySelector(".icon-play");
  const pauseIcon = el.querySelector(".icon-pause");

  if (track.playing) {
    el.classList.add("active");
    if (playIcon) playIcon.style.display = "none";
    if (pauseIcon) pauseIcon.style.display = "block";
  } else {
    el.classList.remove("active");
    if (playIcon) playIcon.style.display = "block";
    if (pauseIcon) pauseIcon.style.display = "none";
  }
}

function updateSoundSliderFill(slider) {
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const val = parseFloat(slider.value) || 0;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.background = `linear-gradient(to right, var(--s-bronze-dim) 0%, var(--s-bronze) ${pct}%, var(--s-slider-track) ${pct}%, var(--s-slider-track) 100%)`;
}

async function loadSoundSettings() {
  try {
    const raw = await invoke("get_setting", { key: "sounds_state" });
    if (raw) {
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("Failed to load sounds settings:", err);
  }
  return {};
}

function scheduleSoundSave() {
  clearTimeout(soundSaveTimer);
  soundSaveTimer = setTimeout(() => saveSoundSettings(), 500);
}

async function saveSoundSettings() {
  const state = {};
  for (const [key, track] of Object.entries(soundTracks)) {
    state[key] = {
      volume: track.volume,
      playing: track.playing,
    };
  }

  try {
    await invoke("set_setting", {
      key: "sounds_state",
      value: JSON.stringify(state),
    });
  } catch (err) {
    console.error("Failed to save sounds settings:", err);
  }
}

// ── Visualizer ──

function startVisualizer() {
  if (visualizerAnimationId) return;

  const canvas = document.getElementById("sound-visualizer");
  if (!canvas || !globalAnalyser) return;

  const ctx = canvas.getContext("2d");
  const bufferLength = globalAnalyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  // Set canvas size
  const resize = () => {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
  };
  window.addEventListener("resize", resize);
  resize();

  const draw = () => {
    visualizerAnimationId = requestAnimationFrame(draw);
    globalAnalyser.getByteFrequencyData(dataArray);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const barWidth = (canvas.width / bufferLength) * 2.5;
    let barHeight;
    let x = 0;

    const computedStyle = getComputedStyle(document.body);
    const accentColor = computedStyle.getPropertyValue("--s-bronze").trim() || "#b5966d";

    for (let i = 0; i < bufferLength; i++) {
      barHeight = (dataArray[i] / 255) * canvas.height;

      ctx.fillStyle = accentColor;
      // Draw centered bars
      ctx.fillRect(x, (canvas.height - barHeight) / 2, barWidth - 1, barHeight);

      x += barWidth;
    }

    // Stop if no sound is playing
    const anyPlaying = Object.values(soundTracks).some(t => t.playing);
    if (!anyPlaying) {
      const allSilent = dataArray.every(v => v === 0);
      if (allSilent) {
        cancelAnimationFrame(visualizerAnimationId);
        visualizerAnimationId = null;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
  };

  draw();
}

// ── Auto Updater ──

async function initUpdater() {
  try {
    const newVersion = await invoke("check_update");
    if (newVersion) {
      const modal = document.getElementById("update-modal");
      const versionSpan = document.getElementById("update-version");
      if (modal && versionSpan) {
        versionSpan.textContent = `v${newVersion}`;
        modal.style.display = "flex";

        document.getElementById("update-btn-install").addEventListener("click", async () => {
          const btn = document.getElementById("update-btn-install");
          btn.textContent = translate("update.installing") || "Installing...";
          btn.disabled = true;
          try {
            await invoke("install_update");
          } catch (e) {
            console.error("Update failed:", e);
            btn.textContent = "Failed";
          }
        });

        document.getElementById("update-btn-skip").addEventListener("click", () => {
          modal.style.display = "none";
        });
      }
    }
  } catch (err) {
    console.error("Failed to check for updates:", err);
  }
}

// Run updater check
setTimeout(initUpdater, 2000);

// ── Data Export ──

async function handleDataExport(format) {
  try {
    const savedPath = await invoke("export_data", { format });
    if (savedPath) {
      const successMsg = translate("settings.exportSuccess") || "Data exported successfully to:";
      alert(`${successMsg}\n${savedPath}`);
    }
  } catch (err) {
    console.error("Export failed:", err);
    alert(translate("settings.exportFailed") || "Failed to export data.");
  }
}

document.getElementById("export-csv-btn")?.addEventListener("click", () => handleDataExport("csv"));
document.getElementById("export-json-btn")?.addEventListener("click", () => handleDataExport("json"));

document.querySelectorAll(".chart-period-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    // Remove active class from all
    document.querySelectorAll(".chart-period-btn").forEach(b => {
      b.classList.remove("active");
      b.setAttribute("aria-pressed", "false");
    });
    // Add active to clicked
    const target = e.target;
    target.classList.add("active");
    target.setAttribute("aria-pressed", "true");
    
    // Update period and fetch
    currentChartPeriod = target.getAttribute("data-chart-period") || "daily";
    fetchAndRenderDailyStats();
  });
});
