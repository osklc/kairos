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
    statBreakEl.textContent = summary.break_count.toString();
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
  const resolvedTheme = theme === "black" ? "black" : "white";
  document.body.setAttribute("data-theme", resolvedTheme);
  localStorage.setItem(THEME_STORAGE_KEY, resolvedTheme);

  themeButtons.forEach((button) => {
    const buttonTheme = button.getAttribute("data-theme-option");
    const isActive = buttonTheme === resolvedTheme;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

async function greet() {
  greetMsgEl.textContent = await invoke("greet", { name: greetInputEl.value });
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
    focus: "pages.focus",
    goals: "pages.goals",
    notes: "pages.notes",
    settings: "pages.settings",
  };

  const preferredTheme = localStorage.getItem(THEME_STORAGE_KEY) || "white";
  setTheme(preferredTheme, themeButtons);

  await ensureCurrentDate(currentDateEl);

  fetchAndRenderSummary();
  fetchAndRenderAppUsage();
  setInterval(() => {
    fetchAndRenderSummary();
    fetchAndRenderAppUsage();
  }, 60000);

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
});
