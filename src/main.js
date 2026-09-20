const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

import * as Sentry from "@sentry/browser";

function scrubPaths(str) {
  try {
    return String(str)
      .replace(/[A-Za-z]:\\\\[^\s\n"]*/g, '[REDACTED_PATH]')
      .replace(/\/home\/[^\s\n"]*/g, '[REDACTED_PATH]');
  } catch (e) {
    return String(str || '');
  }
}

async function initSentry() {
  try {
    let dsn = await invoke('get_sentry_dsn');
    if (!dsn) return;
    dsn = dsn.trim();
    if (!dsn) return;
    const version = document.querySelector('meta[name="application-version"]')?.getAttribute('content') || 'unknown';
    Sentry.init({
      dsn,
      release: version,
      beforeSend(event) {
        try {
          if (event.message) event.message = scrubPaths(event.message);
          if (event.exception && event.exception.values) {
            event.exception.values.forEach(v => {
              if (v.value) v.value = scrubPaths(v.value);
              if (v.stacktrace && v.stacktrace.frames) {
                v.stacktrace.frames.forEach(f => {
                  if (f.filename) f.filename = scrubPaths(f.filename);
                });
              }
            });
          }
        } catch (e) { }
        return event;
      }
    });

    window.addEventListener('error', ev => {
      try { Sentry.captureException(ev.error || ev.message); } catch (e) { }
    });
    window.addEventListener('unhandledrejection', ev => {
      try { Sentry.captureException(ev.reason); } catch (e) { }
    });
  } catch (e) {
    console.error('Sentry init failed', e);
  }
}

initSentry();

// Modal-based bug report UI (Stoic / Minimalist)
document.addEventListener('DOMContentLoaded', () => {
  const bugBtn = document.getElementById('bug-report-btn');
  const modal = document.getElementById('bug-report-modal');
  const descEl = document.getElementById('bug-desc');
  const emailEl = document.getElementById('bug-email');
  const sendBtn = document.getElementById('bug-send');
  const cancelBtn = document.getElementById('bug-cancel');

  function openModal() {
    if (!modal) return;
    descEl.value = '';
    emailEl.value = '';
    modal.style.display = 'flex';
    descEl.focus();
  }
  function closeModal() { if (modal) modal.style.display = 'none'; }

  if (bugBtn) bugBtn.addEventListener('click', openModal);
  const bugBtnCollapsed = document.getElementById('bug-report-collapsed-btn');
  if (bugBtnCollapsed) bugBtnCollapsed.addEventListener('click', openModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  if (sendBtn) sendBtn.addEventListener('click', async () => {
    try {
      const desc = (descEl.value || '').trim();
      const email = (emailEl.value || '').trim();
      if (!desc) { alert('Please provide a short description of the bug.'); return; }

      const scrubbedDesc = scrubPaths(desc);
      const scrubbedEmail = email ? email.replace(/\s+/g, '') : null;

      // Attach user email as a tag (privacy-first) and capture message
      if (scrubbedEmail) {
        Sentry.configureScope(scope => { scope.setTag('user_email', scrubbedEmail); });
      }

      Sentry.captureMessage(`[User BugReport] ${scrubbedDesc}`);

      // Send to backend Sentry hook (Rust) as well for server-side correlation
      await invoke('send_manual_bug_report', { description: scrubbedDesc, email: scrubbedEmail });

      closeModal();
      alert('Thanks — bug report sent.');
    } catch (e) {
      console.error('Failed to send manual bug report', e);
      alert('Failed to send bug report.');
    }
  });
});

let greetInputEl;
let greetMsgEl;
let activeDictionary = {};
let translationsConfig = null;
let activeLanguage = "en";
let internetDateCache = null;
let timeOffset = 0;

const LANGUAGE_STORAGE_KEY = "screen-time-language";
const THEME_STORAGE_KEY = "screen-time-theme";
const DISABLE_PROMPT_KEY = "screen-time-disable-prompt";
const POMO_SETTINGS_KEY = "pomodoro-settings";
const POMO_STATS_KEY = "pomodoro-stats";
const POMO_RING_CIRCUMFERENCE = 2 * Math.PI * 90; // ~565.48
const INTERNET_TIME_ENDPOINTS = [
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
let updateCheckInProgress = false;
const FORCE_UPDATE_FAILURE_KEY = "kairos-debug-force-update-failure";

function shouldForceUpdateFailure() {
  try {
    const params = new URLSearchParams(window.location.search);
    return localStorage.getItem(FORCE_UPDATE_FAILURE_KEY) === "true" || params.get("forceUpdateFailure") === "1";
  } catch {
    return false;
  }
}

function setUpdateStatus(message, isError = false) {
  const statusEl = document.getElementById("update-status");
  if (!statusEl) return;

  if (isError) {
    const linkText = translate("update.downloadManually") || "Download Manually";
    statusEl.innerHTML = `${message} <a href="https://github.com/osklc/kairos/releases/latest" target="_blank" style="color: var(--accent-color); text-decoration: underline; margin-left: 6px; font-weight: 600;">${linkText}</a>`;
    // Attempt to open the latest release page automatically so the user can download manually
    try {
      window.open("https://github.com/osklc/kairos/releases/latest", "_blank");
    } catch (openErr) {
      console.warn("Could not open latest release URL automatically:", openErr);
    }
  } else {
    statusEl.textContent = message;
  }
  statusEl.style.display = message ? "block" : "none";
  statusEl.dataset.state = isError ? "error" : "info";
}

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
    const response = await fetch("i18n.json");
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

// ── Daily Screen Time Goal Logic ──
const DAILY_GOAL_STORAGE_KEY = "screen-time-daily-goal";
let dailyGoalNotifiedToday = false;

function loadDailyGoalSettings() {
  try {
    const data = localStorage.getItem(DAILY_GOAL_STORAGE_KEY);
    if (data) {
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Failed to load daily goal settings:", e);
  }
  return {
    enabled: true,
    targetHours: 4,
    targetMinutes: 0,
    productiveGoalHours: 2,
    productiveGoalMinutes: 0,
    notifyOnExceed: true
  };
}

function saveDailyGoalSettings(settings) {
  try {
    localStorage.setItem(DAILY_GOAL_STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("Failed to save daily goal settings:", e);
  }
}

function checkDailyGoalNotification(goal, currentSeconds, totalGoalSeconds) {
  if (!goal.notifyOnExceed || dailyGoalNotifiedToday) return;

  const todayKey = `daily_goal_notified_${new Date().toISOString().slice(0, 10)}`;
  if (localStorage.getItem(todayKey)) {
    dailyGoalNotifiedToday = true;
    return;
  }

  if (currentSeconds >= totalGoalSeconds && totalGoalSeconds > 0) {
    dailyGoalNotifiedToday = true;
    localStorage.setItem(todayKey, "true");

    const title = translate("goal.notificationTitle");
    const body = translate("goal.notificationBody");

    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    } else if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
      Notification.requestPermission().then(permission => {
        if (permission === "granted") {
          new Notification(title, { body });
        }
      });
    }
  }
}

function updateDailyGoalWidget(summary) {
  const widgetEl = document.getElementById("daily-goal-widget");
  const barEl = document.getElementById("daily-goal-bar");
  const badgeEl = document.getElementById("daily-goal-badge");
  const badgeTextEl = document.getElementById("daily-goal-badge-text");
  const progressTextEl = document.getElementById("daily-goal-progress-text");
  const prodTextEl = document.getElementById("daily-goal-productive-text");

  if (!widgetEl || !barEl || !badgeEl || !badgeTextEl || !progressTextEl) return;

  const goal = loadDailyGoalSettings();
  if (!goal.enabled) {
    widgetEl.style.display = "none";
    return;
  }
  widgetEl.style.display = "block";

  const totalGoalSeconds = (goal.targetHours * 3600) + (goal.targetMinutes * 60);
  const currentTotalSeconds = summary?.total_screen_time_seconds || 0;
  const currentProdSeconds = summary?.productive_time_seconds || 0;

  const percentage = totalGoalSeconds > 0
    ? Math.min(100, Math.round((currentTotalSeconds / totalGoalSeconds) * 100))
    : 0;

  const currentFormatted = formatDuration(currentTotalSeconds);
  const targetFormatted = formatDuration(totalGoalSeconds);
  progressTextEl.textContent = `${currentFormatted} / ${targetFormatted} (${percentage}%)`;

  const prodGoalSeconds = (goal.productiveGoalHours * 3600) + (goal.productiveGoalMinutes * 60);
  if (prodGoalSeconds > 0 && prodTextEl) {
    const prodFormatted = formatDuration(currentProdSeconds);
    const prodTargetFormatted = formatDuration(prodGoalSeconds);
    const prodPercentage = Math.round((currentProdSeconds / prodGoalSeconds) * 100);
    prodTextEl.textContent = `${translate("goal.productiveProgress")}: ${prodFormatted} / ${prodTargetFormatted} (${prodPercentage}%)`;
  } else if (prodTextEl) {
    prodTextEl.textContent = "";
  }

  barEl.style.width = `${percentage}%`;

  barEl.classList.remove("bar-ontrack", "bar-approaching", "bar-exceeded");
  badgeEl.classList.remove("badge-ontrack", "badge-approaching", "badge-exceeded");

  if (percentage >= 100) {
    barEl.classList.add("bar-exceeded");
    badgeEl.classList.add("badge-exceeded");
    badgeTextEl.textContent = translate("goal.exceeded");
    checkDailyGoalNotification(goal, currentTotalSeconds, totalGoalSeconds);
  } else if (percentage >= 80) {
    barEl.classList.add("bar-approaching");
    badgeEl.classList.add("badge-approaching");
    badgeTextEl.textContent = translate("goal.approaching");
  } else {
    barEl.classList.add("bar-ontrack");
    badgeEl.classList.add("badge-ontrack");
    badgeTextEl.textContent = translate("goal.onTrack");
  }
}

function initDailyGoalSettingsUI() {
  const enableToggle = document.getElementById("daily-goal-enable-toggle");
  const maxHoursEl = document.getElementById("daily-goal-max-hours");
  const maxMinsEl = document.getElementById("daily-goal-max-minutes");
  const prodHoursEl = document.getElementById("daily-goal-prod-hours");
  const prodMinsEl = document.getElementById("daily-goal-prod-minutes");
  const notifyToggle = document.getElementById("daily-goal-notify-toggle");
  const saveBtn = document.getElementById("save-daily-goal-btn");
  const statusEl = document.getElementById("save-daily-goal-status");

  if (!enableToggle || !maxHoursEl || !saveBtn) return;

  const goal = loadDailyGoalSettings();
  enableToggle.checked = goal.enabled;
  maxHoursEl.value = goal.targetHours;
  maxMinsEl.value = goal.targetMinutes;
  if (prodHoursEl) prodHoursEl.value = goal.productiveGoalHours;
  if (prodMinsEl) prodMinsEl.value = goal.productiveGoalMinutes;
  if (notifyToggle) notifyToggle.checked = goal.notifyOnExceed;

  saveBtn.addEventListener("click", () => {
    const updated = {
      enabled: enableToggle.checked,
      targetHours: Math.max(0, parseInt(maxHoursEl.value) || 0),
      targetMinutes: Math.max(0, Math.min(59, parseInt(maxMinsEl.value) || 0)),
      productiveGoalHours: Math.max(0, parseInt(prodHoursEl?.value) || 0),
      productiveGoalMinutes: Math.max(0, Math.min(59, parseInt(prodMinsEl?.value) || 0)),
      notifyOnExceed: notifyToggle ? notifyToggle.checked : true
    };
    saveDailyGoalSettings(updated);
    fetchAndRenderSummary();

    if (statusEl) {
      statusEl.style.display = "inline";
      setTimeout(() => {
        statusEl.style.display = "none";
      }, 2500);
    }
  });
}

// ── Ideal Time Balance Widget ──

function renderIdealTimeBar(summary) {
  const widgetEl = document.getElementById("ideal-time-widget");
  const fillProdEl = document.getElementById("ideal-time-fill-productive");
  const fillNeutEl = document.getElementById("ideal-time-fill-neutral");
  const fillDistEl = document.getElementById("ideal-time-fill-distracting");
  const ratioTextEl = document.getElementById("ideal-time-ratio-text");
  const guideTextEl = document.getElementById("ideal-time-guide-text");

  if (!widgetEl || !fillProdEl || !fillNeutEl || !fillDistEl || !ratioTextEl || !guideTextEl) return;

  const total = summary?.total_screen_time_seconds || 0;
  const prod = summary?.productive_time_seconds || 0;
  const dist = summary?.distracting_time_seconds || 0;
  const neutral = Math.max(0, total - prod - dist);

  if (total === 0) {
    fillProdEl.style.width = "0%";
    fillNeutEl.style.width = "0%";
    fillDistEl.style.width = "0%";
    ratioTextEl.textContent = "0% Productive";
    guideTextEl.textContent = translate("idealTime.onTrack");
    return;
  }

  const prodPct = Math.round((prod / total) * 100);
  const neutPct = Math.round((neutral / total) * 100);
  const distPct = Math.max(0, 100 - prodPct - neutPct);

  fillProdEl.style.width = `${prodPct}%`;
  fillNeutEl.style.width = `${neutPct}%`;
  fillDistEl.style.width = `${distPct}%`;

  ratioTextEl.textContent = `${prodPct}% ${translate("daily.productive")}`;

  if (prodPct >= 60) {
    guideTextEl.textContent = translate("idealTime.onTrack");
  } else if (distPct <= 25) {
    guideTextEl.textContent = translate("idealTime.balanced");
  } else {
    guideTextEl.textContent = translate("idealTime.needsFocus");
  }
}

// ── App-Specific Time Limits ──

async function initAppLimits() {
  const selectEl = document.getElementById("app-limit-select");
  const minutesInput = document.getElementById("app-limit-minutes");
  const notifyCheck = document.getElementById("app-limit-notify");
  const saveBtn = document.getElementById("save-app-limit-btn");
  const statusMsg = document.getElementById("app-limit-status-msg");

  if (!selectEl || !saveBtn) return;

  await populateAppLimitSelect();
  await renderAppLimitsList();

  saveBtn.addEventListener("click", async () => {
    const appName = selectEl.value;
    const minutes = parseInt(minutesInput.value, 10) || 0;
    const notifyEnabled = notifyCheck ? notifyCheck.checked : true;

    if (!appName || minutes <= 0) return;

    try {
      await invoke("set_app_limit", { appName, maxMinutes: minutes, notifyEnabled });
      if (statusMsg) {
        statusMsg.textContent = translate("appLimits.limitSaved");
        statusMsg.style.display = "inline";
        setTimeout(() => { statusMsg.style.display = "none"; }, 2500);
      }
      await renderAppLimitsList();
    } catch (err) {
      console.error("Failed to save app limit:", err);
    }
  });
}

async function populateAppLimitSelect() {
  const selectEl = document.getElementById("app-limit-select");
  if (!selectEl) return;

  try {
    const apps = await invoke("get_all_apps");
    selectEl.innerHTML = "";
    if (!apps || apps.length === 0) {
      const opt = document.createElement("option");
      opt.value = "";
      opt.textContent = translate("settings.noApps");
      selectEl.appendChild(opt);
      return;
    }
    apps.forEach(app => {
      const opt = document.createElement("option");
      opt.value = app.app_name;
      opt.textContent = app.app_name;
      selectEl.appendChild(opt);
    });
  } catch (err) {
    console.error("Failed to populate app limit select:", err);
  }
}

async function renderAppLimitsList() {
  const container = document.getElementById("app-limits-list");
  if (!container) return;

  try {
    const limits = await invoke("get_app_limits");
    container.innerHTML = "";

    if (!limits || limits.length === 0) {
      container.innerHTML = `<p style="color: var(--text-muted); font-size: 0.88rem;">${translate("appLimits.noLimits")}</p>`;
      return;
    }

    limits.forEach(limit => {
      const item = document.createElement("div");
      item.className = "app-limit-item";

      const info = document.createElement("div");
      info.className = "app-limit-info";

      const name = document.createElement("span");
      name.className = "app-limit-name";
      name.textContent = limit.app_name;

      const time = document.createElement("span");
      time.className = "app-limit-time";
      time.textContent = `${limit.max_minutes}m / day`;

      info.appendChild(name);
      info.appendChild(time);

      const actions = document.createElement("div");
      actions.className = "app-limit-actions";

      const delBtn = document.createElement("button");
      delBtn.className = "btn-delete-limit";
      delBtn.textContent = translate("common.close");
      delBtn.addEventListener("click", async () => {
        try {
          await invoke("delete_app_limit", { appName: limit.app_name });
          await renderAppLimitsList();
        } catch (err) {
          console.error("Failed to delete app limit:", err);
        }
      });

      actions.appendChild(delBtn);
      item.appendChild(info);
      item.appendChild(actions);
      container.appendChild(item);
    });
  } catch (err) {
    console.error("Failed to render app limits list:", err);
  }
}

async function checkAppLimitsExceeded() {
  try {
    const limits = await invoke("get_app_limits");
    if (!limits || limits.length === 0) return;

    const usages = await invoke("get_app_usage");
    if (!usages) return;

    const usageMap = new Map();
    usages.forEach(u => usageMap.set(u.app_name, u.duration_seconds));

    const todayKey = new Date().toISOString().slice(0, 10);

    for (const limit of limits) {
      const durationSec = usageMap.get(limit.app_name) || 0;
      const maxSec = limit.max_minutes * 60;

      if (durationSec >= maxSec && limit.notify_enabled) {
        const notifKey = `app_limit_notified_${todayKey}_${limit.app_name}`;
        if (!localStorage.getItem(notifKey)) {
          localStorage.setItem(notifKey, "true");

          const title = translate("appLimits.exceededNotifyTitle");
          const bodyTemplate = translate("appLimits.exceededNotifyBody");
          const body = bodyTemplate.replace("{app}", limit.app_name);

          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification(title, { body });
          } else if (typeof Notification !== "undefined" && Notification.permission !== "denied") {
            Notification.requestPermission().then(permission => {
              if (permission === "granted") {
                new Notification(title, { body });
              }
            });
          }
        }
      }
    }
  } catch (err) {
    console.error("Failed to check app limits:", err);
  }
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

    updateDailyGoalWidget(summary);
    renderIdealTimeBar(summary);
    checkAppLimitsExceeded();
  } catch (err) {
    console.error("Failed to fetch summary:", err);
  }
}

// ── Memento Mori Widget ──

function updateMementoMoriWidget() {
  const timeEl = document.getElementById("memento-mori-time");
  const barEl = document.getElementById("memento-mori-bar");

  if (!timeEl || !barEl) return;

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const timeSinceStartMs = now - startOfDay;
  const totalMsInDay = 24 * 60 * 60 * 1000;
  // Use elapsed-day percentage so at day start the bar is 0% (not 100% showing 24h left)
  const percentageElapsed = Math.max(0, Math.min(100, (timeSinceStartMs / totalMsInDay) * 100));

  const endOfDay = new Date(startOfDay.getTime() + totalMsInDay - 1);
  const timeLeftMs = endOfDay - now;
  const hoursLeft = Math.floor(timeLeftMs / (1000 * 60 * 60));
  const minutesLeft = Math.floor((timeLeftMs % (1000 * 60 * 60)) / (1000 * 60));

  timeEl.textContent = `${hoursLeft}h ${minutesLeft}m`;
  barEl.style.width = `${percentageElapsed}%`;
}

function initMementoMoriWidget() {
  updateMementoMoriWidget();

  // Update every second
  setInterval(updateMementoMoriWidget, 1000);
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

let appUsagesData = [];
let appCategoryMap = new Map();
let currentAppFilter = "all";
let currentAppSearch = "";
let isAppUsageUIInitialized = false;

function initAppUsageUI() {
  if (isAppUsageUIInitialized) return;
  isAppUsageUIInitialized = true;

  const searchInput = document.getElementById("app-usage-search");
  const clearBtn = document.getElementById("app-usage-search-clear");
  const filterBtns = document.querySelectorAll(".app-filter-btn");

  if (searchInput) {
    searchInput.addEventListener("input", (e) => {
      currentAppSearch = e.target.value.trim().toLowerCase();
      if (clearBtn) {
        clearBtn.style.display = currentAppSearch.length > 0 ? "block" : "none";
      }
      renderAppUsageList();
    });
  }

  if (clearBtn && searchInput) {
    clearBtn.addEventListener("click", () => {
      searchInput.value = "";
      currentAppSearch = "";
      clearBtn.style.display = "none";
      searchInput.focus();
      renderAppUsageList();
    });
  }

  filterBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentAppFilter = btn.getAttribute("data-filter") || "all";
      renderAppUsageList();
    });
  });
}

function updateAppUsageStatCards() {
  const totalSeconds = appUsagesData.reduce((acc, u) => acc + (u.duration_seconds || 0), 0);
  const appCount = appUsagesData.length;
  const topApp = appUsagesData[0];
  const distractingSeconds = appUsagesData
    .filter(u => (u.category || "uncategorized") === "distracting")
    .reduce((acc, u) => acc + (u.duration_seconds || 0), 0);

  const totalTimeEl = document.getElementById("app-stat-total-time");
  const countEl = document.getElementById("app-stat-count");
  const topEl = document.getElementById("app-stat-top");
  const distractingTimeEl = document.getElementById("app-stat-distracting-time");
  const subtitleEl = document.getElementById("app-usage-subtitle");

  if (totalTimeEl) totalTimeEl.textContent = formatDuration(totalSeconds);
  if (countEl) countEl.textContent = `${appCount}`;
  if (topEl) {
    if (topApp) {
      topEl.textContent = `${topApp.app_name}`;
      topEl.title = `${topApp.app_name} (${formatDuration(topApp.duration_seconds)})`;
    } else {
      topEl.textContent = "—";
      topEl.title = "—";
    }
  }
  if (distractingTimeEl) distractingTimeEl.textContent = formatDuration(distractingSeconds);
  if (subtitleEl) {
    subtitleEl.textContent = `${appCount} ${translate("apps.trackedToday")}`;
  }
}

function renderAppUsageList() {
  const containerEl = document.getElementById("app-usage-list-container");
  if (!containerEl) return;

  containerEl.innerHTML = "";

  if (appUsagesData.length === 0) {
    containerEl.innerHTML = `
      <div class="app-usage-empty">
        <div class="app-empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
        </div>
        <p class="app-empty-title">${translate("apps.noActivity")}</p>
        <p class="app-empty-subtitle">${translate("apps.openAppToTrack")}</p>
      </div>
    `;
    return;
  }

  // Filter items
  const filtered = appUsagesData.filter(item => {
    const category = item.category || "uncategorized";
    const matchesFilter = (currentAppFilter === "all") || (category === currentAppFilter);
    const matchesSearch = !currentAppSearch || item.app_name.toLowerCase().includes(currentAppSearch);
    return matchesFilter && matchesSearch;
  });

  if (filtered.length === 0) {
    containerEl.innerHTML = `
      <div class="app-usage-empty">
        <div class="app-empty-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="8"></circle>
            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
          </svg>
        </div>
        <p class="app-empty-title">${translate("apps.noMatching")}</p>
      </div>
    `;
    return;
  }

  // Calculate total seconds among all apps for relative percentage calculation
  const totalSecondsAll = appUsagesData.reduce((acc, u) => acc + (u.duration_seconds || 0), 0) || 1;

  filtered.forEach(item => {
    const originalRank = appUsagesData.findIndex(u => u.app_name === item.app_name) + 1;
    const duration = item.duration_seconds || 0;
    const percentage = Math.max(1, Math.round((duration / totalSecondsAll) * 1000) / 10);
    const category = item.category || "uncategorized";

    // Monogram (1 or 2 uppercase letters)
    const cleanName = item.app_name.replace(/[^a-zA-Z0-9]/g, ' ').trim();
    const parts = cleanName.split(/\s+/).filter(Boolean);
    let initials = "AP";
    if (parts.length >= 2) {
      initials = (parts[0][0] + parts[1][0]).toUpperCase();
    } else if (parts.length === 1 && parts[0].length >= 2) {
      initials = parts[0].slice(0, 2).toUpperCase();
    } else if (parts.length === 1) {
      initials = parts[0][0].toUpperCase();
    }

    const card = document.createElement("div");
    card.className = "app-item-card";

    let rankClass = "";
    if (originalRank === 1) rankClass = "rank-1";
    else if (originalRank === 2) rankClass = "rank-2";
    else if (originalRank === 3) rankClass = "rank-3";

    card.innerHTML = `
      <div class="app-item-main">
        <div class="app-item-identity">
          <span class="app-rank-badge ${rankClass}">#${originalRank}</span>
          <div class="app-avatar cat-${category}">
            <span>${initials}</span>
          </div>
          <div class="app-meta">
            <span class="app-name" title="${item.app_name}">${item.app_name}</span>
            <div class="app-cat-badge-container">
              <select class="app-cat-select cat-${category}" data-app="${item.app_name}">
                <option value="productive" ${category === "productive" ? "selected" : ""}>${translate("categories.productive")}</option>
                <option value="neutral" ${category === "neutral" ? "selected" : ""}>${translate("categories.neutral")}</option>
                <option value="distracting" ${category === "distracting" ? "selected" : ""}>${translate("categories.distracting")}</option>
                <option value="uncategorized" ${category === "uncategorized" ? "selected" : ""}>${translate("categories.uncategorized")}</option>
              </select>
            </div>
          </div>
        </div>
        <div class="app-item-metrics">
          <span class="app-duration-val">${formatDuration(duration)}</span>
          <span class="app-percent-val">${percentage}%</span>
        </div>
      </div>
      <div class="app-progress-track">
        <div class="app-progress-fill cat-${category}" style="width: ${Math.min(100, percentage)}%;"></div>
      </div>
    `;

    // Category changer event listener
    const selectEl = card.querySelector(".app-cat-select");
    if (selectEl) {
      selectEl.addEventListener("change", async (e) => {
        const newCat = e.target.value;
        try {
          await invoke("set_app_category", { appName: item.app_name, category: newCat });
          item.category = newCat;
          appCategoryMap.set(item.app_name, newCat);

          // Update this item's styling directly
          selectEl.className = `app-cat-select cat-${newCat}`;
          const avatar = card.querySelector(".app-avatar");
          if (avatar) avatar.className = `app-avatar cat-${newCat}`;
          const progressFill = card.querySelector(".app-progress-fill");
          if (progressFill) progressFill.className = `app-progress-fill cat-${newCat}`;

          // Recompute distracting time & stats
          updateAppUsageStatCards();
          fetchAndRenderSummary();
          if (typeof renderDailyPieChart === "function") {
            renderDailyPieChart();
          }
        } catch (err) {
          console.error("Failed to update app category:", err);
        }
      });
    }

    containerEl.appendChild(card);
  });
}

async function fetchAndRenderAppUsage() {
  initAppUsageUI();

  try {
    const [usages, allApps] = await Promise.all([
      invoke("get_app_usage").catch(err => {
        console.error("Failed to fetch app usage:", err);
        return [];
      }),
      invoke("get_all_apps").catch(err => {
        console.error("Failed to fetch all apps for categories:", err);
        return [];
      })
    ]);

    appCategoryMap = new Map((allApps || []).map(a => [a.app_name, a.category]));

    // Attach category to each usage entry
    appUsagesData = (usages || []).map(u => ({
      ...u,
      category: u.category || appCategoryMap.get(u.app_name) || "uncategorized"
    }));

    updateAppUsageStatCards();
    renderAppUsageList();
  } catch (err) {
    console.error("Error in fetchAndRenderAppUsage:", err);
  }
}

let dailyChart = null;
let dailyEnergyTotalChart = null;
let dailyPieChart = null;
let lastDailyStatsJson = "";

let screenTimePeriod = "daily";
let energyPeriod = "daily";
let categoryPeriod = "daily";

async function fetchAndRenderDailyStats() {
  const canvas = document.getElementById("daily-chart");
  if (!canvas) return;

  try {
    let stats;
    if (screenTimePeriod === "weekly") {
      stats = await invoke("get_weekly_stats");
    } else if (screenTimePeriod === "monthly") {
      stats = await invoke("get_monthly_stats");
    } else if (screenTimePeriod === "custom") {
      const startInput = document.getElementById("screen-time-start-date")?.value;
      const endInput = document.getElementById("screen-time-end-date")?.value;
      if (startInput && endInput) {
        const startDate = new Date(startInput + "T00:00:00");
        const endDate = new Date(endInput + "T23:59:59");
        const startTimestamp = Math.floor(startDate.getTime() / 1000);
        const endTimestamp = Math.floor(endDate.getTime() / 1000);
        stats = await invoke("get_stats_for_range", { startTimestamp, endTimestamp });
      } else {
        stats = [];
      }
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

    if (energyPeriod === "weekly") {
      for (let i = 11; i >= 0; i--) {
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - now.getDay() - i * 7 + 1); // Monday of that week
        let weekTotal = 0;
        for (let d = 0; d < 7; d++) {
          const tempDate = new Date(startOfWeek);
          tempDate.setDate(startOfWeek.getDate() + d);
          const dayKey = `${tempDate.getFullYear()}-${String(tempDate.getMonth() + 1).padStart(2, "0")}-${String(tempDate.getDate()).padStart(2, "0")}`;
          const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
          weekTotal += parseFloat(localStorage.getItem(storageKey) || "0");
        }
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);
        const label = `${String(startOfWeek.getMonth() + 1).padStart(2, "0")}/${String(startOfWeek.getDate()).padStart(2, "0")} - ${String(endOfWeek.getMonth() + 1).padStart(2, "0")}/${String(endOfWeek.getDate()).padStart(2, "0")}`;
        labels.push(label);
        data.push(weekTotal);
      }
    } else if (energyPeriod === "monthly") {
      const monthNamesEn = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      const monthNamesTr = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];
      const activeLang = localStorage.getItem(LANGUAGE_STORAGE_KEY) || "en";
      for (let i = 11; i >= 0; i--) {
        const tempDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const year = tempDate.getFullYear();
        const month = tempDate.getMonth();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        let monthTotal = 0;
        for (let d = 1; d <= daysInMonth; d++) {
          const dayKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
          monthTotal += parseFloat(localStorage.getItem(storageKey) || "0");
        }
        const monthLabel = activeLang === "tr" ? monthNamesTr[month] : monthNamesEn[month];
        labels.push(`${monthLabel} ${year}`);
        data.push(monthTotal);
      }
    } else if (energyPeriod === "custom") {
      const startInput = document.getElementById("energy-start-date")?.value;
      const endInput = document.getElementById("energy-end-date")?.value;
      if (startInput && endInput) {
        const start = new Date(startInput + "T00:00:00");
        const end = new Date(endInput + "T00:00:00");
        const dayDiff = Math.round((end - start) / (1000 * 60 * 60 * 24));
        for (let i = 0; i <= dayDiff; i++) {
          const d = new Date(start);
          d.setDate(d.getDate() + i);
          const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
          const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
          const kwh = parseFloat(localStorage.getItem(storageKey) || "0");
          labels.push(dayKey);
          data.push(kwh);
        }
      }
    } else {
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
    }

    const computedStyle = getComputedStyle(document.body);
    const accentColor = computedStyle.getPropertyValue('--accent-color').trim() || '#5a9ddf';
    const chartBgColor = computedStyle.getPropertyValue('--chart-color').trim() || 'rgba(90, 157, 223, 0.6)';
    const chartTextColor = computedStyle.getPropertyValue('--chart-text-color').trim() || '#000000';
    const chartGridColor = computedStyle.getPropertyValue('--chart-grid-color').trim() || 'rgba(0,0,0,0.1)';

    const emptyDiv = document.getElementById("daily-energy-empty");

    // Filter out periods with 0 energy to match screen time chart behavior
    const finalLabels = [];
    const finalData = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i] > 0) {
        finalLabels.push(labels[i]);
        finalData.push(data[i]);
      }
    }

    if (finalData.length === 0) {
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
        labels: finalLabels,
        datasets: [{
          label: translate("daily.energyTotalTitle"),
          data: finalData,
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
    let summary;
    if (categoryPeriod === "weekly") {
      const today = new Date();
      const lastWeek = new Date();
      lastWeek.setDate(today.getDate() - 7);
      const startTimestamp = Math.floor(lastWeek.getTime() / 1000);
      const endTimestamp = Math.floor(today.getTime() / 1000);
      summary = await invoke("get_range_summary", { startTimestamp, endTimestamp });
    } else if (categoryPeriod === "monthly") {
      const today = new Date();
      const lastMonth = new Date();
      lastMonth.setDate(today.getDate() - 30);
      const startTimestamp = Math.floor(lastMonth.getTime() / 1000);
      const endTimestamp = Math.floor(today.getTime() / 1000);
      summary = await invoke("get_range_summary", { startTimestamp, endTimestamp });
    } else if (categoryPeriod === "custom") {
      const startInput = document.getElementById("category-start-date")?.value;
      const endInput = document.getElementById("category-end-date")?.value;
      if (startInput && endInput) {
        const startDate = new Date(startInput + "T00:00:00");
        const endDate = new Date(endInput + "T23:59:59");
        const startTimestamp = Math.floor(startDate.getTime() / 1000);
        const endTimestamp = Math.floor(endDate.getTime() / 1000);
        summary = await invoke("get_range_summary", { startTimestamp, endTimestamp });
      } else {
        summary = { total_screen_time_seconds: 0, productive_time_seconds: 0, distracting_time_seconds: 0 };
      }
    } else {
      summary = await invoke("get_today_summary");
    }
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

function getCurrentDate() {
  return new Date(Date.now() + timeOffset);
}

function renderCurrentDate(currentDateEl) {
  if (!currentDateEl) return;
  const currentDate = getCurrentDate();
  currentDateEl.textContent = formatDateForLanguage(currentDate, activeLanguage);
}

async function fetchDateFromInternet() {
  for (const endpoint of INTERNET_TIME_ENDPOINTS) {
    try {
      const response = await fetch(endpoint);
      if (!response.ok) continue;

      const payload = await response.json();
      const rawDateValue = payload.datetime || payload.dateTime;
      if (!rawDateValue) continue;

      // Ensure UTC date strings without timezone indicator are parsed as UTC (append "Z")
      let dateString = rawDateValue;
      if (!dateString.endsWith("Z") && !dateString.includes("+") && !/-\d{2}:\d{2}$/.test(dateString)) {
        dateString += "Z";
      }

      const parsedDate = new Date(dateString);
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
    const internetDate = await fetchDateFromInternet();
    if (internetDate) {
      internetDateCache = internetDate;
      timeOffset = internetDate.getTime() - Date.now();
    } else {
      internetDateCache = new Date();
      timeOffset = 0;
    }
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
  if (document.querySelector("#page-eco")?.classList.contains("active")) {
    renderEcoReceipt();
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

// ───── Eco-Area & Thermal Receipt ─────
let ecoPeriod = "daily";

function getEcoEnergyData(period = ecoPeriod) {
  const now = new Date();
  let totalKwh = 0;
  let dayCount = 1;

  if (period === "weekly") {
    dayCount = 7;
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
      totalKwh += parseFloat(localStorage.getItem(storageKey) || "0");
    }
  } else if (period === "monthly") {
    dayCount = 30;
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
      totalKwh += parseFloat(localStorage.getItem(storageKey) || "0");
    }
  } else if (period === "custom") {
    const startInput = document.getElementById("eco-start-date")?.value;
    const endInput = document.getElementById("eco-end-date")?.value;
    if (startInput && endInput) {
      const start = new Date(startInput + "T00:00:00");
      const end = new Date(endInput + "T00:00:00");
      const dayDiff = Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
      dayCount = dayDiff + 1;
      for (let i = 0; i <= dayDiff; i++) {
        const d = new Date(start);
        d.setDate(d.getDate() + i);
        const dayKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        const storageKey = ENERGY_STORAGE_PREFIX + dayKey;
        totalKwh += parseFloat(localStorage.getItem(storageKey) || "0");
      }
    }
  } else {
    // Daily: today's total from localStorage
    dayCount = 1;
    totalKwh = loadTodayTotalKWh();
  }

  totalKwh = Math.max(0, totalKwh);
  const dailyAvgKwh = dayCount > 0 ? totalKwh / dayCount : totalKwh;

  return { totalKwh, dayCount, dailyAvgKwh };
}

function calculateEcoEquivalents(kwh) {
  // Reference coefficients:
  // Water: ~5.0 L / kWh
  // Carbon: ~0.43 kg CO2 / kWh
  // Trees: 1 mature tree absorbs ~21 kg CO2 / year (~0.0575 kg/day). treeDays = carbonKg / 0.0575
  // Smartphone charge: 1 full charge is ~12 Wh (0.012 kWh) -> ~83.3 charges/kWh
  // 10W LED Bulb: 1 kWh = 100 hours
  // Laundry machine: 1 full A+++ cycle = ~1.2 kWh -> cycles = kwh / 1.2
  // Electric Vehicle: ~18 kWh / 100km -> 5.55 km / kWh
  // Average Household: ~9 kWh / day -> % of daily household usage = (kwh / 9) * 100
  // Kettle: 1 kettle boiling (~1.5L) = ~0.1 kWh -> 10 kettles / kWh

  const waterLiters = (kwh * 5.0).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const carbonKg = (kwh * 0.43).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const treeDays = (kwh * 0.43 / 0.0575).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const phones = Math.round(kwh * 83.33).toLocaleString();
  const ledHours = Math.round(kwh * 100).toLocaleString();
  const laundry = (kwh / 1.2).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const evKm = (kwh * 5.55).toLocaleString(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const household = Math.round((kwh / 9.0) * 100).toLocaleString();
  const kettle = Math.round(kwh * 10).toLocaleString();

  return {
    waterLiters,
    carbonKg,
    treeDays,
    phones,
    ledHours,
    laundry,
    evKm,
    household,
    kettle,
  };
}

function renderEcoReceipt() {
  const { totalKwh, dayCount, dailyAvgKwh } = getEcoEnergyData(ecoPeriod);
  const equiv = calculateEcoEquivalents(totalKwh);

  const now = getCurrentDate ? getCurrentDate() : new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");

  const timestampEl = document.getElementById("eco-receipt-timestamp");
  if (timestampEl) {
    timestampEl.textContent = `${day}.${month}.${year} ${hours}:${mins}`;
  }

  const receiptIdEl = document.getElementById("eco-receipt-id");
  if (receiptIdEl) {
    receiptIdEl.textContent = `#ECO-${year}-${month}${day}`;
  }

  // Total kWh readout
  const kwhEl = document.getElementById("eco-receipt-kwh");
  if (kwhEl) {
    kwhEl.textContent = totalKwh.toFixed(3);
  }

  // Daily average readout (shown whenever period spans more than 1 day)
  const dailyAvgContainer = document.getElementById("eco-receipt-daily-avg-container");
  const dailyAvgEl = document.getElementById("eco-receipt-daily-avg");
  if (dailyAvgContainer && dailyAvgEl) {
    if (dayCount > 1) {
      dailyAvgContainer.style.display = "block";
      dailyAvgEl.textContent = dailyAvgKwh.toFixed(3);
    } else {
      dailyAvgContainer.style.display = "none";
    }
  }

  const setItemText = (id, templateKey, val, extraVal) => {
    const el = document.getElementById(id);
    if (!el) return;
    let text = translate(templateKey) || "";
    text = text.replace("{val}", val);
    if (extraVal !== undefined) {
      text = text.replace("{treeVal}", extraVal);
    }
    el.textContent = text;
  };

  setItemText("eco-val-water", "eco.water", equiv.waterLiters);
  setItemText("eco-val-carbon", "eco.carbon", equiv.carbonKg, equiv.treeDays);
  setItemText("eco-val-phones", "eco.phones", equiv.phones);
  setItemText("eco-val-led", "eco.ledBulb", equiv.ledHours);
  setItemText("eco-val-laundry", "eco.laundry", equiv.laundry);
  setItemText("eco-val-ev", "eco.ev", equiv.evKm);
  setItemText("eco-val-home", "eco.household", equiv.household);
  setItemText("eco-val-kettle", "eco.kettle", equiv.kettle);

  // Normalized stamp evaluation:
  // Evaluated on normalized daily average kWh regardless of whether 1 day, 7 days, 30 days, or custom days are selected.
  const stampEl = document.getElementById("eco-stamp");
  if (stampEl) {
    // Reference standard for typical desktop/laptop computer:
    // <= 2.0 kWh / day is high-efficiency / eco champion
    // > 2.0 kWh / day is moderate / aware
    if (dailyAvgKwh <= 2.0) {
      stampEl.textContent = translate("eco.stampChampion") || "TASARRUF ŞAMPİYONU";
      stampEl.classList.remove("eco-aware");
    } else {
      stampEl.textContent = translate("eco.stampEco") || "ÇEVRE DOSTU";
      stampEl.classList.add("eco-aware");
    }
  }
}

function copyReceiptToClipboard() {
  const { totalKwh, dayCount, dailyAvgKwh } = getEcoEnergyData(ecoPeriod);
  const equiv = calculateEcoEquivalents(totalKwh);
  const now = getCurrentDate ? getCurrentDate() : new Date();
  const day = String(now.getDate()).padStart(2, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const year = now.getFullYear();
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  const dateStr = `${day}.${month}.${year} ${hours}:${mins}`;

  let periodName = translate("eco.periodDaily") || "Günlük";
  if (ecoPeriod === "weekly") periodName = translate("eco.periodWeekly") || "Haftalık";
  else if (ecoPeriod === "monthly") periodName = translate("eco.periodMonthly") || "Aylık";
  else if (ecoPeriod === "custom") periodName = translate("eco.periodCustom") || "Özel";

  const receiptHeader = translate("eco.receiptHeader") || "TÜKETİM FİŞİ";
  const equivTitle = translate("eco.equivTitle") || "SOMUT KARŞILIKLAR";

  const lines = [
    "====================================",
    `          ${receiptHeader}`,
    `         KAIROS ECO AUDIT`,
    "====================================",
    `Tarih / Date : ${dateStr}`,
    `Fiş / ID     : #ECO-${year}-${month}${day}`,
    `Dönem / Range: ${periodName} (${dayCount} gün)`,
    "------------------------------------",
    `TOPLAM TÜKETİM : ${totalKwh.toFixed(3)} kWh`,
  ];

  if (dayCount > 1) {
    lines.push(`GÜNLÜK ORTALAMA: ${dailyAvgKwh.toFixed(3)} kWh/gün`);
  }

  lines.push(
    "------------------------------------",
    `${equivTitle}:`,
    `• Su / Water       : ~${equiv.waterLiters} L`,
    `• Karbon / CO₂     : ~${equiv.carbonKg} kg CO₂ (${equiv.treeDays} ağaç-günü)`,
    `• Telefon Şarjı    : ~${equiv.phones} tam şarj`,
    `• 10W LED Ampul    : ~${equiv.ledHours} saat`,
    `• Çamaşır Makinesi : ~${equiv.laundry} devir`,
    `• Elektrikli Araç  : ~${equiv.evKm} km yol`,
    `• Hane Tüketim Payı: ~%${equiv.household}`,
    `• Su Isıtıcı Kettle: ~${equiv.kettle} kez`,
    "------------------------------------",
    `[ ${dailyAvgKwh <= 2.0 ? (translate("eco.stampChampion") || "TASARRUF ŞAMPİYONU") : (translate("eco.stampEco") || "ÇEVRE DOSTU")} ]`,
    translate("eco.thankYou") || "DOĞAYI KORUDUĞUNUZ İÇİN TEŞEKKÜR EDERİZ",
    "===================================="
  );

  const fullText = lines.join("\n");
  navigator.clipboard.writeText(fullText).then(() => {
    const feedbackEl = document.getElementById("eco-copy-feedback");
    if (feedbackEl) {
      feedbackEl.style.display = "inline-block";
      setTimeout(() => {
        feedbackEl.style.display = "none";
      }, 3000);
    }
  }).catch((err) => {
    console.error("Failed to copy receipt:", err);
  });
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

// ── Pomodoro Sound System (Web Audio API — Zero-Latency Preload) ──
const pomoSounds = (() => {
  // Shared AudioContext for all Pomodoro sounds
  let _ctx = null;

  function getCtx() {
    if (!_ctx) {
      _ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return _ctx;
  }

  function resumeCtx() {
    const ctx = getCtx();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function createSound(filePath, volume = 0.6) {
    const sound = {
      buffer: null,
      volume,

      async preload() {
        try {
          const ctx = getCtx();
          const response = await fetch(filePath);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const arrayBuffer = await response.arrayBuffer();
          ctx.decodeAudioData(
            arrayBuffer,
            (decoded) => { this.buffer = decoded; },
            (err) => { console.warn(`[pomoSounds] decode failed for ${filePath}:`, err); }
          );
        } catch (e) {
          console.warn(`[pomoSounds] preload failed for ${filePath}:`, e);
        }
      },

      play() {
        try {
          const ctx = resumeCtx();

          if (!this.buffer) {
            // Fallback to HTML5 Audio if buffer not ready yet
            const fallback = new Audio(filePath);
            fallback.volume = this.volume;
            fallback.play().catch(err => console.warn(`[pomoSounds] fallback play failed:`, err));
            return;
          }

          const source = ctx.createBufferSource();
          source.buffer = this.buffer;

          const gainNode = ctx.createGain();
          gainNode.gain.setValueAtTime(this.volume, ctx.currentTime);

          source.connect(gainNode);
          gainNode.connect(ctx.destination);
          source.start(0);
        } catch (e) {
          console.warn(`[pomoSounds] play failed for ${filePath}:`, e);
        }
      }
    };
    return sound;
  }

  const sounds = {
    start:             createSound('assets/sound-effect/start.wav',              0.65),
    pauseReset:        createSound('assets/sound-effect/pause-reset.wav',        0.55),
    focusEnd:          createSound('assets/sound-effect/focus-end.wav',          0.70),
    breakEnd:          createSound('assets/sound-effect/break-end.wav',          0.70),
    dailyGoalAchieved: createSound('assets/sound-effect/daily-goal-achieved.wav', 0.75),
  };

  async function preloadAll() {
    await Promise.allSettled(Object.values(sounds).map(s => s.preload()));
  }

  return { preloadAll, ...sounds };
})();

// Begin preloading all Pomodoro sounds immediately (non-blocking)
pomoSounds.preloadAll();

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

  // Play start sound (covers both fresh-start and resume-from-pause)
  pomoSounds.start.play();

  pomodoroState.intervalId = setInterval(() => {
    pomodoroState.timeRemaining--;

    if (pomodoroState.timeRemaining <= 0) {
      clearInterval(pomodoroState.intervalId);
      pomodoroState.intervalId = null;
      pomodoroState.isRunning = false;
      pomodoroState.isPaused = false;

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
  pomoSounds.pauseReset.play();
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
  pomoSounds.pauseReset.play();
  updatePomodoroUI();
}

function onPomodoroComplete() {
  const stats = loadPomodoroStats();

  if (pomodoroState.mode === "focus") {
    stats.sessionsCompleted++;
    stats.totalFocusSeconds += pomodoroState.totalDuration;
    savePomodoroStats(stats);

    // Check if daily goal achieved (multiples of longBreakAfter)
    const isDailyGoal = stats.sessionsCompleted > 0 &&
      stats.sessionsCompleted % pomodoroState.settings.longBreakAfter === 0;

    if (isDailyGoal) {
      // Daily goal milestone: play special achievement sound
      pomoSounds.dailyGoalAchieved.play();
      pomodoroState.mode = "longBreak";
      pomodoroState.totalDuration = pomodoroState.settings.longBreakDuration * 60;
    } else {
      // Regular focus session end
      pomoSounds.focusEnd.play();
      pomodoroState.mode = "shortBreak";
      pomodoroState.totalDuration = pomodoroState.settings.shortBreakDuration * 60;
    }
  } else {
    // Break completed
    stats.breaksTaken++;
    savePomodoroStats(stats);
    pomodoroState.mode = "focus";
    pomodoroState.totalDuration = pomodoroState.settings.focusDuration * 60;
    // Break ended — signal user to return to focus
    pomoSounds.breakEnd.play();
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
    eco: "pages.eco",
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
  initMementoMoriWidget();
  initDailyGoalSettingsUI();
  initAppLimits();
  initAppUsageUI();

  function refreshActivePage() {
    renderCurrentDate(currentDateEl);
    const activePage = document.querySelector(".page.active");
    if (!activePage) return;
    const pageId = activePage.id;

    if (pageId === "page-overview") {
      fetchAndRenderSummary();
    } else if (pageId === "page-apps") {
      fetchAndRenderAppUsage();
    } else if (pageId === "page-energy") {
      updateEnergyUI();
    } else if (pageId === "page-eco") {
      renderEcoReceipt();
    } else if (pageId === "page-settings") {
      loadAppCategories();
      populateAppLimitSelect();
      renderAppLimitsList();
    } else if (pageId === "page-daily") {
      if (screenTimePeriod === "daily") {
        fetchAndRenderDailyStats();
      }
      if (energyPeriod === "daily") {
        renderDailyEnergyTotalChart();
      }
      if (categoryPeriod === "daily") {
        renderDailyPieChart();
      }
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
      } else if (pageKey === "eco") {
        renderEcoReceipt();
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

  const stoicToggleEl = document.querySelector('#stoic-notifications-toggle');
  if (stoicToggleEl) {
    const raw = localStorage.getItem('stoic_notifications_enabled');
    const isEnabled = raw === null ? true : raw === 'true';
    stoicToggleEl.checked = isEnabled;
    stoicToggleEl.addEventListener('change', (e) => {
      const checked = e.target.checked;
      localStorage.setItem('stoic_notifications_enabled', checked);
      if (checked && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        Notification.requestPermission().then(() => { /* noop */ });
      }
    });
  }

  const checkUpdatesBtn = document.querySelector("#check-updates-btn");
  if (checkUpdatesBtn) {
    checkUpdatesBtn.addEventListener("click", () => {
      checkForUpdates();
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

  // ── Web Audio API Preload & Playback System (Guarantees True 0ms Latency) ──
  const todoCheckSound = {
    ctx: null,
    buffer: null,
    
    init() {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      }
    },

    async preload() {
      try {
        this.init();
        const response = await fetch("assets/sound-effect/to-do-check.wav");
        const arrayBuffer = await response.arrayBuffer();
        // Decode the binary array buffer into raw uncompressed PCM audio data in RAM
        this.ctx.decodeAudioData(
          arrayBuffer,
          (decodedBuffer) => {
            this.buffer = decodedBuffer;
          },
          (err) => {
            console.error("Error decoding todo audio data:", err);
          }
        );
      } catch (e) {
        console.error("Failed to preload todo check sound:", e);
      }
    },

    play() {
      try {
        this.init();
        if (this.ctx.state === "suspended") {
          this.ctx.resume();
        }

        // Fallback: If Web Audio API buffer isn't loaded/decoded yet, play via HTML5 Audio
        if (!this.buffer) {
          const fallback = new Audio("assets/sound-effect/to-do-check.wav");
          fallback.volume = 0.5;
          fallback.play().catch(e => console.error("Fallback play failed:", e));
          return;
        }

        // Create buffer source node
        const source = this.ctx.createBufferSource();
        source.buffer = this.buffer;

        // Create gain node for volume control
        const gainNode = this.ctx.createGain();
        gainNode.gain.setValueAtTime(0.5, this.ctx.currentTime);

        // Connect nodes: Source -> Gain -> Speakers
        source.connect(gainNode);
        gainNode.connect(this.ctx.destination);

        // Play instantly (0ms delay)
        source.start(0);
      } catch (e) {
        console.error("Web Audio API play failed:", e);
      }
    }
  };

  // Start preloading the audio file immediately in the background
  todoCheckSound.preload();

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
          todoCheckSound.play();
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

  listen("active_window", (event) => {
    const app = event.payload.app_name;
    const title = event.payload.title;
    const activeWindowDisplayEl = document.getElementById("active-window-display");
    if (activeWindowDisplayEl) {
      if (title.toLowerCase().includes(app.toLowerCase())) {
        activeWindowDisplayEl.textContent = title;
      } else {
        activeWindowDisplayEl.textContent = `${app} - ${title}`;
      }
    }

    // Stoic notification: show a native Windows notification when a distracting app becomes active.
    try {
      const enabled = localStorage.getItem('stoic_notifications_enabled');
      // default: enabled if not explicitly disabled
      if (enabled === null || enabled === 'true') {
        const nameLower = app.toLowerCase();
        const distractingKeywords = [
          '(distracting)', 'twitch', 'youtube', 'shorts', 'spotify', 'discord', 'steam', 'epic', 'instagram', 'facebook', 'twitter', 'tiktok', 'reddit', 'netflix'
        ];
        const isDistracting = distractingKeywords.some(k => nameLower.includes(k));
        if (isDistracting) {
          // Cancel any pending stoic notification for a different app
          if (window._stoicPendingApp && window._stoicPendingApp !== app) {
            try { clearTimeout(window._stoicTimerId); } catch (e) {}
            window._stoicPendingApp = null;
            window._stoicTimerId = null;
          }

          // If we've already notified for this app session, skip
          if (window._lastStoicNotifiedApp === app) {
            // nothing
          } else if (window._stoicPendingApp === app) {
            // timer already scheduled for this app, do nothing
          } else {
            // schedule a delayed notification to avoid spam (4s)
            window._stoicPendingApp = app;
            window._stoicTimerId = setTimeout(() => {
              try {
                // double-check we haven't already notified
                if (window._lastStoicNotifiedApp === app) return;

                const stoicQuotes = [
                  'Başkalarının davranışlarını kontrol edemezsin; yalnızca kendi tepkilerini kontrol edebilirsin. — Epiktetos',
                  'Bugün için küçük şeylere değer ver; büyük şeyler onlara bağlıdır. — Marcus Aurelius',
                  'Önemli olan zamanın tüketilmesi değil, nasıl kullanıldığıdır. — Seneca',
                  'Rahatsızlık geçicidir; erdem kalıcıdır. — Epiktetos',
                  'Sabırlı ol; her şey zamanla yerine oturur. — Marcus Aurelius',
                  'İç huzurunu dış koşullara bağlama. — Seneca'
                ];
                const quote = stoicQuotes[Math.floor(Math.random() * stoicQuotes.length)];
                const notifTitle = `Stoik Hatırlatma — ${app}`;

                if (typeof invoke === 'function') {
                  invoke('show_stoic_notification', { title: notifTitle, body: quote }).catch(() => {});
                } else if (typeof Notification !== 'undefined') {
                  try {
                    new Notification(notifTitle, { body: quote });
                  } catch (error) {
                    if (Notification.permission !== 'denied') {
                      Notification.requestPermission().then((perm) => {
                        if (perm === 'granted') new Notification(notifTitle, { body: quote });
                      });
                    }
                  }
                }

                window._lastStoicNotifiedApp = app;
              } catch (e) {
                // swallow
              } finally {
                window._stoicPendingApp = null;
                window._stoicTimerId = null;
              }
            }, 4000);
          }
        } else {
          // not distracting: cancel any pending notification
          if (window._stoicTimerId) {
            try { clearTimeout(window._stoicTimerId); } catch (e) {}
            window._stoicPendingApp = null;
            window._stoicTimerId = null;
          }
        }
      }
    } catch (e) { /* swallow errors to avoid breaking UI */ }
  });

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
      const autostartApi = window.__TAURI__?.autostart ?? window.__TAURI__?.plugins?.autostart;
      if (!autostartApi) {
        throw new Error("Autostart plugin API unavailable");
      }

      const { isEnabled, enable, disable } = autostartApi;

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

async function showUpdateModal(newVersion) {
  const modal = document.getElementById("update-modal");
  const versionSpan = document.getElementById("update-version");
  const installButton = document.getElementById("update-btn-install");
  const skipButton = document.getElementById("update-btn-skip");
  const errorDiv = document.getElementById("update-modal-error");

  if (!modal || !versionSpan || !installButton || !skipButton) return;

  versionSpan.textContent = `v${newVersion}`;
  if (errorDiv) {
    errorDiv.style.display = "none";
    errorDiv.innerHTML = "";
  }
  modal.style.display = "flex";

  installButton.onclick = async () => {
    installButton.textContent = translate("update.installing") || "Installing...";
    installButton.disabled = true;
    if (errorDiv) {
      errorDiv.style.display = "none";
      errorDiv.innerHTML = "";
    }
    try {
      await invoke("install_update");
      // If we get here without error, installation succeeded and app will restart
    } catch (e) {
      const errorMessage = String(e);
      console.error("Update installation failed:", errorMessage);
      installButton.textContent = "Failed";
      installButton.disabled = false;
      // Show detailed error in console for debugging
      setUpdateStatus(`Update failed: ${errorMessage}`, true);

      if (errorDiv) {
        const linkText = translate("update.downloadManually") || "Download Manually";
        errorDiv.innerHTML = `${translate("update.failed") || "Update failed."}<br><span style="display:block; margin-top:6px; word-break: break-word; overflow-wrap: anywhere; color: var(--text-muted);">${errorMessage}</span><a href="https://github.com/osklc/kairos/releases/latest" target="_blank" style="display:inline-block; margin-top:8px; color: var(--accent-color); text-decoration: underline; font-weight: 600;">${linkText}</a>`;
        errorDiv.style.display = "block";
      }
      // Open latest release in the user's browser so they can download the release directly
      try {
        window.open("https://github.com/osklc/kairos/releases/latest", "_blank");
      } catch (openErr) {
        console.warn("Could not open latest release URL automatically:", openErr);
      }
      
    }
  };

  skipButton.onclick = () => {
    modal.style.display = "none";
  };
}

async function checkForUpdates() {
  if (updateCheckInProgress) return;
  updateCheckInProgress = true;
  setUpdateStatus(translate("update.checking") || "Checking for updates...");

  try {
    if (shouldForceUpdateFailure()) {
      throw new Error("Debug: forced updater failure for testing");
    }
    const newVersion = await invoke("check_update");
    if (newVersion) {
      setUpdateStatus("");
      await showUpdateModal(newVersion);
    } else {
      setUpdateStatus(translate("update.upToDate") || "You are up to date.");
    }
  } catch (err) {
    const message = String(err);
    if (message.includes("valid release JSON")) {
      setUpdateStatus(translate("update.invalidManifest") || "Update metadata is invalid on the server.", true);
      console.warn("Updater manifest is invalid:", err);
    } else {
      console.error("Failed to check for updates:", err);
      setUpdateStatus(translate("update.checkFailed") || "Failed to check for updates.", true);
    }
  } finally {
    updateCheckInProgress = false;
  }
}

// Run updater check
setTimeout(checkForUpdates, 2000);

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

  function formatLocalDate(date) {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  const today = new Date();
  const lastWeek = new Date();
  lastWeek.setDate(today.getDate() - 7);
  const defaultStart = formatLocalDate(lastWeek);
  const defaultEnd = formatLocalDate(today);

  // 1. Screen Time Controls
  const screenTimeContainer = document.getElementById("screen-time-date-picker-container");
  const screenTimeStart = document.getElementById("screen-time-start-date");
  const screenTimeEnd = document.getElementById("screen-time-end-date");
  const screenTimeApply = document.getElementById("screen-time-apply-btn");

  if (screenTimeStart && screenTimeEnd) {
    screenTimeStart.value = defaultStart;
    screenTimeEnd.value = defaultEnd;
  }

  document.querySelectorAll(".screen-time-period-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".screen-time-period-btn").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      const target = e.target;
      target.classList.add("active");
      target.setAttribute("aria-pressed", "true");

      screenTimePeriod = target.getAttribute("data-period") || "daily";

      if (screenTimePeriod === "custom") {
        if (screenTimeContainer) screenTimeContainer.style.display = "flex";
      } else {
        if (screenTimeContainer) screenTimeContainer.style.display = "none";
      }
      fetchAndRenderDailyStats();
    });
  });

  screenTimeApply?.addEventListener("click", () => {
    const startVal = screenTimeStart?.value;
    const endVal = screenTimeEnd?.value;
    if (!startVal || !endVal) {
      alert(translate("daily.alertSelectDates"));
      return;
    }
    if (new Date(startVal) > new Date(endVal)) {
      alert(translate("daily.alertInvalidRange"));
      return;
    }
    fetchAndRenderDailyStats();
  });

  // 2. Energy Controls
  const energyContainer = document.getElementById("energy-date-picker-container");
  const energyStart = document.getElementById("energy-start-date");
  const energyEnd = document.getElementById("energy-end-date");
  const energyApply = document.getElementById("energy-apply-btn");

  if (energyStart && energyEnd) {
    energyStart.value = defaultStart;
    energyEnd.value = defaultEnd;
  }

  document.querySelectorAll(".energy-period-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".energy-period-btn").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      const target = e.target;
      target.classList.add("active");
      target.setAttribute("aria-pressed", "true");

      energyPeriod = target.getAttribute("data-period") || "daily";

      if (energyPeriod === "custom") {
        if (energyContainer) energyContainer.style.display = "flex";
      } else {
        if (energyContainer) energyContainer.style.display = "none";
      }
      renderDailyEnergyTotalChart();
    });
  });

  energyApply?.addEventListener("click", () => {
    const startVal = energyStart?.value;
    const endVal = energyEnd?.value;
    if (!startVal || !endVal) {
      alert(translate("daily.alertSelectDates"));
      return;
    }
    if (new Date(startVal) > new Date(endVal)) {
      alert(translate("daily.alertInvalidRange"));
      return;
    }
    renderDailyEnergyTotalChart();
  });

  // 3. Category Controls
  const categoryContainer = document.getElementById("category-date-picker-container");
  const categoryStart = document.getElementById("category-start-date");
  const categoryEnd = document.getElementById("category-end-date");
  const categoryApply = document.getElementById("category-apply-btn");

  if (categoryStart && categoryEnd) {
    categoryStart.value = defaultStart;
    categoryEnd.value = defaultEnd;
  }

  document.querySelectorAll(".category-period-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".category-period-btn").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      const target = e.target;
      target.classList.add("active");
      target.setAttribute("aria-pressed", "true");

      categoryPeriod = target.getAttribute("data-period") || "daily";

      if (categoryPeriod === "custom") {
        if (categoryContainer) categoryContainer.style.display = "flex";
      } else {
        if (categoryContainer) categoryContainer.style.display = "none";
      }
      renderDailyPieChart();
    });
  });

  categoryApply?.addEventListener("click", () => {
    const startVal = categoryStart?.value;
    const endVal = categoryEnd?.value;
    if (!startVal || !endVal) {
      alert(translate("daily.alertSelectDates"));
      return;
    }
    if (new Date(startVal) > new Date(endVal)) {
      alert(translate("daily.alertInvalidRange"));
      return;
    }
    renderDailyPieChart();
  });

  // 4. Eco Controls
  const ecoContainer = document.getElementById("eco-date-picker-container");
  const ecoStart = document.getElementById("eco-start-date");
  const ecoEnd = document.getElementById("eco-end-date");
  const ecoApply = document.getElementById("eco-apply-btn");
  const ecoCopyBtn = document.getElementById("eco-copy-btn");
  const gotoEcoBtn = document.getElementById("btn-goto-eco");

  if (ecoStart && ecoEnd) {
    ecoStart.value = defaultStart;
    ecoEnd.value = defaultEnd;
  }

  document.querySelectorAll(".eco-period-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      document.querySelectorAll(".eco-period-btn").forEach(b => {
        b.classList.remove("active");
        b.setAttribute("aria-pressed", "false");
      });
      const target = e.target;
      target.classList.add("active");
      target.setAttribute("aria-pressed", "true");

      ecoPeriod = target.getAttribute("data-period") || "daily";

      if (ecoPeriod === "custom") {
        if (ecoContainer) ecoContainer.style.display = "flex";
      } else {
        if (ecoContainer) ecoContainer.style.display = "none";
      }
      renderEcoReceipt();
    });
  });

  ecoApply?.addEventListener("click", () => {
    const startVal = ecoStart?.value;
    const endVal = ecoEnd?.value;
    if (!startVal || !endVal) {
      alert(translate("daily.alertSelectDates"));
      return;
    }
    if (new Date(startVal) > new Date(endVal)) {
      alert(translate("daily.alertInvalidRange"));
      return;
    }
    renderEcoReceipt();
  });

  ecoCopyBtn?.addEventListener("click", () => {
    copyReceiptToClipboard();
  });

  gotoEcoBtn?.addEventListener("click", () => {
    const ecoNavBtn = document.querySelector('.nav-link[data-page="eco"]');
    if (ecoNavBtn) {
      ecoNavBtn.click();
    }
  });

  // Initial render of eco receipt
  renderEcoReceipt();
