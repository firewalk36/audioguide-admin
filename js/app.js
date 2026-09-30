// @ts-check
import { checkSession, initLoginForm, logout, onAuthChange } from "./auth.js";
import { CONFIG } from "./config.js";
import { AgMap } from "./map.js";
import { toast } from "./dom.js";
import * as points from "./points.js";
import * as routes from "./routes.js";
import * as users from "./users.js";

const THEME_KEY = "ag_theme";
const SCREEN_TITLES = { map: "Карта точек", points: "Точки", routes: "Маршруты", users: "Пользователи" };

/** @type {AgMap|null} */
let map = null;
let currentScreen = "map";
let mapReady = false;

// ─── theme ───

function applyStoredTheme() {
  // Light is the primary (brand) theme; dark stays available via the toggle.
  let theme = "light";
  try {
    theme = localStorage.getItem(THEME_KEY) || "light";
  } catch (err) {
    /* localStorage unavailable (private mode) — fall back to default */
  }
  document.documentElement.dataset.theme = theme;
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch (err) {
    /* ignore persistence failure */
  }
}

// ─── screens ───

function showScreen(name) {
  for (const view of document.querySelectorAll(".view")) {
    view.classList.toggle("active", view.id === `view-${name}`);
  }
  for (const item of document.querySelectorAll(".nav-item[data-screen]")) {
    item.classList.toggle("active", item.getAttribute("data-screen") === name);
  }
  const titleEl = document.getElementById("topbar-title");
  if (titleEl) titleEl.textContent = SCREEN_TITLES[name] || "";
  const newRouteBtn = document.getElementById("new-route-btn");
  if (newRouteBtn) newRouteBtn.style.display = name === "routes" ? "inline-flex" : "none";
}

/**
 * Switch screens, but first give any dirty editor/modal a chance to block
 * navigation with a confirm dialog.
 * @param {string} name
 * @returns {Promise<boolean>} whether the switch happened
 */
async function guardedSwitch(name) {
  if (name === currentScreen) return true;
  if (currentScreen === "map") {
    const closed = await points.closeEditor(false);
    if (!closed) return false;
  }
  const overlay = document.getElementById("route-modal");
  if (overlay && overlay.classList.contains("open")) {
    const closed = await routes.closeRouteModal(false);
    if (!closed) return false;
  }
  currentScreen = name;
  showScreen(name);
  await loadScreenData(name);
  return true;
}

/** @param {string} name */
async function loadScreenData(name) {
  if (name === "map") {
    await ensureMap();
    await points.refreshMapPoints();
  } else if (name === "points") {
    await points.loadList(openPointFromList);
  } else if (name === "routes") {
    await routes.loadRoutesList();
  } else if (name === "users") {
    await users.loadUsersList();
  }
}

/** @param {string} id */
async function openPointFromList(id) {
  const ok = await guardedSwitch("map");
  if (!ok) return;
  await points.openPointById(id);
}

async function ensureMap() {
  if (mapReady) return;
  map = new AgMap("ymap");
  try {
    await map.load();
    mapReady = true;
    points.attachMap(map);
    routes.initRouteModal(map);
    const searchInput = /** @type {HTMLInputElement|null} */ (document.getElementById("map-search-input"));
    if (searchInput && CONFIG.geocoder) map.attachSearchBox(searchInput);
    else searchInput?.closest(".map-search")?.setAttribute("hidden", "");
  } catch (err) {
    toast("Не удалось загрузить Яндекс Карты. Обновите страницу.", "error");
  }
}

function wireNav() {
  for (const item of document.querySelectorAll(".nav-item[data-screen]")) {
    item.addEventListener("click", () => {
      const screen = item.getAttribute("data-screen");
      if (screen) guardedSwitch(screen);
    });
  }
  const logoutBtn = document.getElementById("logout-btn");
  logoutBtn &&
    logoutBtn.addEventListener("click", async () => {
      if (currentScreen === "map" && !(await points.closeEditor(false))) return;
      const overlay = document.getElementById("route-modal");
      if (overlay && overlay.classList.contains("open") && !(await routes.closeRouteModal(false))) return;
      await logout();
    });
  const themeBtn = document.querySelector("[data-theme-toggle]");
  themeBtn && themeBtn.addEventListener("click", toggleTheme);
  const newRouteBtn = document.getElementById("new-route-btn");
  newRouteBtn && newRouteBtn.addEventListener("click", () => routes.openRouteModal(null));
  // Empty states offer the next step instead of a dead end.
  const routesEmptyNew = document.getElementById("routes-empty-new");
  routesEmptyNew && routesEmptyNew.addEventListener("click", () => routes.openRouteModal(null));
  const pointsEmptyMap = document.getElementById("points-empty-map");
  pointsEmptyMap && pointsEmptyMap.addEventListener("click", () => guardedSwitch("map"));
}

// ─── auth-driven visibility ───

function showLogin() {
  const login = document.getElementById("login-screen");
  const root = document.getElementById("app-root");
  if (login) login.style.display = "flex";
  if (root) root.style.display = "none";
}

/** @param {any} user */
function enterApp(user) {
  const login = document.getElementById("login-screen");
  const root = document.getElementById("app-root");
  if (login) login.style.display = "none";
  if (root) root.style.display = "flex";
  const nameEl = document.getElementById("current-user-name");
  const roleEl = document.getElementById("current-user-role");
  if (nameEl) nameEl.textContent = user.name;
  if (roleEl) roleEl.textContent = user.role === "admin" ? "Администратор" : "Редактор";
  const usersNav = document.getElementById("nav-users");
  if (usersNav) usersNav.style.display = user.role === "admin" ? "flex" : "none";
  routes.setCurrentRole(user.role);
  currentScreen = "map";
  showScreen("map");
  loadScreenData("map");
}

onAuthChange((user) => {
  if (!user) showLogin();
});

async function boot() {
  applyStoredTheme();
  wireNav();
  points.initPanel();
  points.initPointsList(openPointFromList);
  routes.initRoutesList();
  users.initUsersScreen();

  const loginForm = /** @type {HTMLFormElement|null} */ (document.getElementById("login-form"));
  const loginError = document.getElementById("login-error");
  if (loginForm && loginError) {
    initLoginForm(loginForm, loginError, enterApp);
  }

  const user = await checkSession();
  if (user) enterApp(user);
  else showLogin();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
