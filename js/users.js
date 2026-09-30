// @ts-check
import { request, ApiError } from "./api.js";
import { el, clear, toast, confirmDialog, promptDialog, trapFocus } from "./dom.js";

const ROLE_LABELS = { admin: "Администратор", editor: "Редактор" };
let untrap = () => {};

function ids() {
  return {
    list: document.getElementById("users-list"),
    newBtn: document.getElementById("users-new-btn"),
    modal: /** @type {HTMLElement} */ (document.getElementById("user-modal")),
    modalInner: /** @type {HTMLElement} */ (document.getElementById("user-modal").querySelector(".modal")),
    form: /** @type {HTMLFormElement} */ (document.getElementById("user-form")),
    modalTitle: document.getElementById("user-modal-title"),
    fName: /** @type {HTMLInputElement} */ (document.getElementById("u-name")),
    fEmail: /** @type {HTMLInputElement} */ (document.getElementById("u-email")),
    fRole: /** @type {HTMLSelectElement} */ (document.getElementById("u-role")),
    fPassword: /** @type {HTMLInputElement} */ (document.getElementById("u-password")),
    passwordGroup: document.getElementById("u-password-group"),
    saveBtn: /** @type {HTMLButtonElement} */ (document.getElementById("u-save-btn")),
    cancelBtn: document.getElementById("u-cancel-btn"),
    closeBtn: document.getElementById("user-modal-close"),
  };
}

export async function loadUsersList() {
  const d = ids();
  if (!d.list) return;
  try {
    const users = await request("GET", "/manage/users");
    clear(/** @type {Element} */ (d.list));
    for (const user of users) {
      d.list.appendChild(buildRow(user));
    }
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось загрузить пользователей", "error");
  }
}

/** @param {any} user */
function buildRow(user) {
  const roleTag = el("span", { class: `role-tag ${user.role}`, textContent: ROLE_LABELS[user.role] || user.role });
  const statusTag = user.is_active
    ? null
    : el("span", { class: "role-tag status-tag inactive", textContent: "Деактивирован" });

  const toggleActiveBtn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    textContent: user.is_active ? "Деактивировать" : "Активировать",
    onclick: () => toggleActive(user),
  });
  const resetBtn = el("button", {
    class: "btn btn-ghost",
    type: "button",
    textContent: "Сбросить пароль",
    onclick: () => resetPassword(user),
  });
  const roleSelect = el("select", { class: "select", "aria-label": `Роль пользователя ${user.name}`, style: "width:150px" });
  for (const [value, label] of Object.entries(ROLE_LABELS)) {
    const opt = el("option", { value, textContent: label });
    if (value === user.role) opt.setAttribute("selected", "");
    roleSelect.appendChild(opt);
  }
  roleSelect.addEventListener("change", () => changeRole(user, /** @type {HTMLSelectElement} */ (roleSelect).value, roleSelect));

  return el("div", { class: "list-row" }, [
    el("div", { class: "list-row-main" }, [
      el("div", { class: "list-row-title", textContent: user.name }),
      el("div", { class: "list-row-sub", textContent: user.email }),
    ]),
    el("div", { class: "list-row-meta" }, [roleTag, statusTag, roleSelect, resetBtn, toggleActiveBtn]),
  ]);
}

/** @param {any} user @param {string} newRole @param {HTMLSelectElement} selectEl */
async function changeRole(user, newRole, selectEl) {
  if (newRole === user.role) return;
  selectEl.disabled = true;
  try {
    await request("PATCH", `/manage/users/${user.id}`, { role: newRole });
    toast("Роль обновлена", "success");
    await loadUsersList();
  } catch (err) {
    selectEl.value = user.role;
    toast(err instanceof ApiError ? err.message : "Не удалось изменить роль", "error");
  } finally {
    selectEl.disabled = false;
  }
}

/** @param {any} user */
async function toggleActive(user) {
  const verb = user.is_active ? "деактивировать" : "активировать";
  const ok = await confirmDialog(`Точно ${verb} пользователя «${user.name}»?`);
  if (!ok) return;
  try {
    await request("PATCH", `/manage/users/${user.id}`, { is_active: !user.is_active });
    toast("Статус обновлён", "success");
    await loadUsersList();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось изменить статус", "error");
  }
}

/** @param {any} user */
async function resetPassword(user) {
  const password = await promptDialog(`Новый пароль для ${user.email}`, { minLength: 10, type: "password" });
  if (password === null) return;
  try {
    await request("PATCH", `/manage/users/${user.id}`, { password });
    toast("Пароль сброшен", "success");
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось сбросить пароль", "error");
  }
}

// ─── create-user modal ───

function openCreateModal() {
  const d = ids();
  d.form.reset();
  d.modalTitle && (d.modalTitle.textContent = "Новый пользователь");
  d.modal.classList.add("open");
  untrap = trapFocus(d.modalInner, { onEscape: closeCreateModal });
}

function closeCreateModal() {
  const d = ids();
  d.modal.classList.remove("open");
  untrap();
}

/** @param {SubmitEvent} e */
async function handleCreate(e) {
  e.preventDefault();
  const d = ids();
  const password = d.fPassword.value;
  if (password.length < 10) {
    toast("Пароль должен быть не короче 10 символов", "error");
    return;
  }
  d.saveBtn.disabled = true;
  try {
    await request("POST", "/manage/users", {
      name: d.fName.value.trim(),
      email: d.fEmail.value.trim(),
      role: d.fRole.value,
      password,
    });
    toast("Пользователь создан", "success");
    closeCreateModal();
    await loadUsersList();
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось создать пользователя", "error");
  } finally {
    d.saveBtn.disabled = false;
  }
}

export function initUsersScreen() {
  const d = ids();
  d.newBtn && d.newBtn.addEventListener("click", openCreateModal);
  d.form.addEventListener("submit", handleCreate);
  d.cancelBtn && d.cancelBtn.addEventListener("click", closeCreateModal);
  d.closeBtn && d.closeBtn.addEventListener("click", closeCreateModal);
  d.modal.addEventListener("click", (e) => {
    if (e.target === d.modal) closeCreateModal();
  });
}
