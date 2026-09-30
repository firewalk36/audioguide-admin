// @ts-check
import { request, ApiError } from "./api.js";
import { el, clear, toast, confirmDialog, trapFocus } from "./dom.js";
import { uploadMedia } from "./media.js";

/** @typedef {import("./map.js").AgMap} AgMap */

const TRANSPORT_LABELS = { walk: "Пешком", bike: "Велосипед", car: "Авто", transit: "Общ. транспорт" };
const STATUS_LABELS = { draft: "Черновик", published: "Опубликован", archived: "В архиве" };

/** @type {AgMap|null} */
let previewMap = null;
/** @type {any} current route being edited, or null for a new route */
let current = null;
/** @type {string[]} ids of points in the route, in editor order (local, not yet PUT) */
let localPointIds = [];
/** @type {any[]} full point objects fetched for the picker/labels, keyed by id */
let pointsCache = new Map();
let untrapModal = () => {};
let busy = false;
let pendingCover = /** @type {any} */ (null);
let pendingIntroAudio = /** @type {any} */ (null);
let originalSnapshot = /** @type {string|null} */ (null);

const listState = { q: "", status: "", offset: 0, limit: 50, total: 0 };
let searchDebounce = /** @type {number|undefined} */ (undefined);
/** @type {string} role of the signed-in user; delete button only shown for admin */
let currentRole = "editor";

function modalIds() {
  return {
    overlay: /** @type {HTMLElement} */ (document.getElementById("route-modal")),
    modal: /** @type {HTMLElement} */ (document.getElementById("route-modal").querySelector(".modal")),
    title: document.getElementById("route-modal-title"),
    closeBtn: document.getElementById("route-modal-close"),
    form: /** @type {HTMLFormElement} */ (document.getElementById("route-form")),
    fTitle: /** @type {HTMLInputElement} */ (document.getElementById("r-title")),
    fDesc: /** @type {HTMLTextAreaElement} */ (document.getElementById("r-description")),
    fTransport: /** @type {HTMLSelectElement} */ (document.getElementById("r-transport")),
    fStatus: /** @type {HTMLSelectElement} */ (document.getElementById("r-status")),
    fDuration: /** @type {HTMLInputElement} */ (document.getElementById("r-duration")),
    fDistance: /** @type {HTMLInputElement} */ (document.getElementById("r-distance")),
    coverZone: document.getElementById("cover-zone"),
    coverInput: /** @type {HTMLInputElement} */ (document.getElementById("cover-input")),
    coverPreview: document.getElementById("cover-preview"),
    introZone: document.getElementById("intro-zone"),
    introInput: /** @type {HTMLInputElement} */ (document.getElementById("intro-input")),
    introPreview: document.getElementById("intro-preview"),
    rpSection: document.getElementById("rp-section"),
    rpNotice: document.getElementById("rp-new-route-notice"),
    rpSearch: /** @type {HTMLInputElement} */ (document.getElementById("rp-search")),
    rpResults: document.getElementById("rp-search-results"),
    rpList: document.getElementById("rp-list"),
    rpEmpty: document.getElementById("rp-empty"),
    rpMap: document.getElementById("rp-map-preview"),
    deleteBtn: /** @type {HTMLButtonElement} */ (document.getElementById("r-delete-btn")),
    saveBtn: /** @type {HTMLButtonElement} */ (document.getElementById("r-save-btn")),
    cancelBtn: document.getElementById("r-cancel-btn"),
  };
}

function isDirty() {
  const d = modalIds();
  const snap = JSON.stringify({
    title: d.fTitle.value,
    desc: d.fDesc.value,
    transport: d.fTransport.value,
    status: d.fStatus.value,
    duration: d.fDuration.value,
    distance: d.fDistance.value,
    cover: pendingCover ? pendingCover.id : current && current.cover ? current.cover.id : null,
    intro: pendingIntroAudio ? pendingIntroAudio.id : current && current.intro_audio ? current.intro_audio.id : null,
    points: localPointIds.join(","),
  });
  return originalSnapshot !== null && snap !== originalSnapshot;
}

export function routeEditorIsDirty() {
  const overlay = document.getElementById("route-modal");
  return !!overlay && overlay.classList.contains("open") && isDirty();
}

/** @param {string} role */
export function setCurrentRole(role) {
  currentRole = role;
}

// ─── modal open/close ───

/** @param {any} route RouteOut, or null for a new route */
export async function openRouteModal(route) {
  const d = modalIds();
  current = route;
  pendingCover = null;
  pendingIntroAudio = null;
  localPointIds = route ? [...route.point_ids] : [];

  d.title && (d.title.textContent = route ? "Редактирование маршрута" : "Новый маршрут");
  d.fTitle.value = route ? route.title : "";
  d.fDesc.value = route ? route.description || "" : "";
  d.fTransport.value = route ? route.transport : "walk";
  d.fStatus.value = route ? route.status : "draft";
  d.fDuration.value = route && route.duration_minutes ? String(route.duration_minutes) : "";
  d.fDistance.value = route && route.distance_meters ? String(route.distance_meters) : "";
  renderCoverPreview(route ? route.cover : null);
  renderIntroPreview(route ? route.intro_audio : null);
  d.deleteBtn.style.display = route && currentRole === "admin" ? "inline-flex" : "none";

  const hasRoute = !!(route && route.id);
  d.rpSection && (d.rpSection.style.display = hasRoute ? "block" : "none");
  d.rpNotice && (d.rpNotice.style.display = hasRoute ? "none" : "block");

  if (hasRoute) await loadPointsCache();
  renderRpList();

  originalSnapshot = JSON.stringify({
    title: d.fTitle.value,
    desc: d.fDesc.value,
    transport: d.fTransport.value,
    status: d.fStatus.value,
    duration: d.fDuration.value,
    distance: d.fDistance.value,
    cover: route && route.cover ? route.cover.id : null,
    intro: route && route.intro_audio ? route.intro_audio.id : null,
    points: localPointIds.join(","),
  });

  d.overlay.classList.add("open");
  untrapModal = trapFocus(d.modal, { onEscape: () => closeRouteModal(false) });
}

/** @param {boolean} [force] */
export async function closeRouteModal(force) {
  if (!force && isDirty()) {
    const ok = await confirmDialog("Есть несохранённые изменения в маршруте. Закрыть без сохранения?");
    if (!ok) return false;
  }
  const d = modalIds();
  d.overlay.classList.remove("open");
  untrapModal();
  current = null;
  localPointIds = [];
  originalSnapshot = null;
  previewMap && previewMap.clearRoutePolyline();
  return true;
}

async function loadPointsCache() {
  try {
    const page = await request("GET", "/manage/points?limit=500&offset=0");
    pointsCache = new Map(page.items.map((/** @type {any} */ p) => [p.id, p]));
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось загрузить точки", "error");
  }
}

// ─── points composition (local only, PUT happens on Save) ───

function renderRpList() {
  const d = modalIds();
  if (!d.rpList) return;
  clear(d.rpList);
  if (!localPointIds.length) {
    d.rpEmpty && (d.rpEmpty.style.display = "block");
  } else {
    d.rpEmpty && (d.rpEmpty.style.display = "none");
    localPointIds.forEach((id, index) => {
      const point = pointsCache.get(id);
      const item = el(
        "div",
        { class: "rp-item", draggable: "true", dataset: { id } },
        [
          el("span", { class: "rp-item-order", textContent: String(index + 1) }),
          el("span", { class: "rp-item-title", textContent: point ? point.title : id }),
          el("div", { class: "rp-item-actions" }, [
            el("button", {
              type: "button",
              "aria-label": "Переместить выше",
              disabled: index === 0,
              onclick: () => movePoint(index, index - 1),
              textContent: "↑",
            }),
            el("button", {
              type: "button",
              "aria-label": "Переместить ниже",
              disabled: index === localPointIds.length - 1,
              onclick: () => movePoint(index, index + 1),
              textContent: "↓",
            }),
            el("button", {
              type: "button",
              class: "rp-remove",
              "aria-label": "Убрать из маршрута",
              onclick: () => {
                localPointIds.splice(index, 1);
                renderRpList();
              },
              textContent: "✕",
            }),
          ]),
        ]
      );
      item.addEventListener("dragstart", (e) => {
        item.classList.add("dragging");
        e.dataTransfer && e.dataTransfer.setData("text/plain", String(index));
      });
      item.addEventListener("dragend", () => item.classList.remove("dragging"));
      item.addEventListener("dragover", (e) => e.preventDefault());
      item.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer && e.dataTransfer.getData("text/plain"));
        if (Number.isFinite(from)) movePoint(from, index);
      });
      d.rpList.appendChild(item);
    });
  }
  updateRoutePreviewPolyline();
}

/** @param {number} from @param {number} to */
function movePoint(from, to) {
  if (to < 0 || to >= localPointIds.length) return;
  const [id] = localPointIds.splice(from, 1);
  localPointIds.splice(to, 0, id);
  renderRpList();
}

function updateRoutePreviewPolyline() {
  if (!previewMap) return;
  const coords = /** @type {[number, number][]} */ (
    localPointIds.map((id) => pointsCache.get(id)).filter(Boolean).map((p) => [p.lat, p.lon])
  );
  previewMap.showRoutePolyline(coords);
}

function wireSearchPicker() {
  const d = modalIds();
  d.rpSearch.addEventListener("input", () => {
    const q = d.rpSearch.value.trim().toLowerCase();
    clear(/** @type {Element} */ (d.rpResults));
    if (!q) return;
    const matches = Array.from(pointsCache.values())
      .filter((p) => p.title.toLowerCase().includes(q) && !localPointIds.includes(p.id))
      .slice(0, 8);
    for (const point of matches) {
      const item = el("div", {
        class: "list-row",
        role: "button",
        tabindex: "0",
        onclick: () => {
          localPointIds.push(point.id);
          d.rpSearch.value = "";
          clear(/** @type {Element} */ (d.rpResults));
          renderRpList();
        },
      }, [el("div", { class: "list-row-title", textContent: point.title })]);
      d.rpResults && d.rpResults.appendChild(item);
    }
  });
}

// ─── media (cover / intro audio) ───

/** @param {any} media */
function renderCoverPreview(media) {
  const d = modalIds();
  clear(/** @type {Element} */ (d.coverPreview));
  if (media) {
    d.coverPreview && d.coverPreview.classList.add("visible");
    d.coverPreview && d.coverPreview.append(
      el("img", { src: media.url, alt: "Обложка маршрута" }),
      el("div", { class: "upload-preview-info" }, [el("span", { class: "preview-filename", textContent: media.format.toUpperCase() })])
    );
  } else {
    d.coverPreview && d.coverPreview.classList.remove("visible");
  }
}

/** @param {any} media */
function renderIntroPreview(media) {
  const d = modalIds();
  clear(/** @type {Element} */ (d.introPreview));
  if (media) {
    d.introPreview && d.introPreview.classList.add("visible");
    const audio = el("audio", { controls: "true", src: media.url });
    d.introPreview && d.introPreview.append(audio);
  } else {
    d.introPreview && d.introPreview.classList.remove("visible");
  }
}

function wireMediaZones() {
  const d = modalIds();
  d.coverInput.addEventListener("change", async () => {
    const file = d.coverInput.files && d.coverInput.files[0];
    d.coverInput.value = "";
    if (!file) return;
    try {
      pendingCover = await uploadMedia("image", file);
      renderCoverPreview(pendingCover);
      toast("Обложка загружена", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Не удалось загрузить обложку", "error");
    }
  });
  d.introInput.addEventListener("change", async () => {
    const file = d.introInput.files && d.introInput.files[0];
    d.introInput.value = "";
    if (!file) return;
    try {
      pendingIntroAudio = await uploadMedia("audio", file);
      renderIntroPreview(pendingIntroAudio);
      toast("Вступительное аудио загружено", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Не удалось загрузить аудио", "error");
    }
  });
}

// ─── save / delete ───

async function handleSave() {
  if (busy) return;
  const d = modalIds();
  const title = d.fTitle.value.trim();
  if (!title) {
    toast("Укажите название маршрута", "error");
    return;
  }
  const payload = {
    title,
    description: d.fDesc.value.trim() || null,
    transport: d.fTransport.value,
    status: d.fStatus.value,
    duration_minutes: d.fDuration.value ? Number(d.fDuration.value) : null,
    distance_meters: d.fDistance.value ? Number(d.fDistance.value) : null,
    cover_media_id: pendingCover ? pendingCover.id : current ? current.cover_media_id : null,
    intro_audio_media_id: pendingIntroAudio ? pendingIntroAudio.id : current ? current.intro_audio_media_id : null,
  };

  busy = true;
  d.saveBtn.disabled = true;
  try {
    let saved;
    if (current && current.id) {
      saved = await request("PATCH", `/manage/routes/${current.id}`, payload);
    } else {
      saved = await request("POST", "/manage/routes", payload);
    }
    if (saved.id) {
      saved = await request("PUT", `/manage/routes/${saved.id}/points`, { point_ids: localPointIds });
    }
    toast("Маршрут сохранён", "success");
    window.dispatchEvent(new CustomEvent("routes:changed"));
    await openRouteModal(saved);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось сохранить маршрут", "error");
  } finally {
    busy = false;
    d.saveBtn.disabled = false;
  }
}

async function handleDelete() {
  if (!current || !current.id) return;
  const ok = await confirmDialog(`Удалить маршрут «${current.title}»? Это действие необратимо.`);
  if (!ok) return;
  const d = modalIds();
  d.deleteBtn.disabled = true;
  try {
    await request("DELETE", `/manage/routes/${current.id}`);
    toast("Маршрут удалён", "success");
    window.dispatchEvent(new CustomEvent("routes:changed"));
    await closeRouteModal(true);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось удалить маршрут", "error");
  } finally {
    d.deleteBtn.disabled = false;
  }
}

/** @param {AgMap} [agMap] optional preview map instance for the modal */
export function initRouteModal(agMap) {
  previewMap = agMap || null;
  const d = modalIds();
  d.form.addEventListener("submit", (e) => e.preventDefault());
  d.saveBtn.addEventListener("click", handleSave);
  d.deleteBtn.addEventListener("click", handleDelete);
  d.cancelBtn && d.cancelBtn.addEventListener("click", () => closeRouteModal(false));
  d.closeBtn && d.closeBtn.addEventListener("click", () => closeRouteModal(false));
  d.overlay.addEventListener("click", (e) => {
    if (e.target === d.overlay) closeRouteModal(false);
  });
  wireMediaZones();
  wireSearchPicker();
}

// ─── routes list screen ───

function listIds() {
  return {
    search: /** @type {HTMLInputElement} */ (document.getElementById("route-search")),
    status: /** @type {HTMLSelectElement} */ (document.getElementById("route-status-filter")),
    grid: document.getElementById("routes-grid"),
    empty: document.getElementById("routes-empty"),
  };
}

export function initRoutesList() {
  const d = listIds();
  d.search.addEventListener("input", () => {
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      listState.q = d.search.value.trim();
      loadRoutesList();
    }, 300);
  });
  d.status.addEventListener("change", () => {
    listState.status = d.status.value;
    loadRoutesList();
  });
  window.addEventListener("routes:changed", () => loadRoutesList());
}

export async function loadRoutesList() {
  const d = listIds();
  if (!d.grid) return;
  const params = new URLSearchParams({ limit: String(listState.limit), offset: "0" });
  if (listState.q) params.set("q", listState.q);
  if (listState.status) params.set("status", listState.status);
  try {
    const page = await request("GET", `/manage/routes?${params.toString()}`);
    listState.total = page.total;
    Array.from(d.grid.querySelectorAll(".route-card")).forEach((n) => n.remove());
    if (!page.items.length) {
      d.empty && (d.empty.style.display = "flex");
    } else {
      d.empty && (d.empty.style.display = "none");
      for (const route of page.items) {
        d.grid.appendChild(buildRouteCard(route));
      }
    }
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось загрузить маршруты", "error");
  }
}

/** @param {any} route */
function buildRouteCard(route) {
  const badgeClass = route.status === "published" ? "badge-published" : route.status === "archived" ? "badge-archived" : "badge-draft";
  const imgWrap = el("div", { class: "route-card-img" }, [
    route.cover ? el("img", { src: route.cover.url, alt: "" }) : el("span", { textContent: TRANSPORT_LABELS[route.transport] || "" }),
  ]);
  const body = el(
    "div",
    { class: "route-card-body", role: "button", tabindex: "0", onclick: () => openExistingRoute(route.id) },
    [
      el("div", { class: "route-card-title", textContent: route.title }),
      el("div", { class: "route-card-meta" }, [
        el("span", { class: `badge ${badgeClass}`, textContent: STATUS_LABELS[route.status] }),
        el("span", { textContent: TRANSPORT_LABELS[route.transport] || route.transport }),
        route.duration_minutes ? el("span", { textContent: `${route.duration_minutes} мин` }) : null,
      ]),
    ]
  );
  return el("div", { class: "route-card" }, [imgWrap, body]);
}

/** @param {string} id */
async function openExistingRoute(id) {
  try {
    const route = await request("GET", `/manage/routes/${id}`);
    await openRouteModal(route);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось загрузить маршрут", "error");
  }
}
