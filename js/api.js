// @ts-check
import { CONFIG } from "./config.js";

/**
 * Normalized API error. `message` is always a human-readable string,
 * taken from the backend's `{"detail": "..."}` body when present.
 */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status code, or 0 for a network failure.
   * @param {string} message
   */
  constructor(status, message) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.message = message;
  }
}

/**
 * Perform an API request against `CONFIG.apiBase + path`.
 * Always sends `X-Requested-With: fetch` and `credentials: "same-origin"`
 * as required by the backend's CSRF defence and session cookie.
 * On HTTP 401 it dispatches a global `"auth:required"` event (so the app
 * can show the login screen) and still throws an ApiError(401, ...).
 *
 * @param {"GET"|"POST"|"PATCH"|"PUT"|"DELETE"} method
 * @param {string} path Path relative to the API base, starting with "/".
 * @param {unknown} [body] JSON-serializable request body.
 * @returns {Promise<any>} Parsed JSON body, or `null` for a 204 response.
 */
export async function request(method, path, body) {
  /** @type {Record<string, string>} */
  const headers = { "X-Requested-With": "fetch" };
  /** @type {RequestInit} */
  const init = { method, credentials: "same-origin", headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(CONFIG.apiBase + path, init);
  } catch (networkError) {
    throw new ApiError(0, "Не удалось связаться с сервером. Проверьте соединение.");
  }

  if (res.status === 204) return null;

  const text = await res.text();
  /** @type {any} */
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (parseError) {
      data = null;
    }
  }

  if (res.ok) return data;

  const detail = data && typeof data.detail === "string" && data.detail ? data.detail : "";

  if (res.status === 401) {
    if (path === "/auth/login") {
      throw new ApiError(401, "Неверный email или пароль. После 5 неудачных попыток вход блокируется на 15 минут.");
    }
    window.dispatchEvent(new CustomEvent("auth:required"));
    throw new ApiError(401, "Требуется авторизация");
  }

  if (res.status === 429) {
    throw new ApiError(429, "Слишком много неудачных попыток. Попробуйте через 15 минут.");
  }

  if (res.status === 403) {
    throw new ApiError(403, "Недостаточно прав");
  }

  if (res.status === 404) {
    throw new ApiError(404, "Не найдено");
  }

  if (res.status === 409) {
    const knownDetails = {
      "Email already registered": "Этот email уже зарегистрирован",
      "Media is in use": "Файл используется в точке или маршруте",
    };
    const message = knownDetails[detail] || `Конфликт: ${detail || "конфликт данных"}`;
    throw new ApiError(409, message);
  }

  if (res.status === 422) {
    throw new ApiError(422, `Проверьте данные: ${detail || "некорректные данные"}`);
  }

  if (res.status === 503) {
    throw new ApiError(503, detail || "Сервис временно недоступен");
  }

  if (res.status >= 500) {
    throw new ApiError(res.status, "Ошибка сервера. Попробуйте позже.");
  }

  const message = detail || res.statusText || `Ошибка запроса (${res.status})`;
  throw new ApiError(res.status, message);
}
