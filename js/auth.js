// @ts-check
import { request, ApiError } from "./api.js";

/**
 * @typedef {{ id: string, email: string, name: string, role: "admin"|"editor",
 *   is_active: boolean, last_login_at: string|null, created_at: string }} UserOut
 */

/** @type {UserOut|null} */
let currentUser = null;
/** @type {Set<(user: UserOut|null) => void>} */
const listeners = new Set();

/** @returns {UserOut|null} */
export function getCurrentUser() {
  return currentUser;
}

/**
 * Subscribe to auth state changes (login/logout/session loss).
 * @param {(user: UserOut|null) => void} fn
 * @returns {() => void} unsubscribe
 */
export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** @param {UserOut|null} user */
function setUser(user) {
  currentUser = user;
  for (const fn of listeners) fn(user);
}

// A 401 from any API call means the session is gone; react everywhere.
window.addEventListener("auth:required", () => setUser(null));

/**
 * Ask the backend whether we already have a valid session cookie.
 * @returns {Promise<UserOut|null>}
 */
export async function checkSession() {
  try {
    const user = await request("GET", "/auth/me");
    setUser(user);
    return user;
  } catch (err) {
    setUser(null);
    return null;
  }
}

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<UserOut>}
 */
export async function login(email, password) {
  const user = await request("POST", "/auth/login", { email, password });
  setUser(user);
  return user;
}

export async function logout() {
  try {
    await request("POST", "/auth/logout");
  } catch (err) {
    // Even if the request fails (e.g. session already gone), forget the user.
  }
  setUser(null);
}

/**
 * Wire the static login form markup in index.html to the auth API.
 * @param {HTMLFormElement} form
 * @param {HTMLElement} errorEl
 * @param {(user: UserOut) => void} onSuccess
 */
export function initLoginForm(form, errorEl, onSuccess) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const emailInput = /** @type {HTMLInputElement} */ (form.querySelector("#login-email"));
    const passwordInput = /** @type {HTMLInputElement} */ (form.querySelector("#login-password"));
    const submitBtn = /** @type {HTMLButtonElement} */ (form.querySelector('button[type="submit"]'));
    errorEl.textContent = "";
    errorEl.classList.remove("visible");
    submitBtn.disabled = true;
    try {
      const user = await login(emailInput.value.trim(), passwordInput.value);
      passwordInput.value = "";
      onSuccess(user);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "Не удалось выполнить вход";
      errorEl.textContent = message;
      errorEl.classList.add("visible");
    } finally {
      submitBtn.disabled = false;
    }
  });
}
