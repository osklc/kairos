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

  if (!statTotalEl || !statProdEl || !statBreakEl || !statLongestEl) return;

  try {
    const summary = await invoke("get_today_summary");
    statTotalEl.textContent = formatDuration(summary.total_screen_time_seconds);
    statProdEl.textContent = formatDuration(summary.productive_time_seconds);

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
let lastDailyStatsJson = "";

async function fetchAndRenderDailyStats() {
  const canvas = document.getElementById("daily-chart");
  if (!canvas) return;

  try {
    const stats = await invoke("get_daily_stats");
    const statsJson = JSON.stringify(stats);

    // Only update if data changed or chart doesn't exist
    if (statsJson === lastDailyStatsJson && dailyChart) {
      return;
    }
    lastDailyStatsJson = statsJson;

    const labels = stats.map(s => s.day);
    const data = stats.map(s => s.total_seconds / 3600); // hours

    const computedStyle = getComputedStyle(document.body);
    const chartBgColor = computedStyle.getPropertyValue('--chart-color').trim() || 'rgba(78, 158, 229, 0.6)';
    const chartBorderColor = computedStyle.getPropertyValue('--accent-color').trim() || 'rgba(78, 158, 229, 1)';

    if (dailyChart) {
      dailyChart.data.labels = labels;
      dailyChart.data.datasets[0].data = data;
      dailyChart.data.datasets[0].backgroundColor = chartBgColor;
      dailyChart.data.datasets[0].borderColor = chartBorderColor;
      dailyChart.update();
      return;
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
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: function (value) {
                const hours = Math.floor(value);
                const minutes = Math.round((value - hours) * 60);
                const hLabel = translate("duration.hours");
                const mLabel = translate("duration.minutes");
                if (minutes === 0) return hours + hLabel;
                return `${hours}${hLabel} ${minutes}${mLabel}`;
              }
            }
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

  // Re-render chart to pick up new theme colors
  fetchAndRenderDailyStats();
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
    hourly: "pages.hourly",
    daily: "pages.daily",
    focus: "pages.focus",
    pomodoro: "pages.pomodoro",
    goals: "pages.goals",
    notes: "pages.notes",
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
    } else if (pageId === "page-settings") {
      loadAppCategories();
    } else if (pageId === "page-daily") {
      fetchAndRenderDailyStats();
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
    modalAppName.textContent = currentAskApp;
    categoryModal.style.display = "flex";
  }

  if (categoryModal && modalAppName) {
    listen("ask_category", (event) => {
      const isDisabled = localStorage.getItem(DISABLE_PROMPT_KEY) === "true";
      if (isDisabled) return;

      askQueue.push(event.payload.app_name);
      processAskQueue();
    });

    document.querySelectorAll(".modal-buttons button[data-cat]").forEach(btn => {
      btn.addEventListener("click", async () => {
        const category = btn.getAttribute("data-cat");
        try {
          await invoke("set_app_category", { appName: currentAskApp, category });
          categoryModal.style.display = "none";
          isModalOpen = false;
          fetchAndRenderSummary();
          if (document.querySelector("#page-settings").classList.contains("active")) {
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
});
