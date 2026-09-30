// @ts-check

/**
 * Minimal DOM builder. Never assigns raw markup: text content is always set
 * via `textContent`, so nothing built with `el()` can inject markup.
 * @param {string} tag
 * @param {Record<string, any>} [props]
 * @param {(Node|string|null|undefined)[]} [children]
 * @returns {HTMLElement}
 */
export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "textContent") node.textContent = String(value);
    else if (key === "class" || key === "className") node.className = String(value);
    else if (key === "html") throw new Error("el(): raw html is not supported by design");
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "dataset" && typeof value === "object") {
      for (const [dk, dv] of Object.entries(value)) node.dataset[dk] = String(dv);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** Remove all children of `node` via replaceChildren(), no raw-markup APIs. @param {Element} node */
export function clear(node) {
  node.replaceChildren();
}

/**
 * Escape a string for safe interpolation into Yandex Maps balloon/hint
 * HTML content (the only place in this app that consumes an HTML string
 * instead of the DOM API, because ymaps balloons take a markup string).
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Trap Tab/Shift+Tab focus inside `container` and report Escape presses.
 * Returns a cleanup function that removes the listener.
 * @param {HTMLElement} container
 * @param {{ onEscape?: () => void }} [opts]
 * @returns {() => void}
 */
export function trapFocus(container, opts = {}) {
  const selector =
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), ' +
    'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = () =>
    Array.from(container.querySelectorAll(selector)).filter(
      /** @param {Element} n */ (n) => n instanceof HTMLElement && n.offsetParent !== null
    );

  /** @param {KeyboardEvent} e */
  function handleKeydown(e) {
    if (e.key === "Escape") {
      e.stopPropagation();
      opts.onEscape && opts.onEscape();
      return;
    }
    if (e.key !== "Tab") return;
    const items = /** @type {HTMLElement[]} */ (focusables());
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  container.addEventListener("keydown", handleKeydown);
  const items = /** @type {HTMLElement[]} */ (focusables());
  if (items.length) items[0].focus();
  return () => container.removeEventListener("keydown", handleKeydown);
}

let toastContainer = /** @type {HTMLElement|null} */ (null);

/**
 * Show a toast notification. Replaces native browser alert popups for
 * transient feedback.
 * @param {string} message
 * @param {"info"|"success"|"error"} [type]
 */
export function toast(message, type = "info") {
  if (!toastContainer) toastContainer = document.getElementById("toast-container");
  if (!toastContainer) return;
  const node = el("div", { class: `toast ${type}`, role: "status" }, [
    el("span", { textContent: message }),
  ]);
  toastContainer.appendChild(node);
  const duration = type === "error" ? 8000 : 5000;
  const timer = setTimeout(() => node.remove(), duration);
  node.addEventListener("click", () => {
    clearTimeout(timer);
    node.remove();
  });
}

/**
 * Custom confirm dialog (never uses the native browser confirm popup). Reuses the
 * `#confirm-modal` markup declared once in index.html.
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export function confirmDialog(text) {
  return new Promise((resolve) => {
    const overlay = /** @type {HTMLElement|null} */ (document.getElementById("confirm-modal"));
    const textEl = document.getElementById("confirm-text");
    const okBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("confirm-ok"));
    const cancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("confirm-cancel"));
    if (!overlay || !textEl || !okBtn || !cancelBtn) {
      resolve(false);
      return;
    }
    textEl.textContent = text;
    overlay.classList.add("open");
    const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);
    let untrap = () => {};

    function finish(/** @type {boolean} */ result) {
      overlay.classList.remove("open");
      untrap();
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBgClick);
      if (previouslyFocused) previouslyFocused.focus();
      resolve(result);
    }
    function onOk() {
      finish(true);
    }
    function onCancel() {
      finish(false);
    }
    /** @param {MouseEvent} e */
    function onBgClick(e) {
      if (e.target === overlay) finish(false);
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBgClick);
    untrap = trapFocus(/** @type {HTMLElement} */ (overlay.querySelector(".modal")) || overlay, {
      onEscape: onCancel,
    });
  });
}

/**
 * Custom single-field prompt dialog (never uses `window.prompt`). Reuses
 * the `#prompt-modal` markup declared once in index.html. Used for the
 * "reset password" flow, which needs a short text value from the admin.
 * @param {string} text Prompt label.
 * @param {{ minLength?: number, type?: string }} [opts]
 * @returns {Promise<string|null>} the entered value, or null if cancelled.
 */
export function promptDialog(text, opts = {}) {
  return new Promise((resolve) => {
    const overlay = /** @type {HTMLElement|null} */ (document.getElementById("prompt-modal"));
    const labelEl = document.getElementById("prompt-text");
    const input = /** @type {HTMLInputElement|null} */ (document.getElementById("prompt-input"));
    const errorEl = document.getElementById("prompt-error");
    const okBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("prompt-ok"));
    const cancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById("prompt-cancel"));
    if (!overlay || !labelEl || !input || !okBtn || !cancelBtn) {
      resolve(null);
      return;
    }
    labelEl.textContent = text;
    input.value = "";
    input.type = opts.type || "password";
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.remove("visible");
    }
    overlay.classList.add("open");
    const previouslyFocused = /** @type {HTMLElement|null} */ (document.activeElement);
    let untrap = () => {};

    function finish(/** @type {string|null} */ result) {
      overlay.classList.remove("open");
      untrap();
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      overlay.removeEventListener("click", onBgClick);
      if (previouslyFocused) previouslyFocused.focus();
      resolve(result);
    }
    function onOk() {
      const value = /** @type {HTMLInputElement} */ (input).value;
      if (opts.minLength && value.length < opts.minLength) {
        if (errorEl) {
          errorEl.textContent = `Минимум ${opts.minLength} символов`;
          errorEl.classList.add("visible");
        }
        return;
      }
      finish(value);
    }
    function onCancel() {
      finish(null);
    }
    /** @param {MouseEvent} e */
    function onBgClick(e) {
      if (e.target === overlay) finish(null);
    }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    overlay.addEventListener("click", onBgClick);
    untrap = trapFocus(/** @type {HTMLElement} */ (overlay.querySelector(".modal")) || overlay, {
      onEscape: onCancel,
    });
  });
}
