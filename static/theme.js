/** تطبيق الوضع الداكن/الفاتح — يُحمَّل في <head> قبل CSS لتجنّب وميض الألوان */
(function applyStoredThemeEarly() {
  const t = localStorage.getItem("parking_theme");
  document.documentElement.setAttribute("data-theme", t === "light" ? "light" : "dark");
})();

const THEME_STORAGE_KEY = "parking_theme";

function getAppTheme() {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

function applyAppTheme(theme) {
  const next = theme === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem(THEME_STORAGE_KEY, next);
  document.querySelectorAll("[data-theme-icon]").forEach((el) => {
    el.textContent = next === "light" ? "🌙" : "☀";
  });
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    const label = next === "light" ? "الوضع الداكن" : "الوضع الفاتح";
    btn.setAttribute("aria-label", label);
    btn.setAttribute("title", label);
  });
}

function toggleAppTheme() {
  applyAppTheme(getAppTheme() === "light" ? "dark" : "light");
}

function initAppThemeToggle() {
  applyAppTheme(getAppTheme());
  document.querySelectorAll("[data-theme-toggle]").forEach((btn) => {
    if (btn.dataset.themeBound) return;
    btn.dataset.themeBound = "1";
    btn.addEventListener("click", toggleAppTheme);
  });
}
