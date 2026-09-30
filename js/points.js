// @ts-check
import { request, ApiError } from "./api.js";
import { el, clear, toast, confirmDialog } from "./dom.js";
import { uploadMedia } from "./media.js";

/** @typedef {import("./map.js").AgMap} AgMap */

const PAGE_SIZE = 20;

/** @type {AgMap|null} */
let map = null;
/** @type {any} current point being edited, or null for a new point */
let current = null;
/** @type {string|null} */
let originalSnapshot = null;
/** @type {{lat:number, lon:number}|null} */
let draftCoords = null;
let busy = false;

const listState = { q: "", status: "", offset: 0, total: 0 };
let searchDebounce = /** @type {number|undefined} */ (undefined);

// ─── shared helpers ───

function ids() {
  return {
    panelEmpty: document.getElementById("panel-empty"),
    form: /** @type {HTMLFormElement} */ (document.getElementById("point-form")),
    footer: document.getElementById("panel-footer"),
    title: document.getElementById("panel-title"),
    deleteBtn: /** @type {HTMLButtonElement} */ (document.getElementById("pt-delete-btn")),
    saveBtn: /** @type {HTMLButtonElement} */ (document.getElementById("pt-save-btn")),
    closeBtn: document.getElementById("pt-close-btn"),
    fTitle: /** @type {HTMLInputElement} */ (document.getElementById("pt-title")),
    fShort: /** @type {HTMLTextAreaElement} */ (document.getElementById("pt-short-description")),
    fDesc: /** @type {HTMLTextAreaElement} */ (document.getElementById("pt-description")),
    fLat: /** @type {HTMLInputElement} */ (document.getElementById("pt-lat")),
    fLon: /** @type {HTMLInputElement} */ (document.getElementById("pt-lon")),
    fRadius: /** @type {HTMLInputElement} */ (document.getElementById("pt-trigger-radius")),
    fPublished: /** @type {HTMLInputElement} */ (document.getElementById("pt-published")),
    imgZone: document.getElementById("pt-image-zone"),
    imgInput: /** @type {HTMLInputElement} */ (document.getElementById("pt-image-input")),
    imgProgress: document.getElementById("pt-image-progress"),
    imgBar: /** @type {HTMLElement} */ (document.getElementById("pt-image-bar")),
    imgPreview: document.getElementById("pt-image-preview"),
    imgRemove: document.getElementById("pt-image-remove"),
    audioZone: document.getElementById("pt-audio-zone"),
    audioInput: /** @type {HTMLInputElement} */ (document.getElementById("pt-audio-input")),
    audioProgress: document.getElementById("pt-audio-progress"),
    audioBar: /** @type {HTMLElement} */ (document.getElementById("pt-audio-bar")),
    audioPreview: document.getElementById("pt-audio-preview"),
    audioPlayer: /** @type {HTMLAudioElement} */ (document.getElementById("pt-audio-player")),
    audioRemove: document.getElementById("pt-audio-remove"),
    routesList: document.getElementById("pt-routes-list"),
  };
}

/** @param {any} media */
let pendingImage = /** @type {any} */ (null);
let pendingAudio = /** @type {any} */ (null);

function snapshot() {
  const d = ids();
  return JSON.stringify({
    title: d.fTitle.value,
    short: d.fShort.value,
    desc: d.fDesc.value,
    lat: d.fLat.value,
    lon: d.fLon.value,
    radius: d.fRadius.value,
    published: d.fPublished.checked,
    image: pendingImage ? pendingImage.id : current && current.image ? current.image.id : null,
    audio: pendingAudio ? pendingAudio.id : current && current.audio ? current.audio.id : null,
  });
}

function isDirty() {
  return originalSnapshot !== null && snapshot() !== originalSnapshot;
}

/** Exposed for app.js's cross-screen navigation guard. */
export function pointEditorIsDirty() {
  return isDirty();
}

/** @param {number} lat @param {number} lon */
function syncCircle(lat, lon) {
  const d = ids();
  const radius = Number(d.fRadius.value);
  if (map && Number.isFinite(lat) && Number.isFinite(lon) && radius >= 10) {
    map.showTriggerCircle(lat, lon, radius);
  }
}

// ─── panel open/close ───

/** @param {any} point full PointOut, or null for a new point */
async function openEditor(point, coords) {
  const d = ids();
  current = point;
  pendingImage = null;
  pendingAudio = null;
  draftCoords = coords || null;
  d.panelEmpty && (d.panelEmpty.style.display = "none");
  d.form.style.display = "block";
  d.footer && (d.footer.style.display = "flex");
  d.title && (d.title.textContent = point ? point.title : "Новая точка");
  d.deleteBtn.style.display = point ? "inline-flex" : "none";

  d.fTitle.value = point ? point.title : "";
  d.fShort.value = point ? point.short_description || "" : "";
  d.fDesc.value = point ? point.description || "" : "";
  const lat = point ? point.lat : coords ? coords.lat : "";
  const lon = point ? point.lon : coords ? coords.lon : "";
  d.fLat.value = String(lat);
  d.fLon.value = String(lon);
  d.fRadius.value = String(point ? point.trigger_radius_m : 50);
  d.fPublished.checked = point ? point.status === "published" : false;

  renderMediaPreview("image", point ? point.image : null);
  renderMediaPreview("audio", point ? point.audio : null);
  clear(/** @type {Element} */ (d.routesList));

  if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lon))) {
    syncCircle(Number(lat), Number(lon));
    if (!point && map) map.showDraftMarker(Number(lat), Number(lon));
  }

  originalSnapshot = snapshot();

  if (point && point.route_ids && point.route_ids.length) {
    const routeLabels = await Promise.all(
      point.route_ids.map(async (/** @type {string} */ id) => {
        try {
          const route = await request("GET", `/manage/routes/${id}`);
          return route.title;
        } catch (err) {
          return id;
        }
      })
    );
    clear(/** @type {Element} */ (d.routesList));
    if (routeLabels.length) {
      for (const label of routeLabels) {
        d.routesList && d.routesList.appendChild(el("div", { class: "list-row-sub", textContent: `• ${label}` }));
      }
    } else {
      d.routesList && d.routesList.appendChild(el("div", { class: "form-hint", textContent: "Точка не входит ни в один маршрут" }));
    }
  } else if (d.routesList) {
    d.routesList.appendChild(el("div", { class: "form-hint", textContent: "Точка не входит ни в один маршрут" }));
  }
}

export async function closeEditor(force) {
  if (!force && isDirty()) {
    const ok = await confirmDialog("Есть несохранённые изменения. Закрыть без сохранения?");
    if (!ok) return false;
  }
  const d = ids();
  current = null;
  draftCoords = null;
  originalSnapshot = null;
  pendingImage = null;
  pendingAudio = null;
  d.panelEmpty && (d.panelEmpty.style.display = "flex");
  d.form.style.display = "none";
  d.footer && (d.footer.style.display = "none");
  map && map.clearDraftMarker();
  map && map.clearTriggerCircle();
  return true;
}

// ─── media handling ───

/**
 * @param {"image"|"audio"} kind
 * @param {any} media MediaRef or null
 */
function renderMediaPreview(kind, media) {
  const d = ids();
  if (kind === "image") {
    clear(/** @type {Element} */ (d.imgPreview));
    if (media) {
      d.imgPreview && d.imgPreview.classList.add("visible");
      const img = el("img", { src: media.url, alt: "Фото точки" });
      const info = el("div", { class: "upload-preview-info" }, [
        el("span", { class: "preview-filename", textContent: media.format.toUpperCase() }),
      ]);
      d.imgPreview && d.imgPreview.append(img, info);
    } else {
      d.imgPreview && d.imgPreview.classList.remove("visible");
    }
  } else {
    if (media) {
      d.audioPreview && d.audioPreview.classList.add("visible");
      d.audioPlayer.src = media.url;
      const durEl = document.getElementById("pt-audio-duration");
      if (durEl) durEl.textContent = media.duration_seconds ? `${Math.round(media.duration_seconds)} с` : "";
    } else {
      d.audioPreview && d.audioPreview.classList.remove("visible");
      d.audioPlayer.removeAttribute("src");
    }
  }
}

/** @param {"image"|"audio"} kind @param {File} file */
async function handleUpload(kind, file) {
  const d = ids();
  const zone = kind === "image" ? d.imgZone : d.audioZone;
  const progress = kind === "image" ? d.imgProgress : d.audioProgress;
  const bar = kind === "image" ? d.imgBar : d.audioBar;
  progress && progress.classList.add("visible");
  zone && zone.setAttribute("aria-busy", "true");
  try {
    const media = await uploadMedia(kind, file, (pct) => {
      if (bar) bar.style.transform = `scaleX(${pct / 100})`;
    });
    if (kind === "image") pendingImage = media;
    else pendingAudio = media;
    renderMediaPreview(kind, media);
    toast(kind === "image" ? "Фото загружено" : "Аудио загружено", "success");
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Не удалось загрузить файл";
    toast(message, "error");
  } finally {
    progress && progress.classList.remove("visible");
    if (bar) bar.style.transform = "scaleX(0)";
    zone && zone.removeAttribute("aria-busy");
  }
}

/** @param {"image"|"audio"} kind */
async function handleRemoveMedia(kind) {
  const field = kind === "image" ? "image_media_id" : "audio_media_id";
  const existingId = current ? current[field] : null;
  const pending = kind === "image" ? pendingImage : pendingAudio;
  if (current && current.id && existingId && (!pending || pending.id === existingId)) {
    const d = ids();
    d.saveBtn.disabled = true;
    try {
      const updated = await request("PATCH", `/manage/points/${current.id}`, { [field]: null });
      current = updated;
      if (kind === "image") pendingImage = null;
      else pendingAudio = null;
      renderMediaPreview(kind, null);
      toast("Медиафайл отвязан", "success");
    } catch (err) {
      toast(err instanceof ApiError ? err.message : "Не удалось отвязать файл", "error");
    } finally {
      d.saveBtn.disabled = false;
    }
  } else {
    if (kind === "image") pendingImage = null;
    else pendingAudio = null;
    renderMediaPreview(kind, null);
  }
}

// ─── save / delete ───

/** @param {SubmitEvent} e */
async function handleSubmit(e) {
  e.preventDefault();
  if (busy) return;
  const d = ids();
  const lat = Number(d.fLat.value);
  const lon = Number(d.fLon.value);
  const radius = Number(d.fRadius.value);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    toast("Широта должна быть от -90 до 90", "error");
    return;
  }
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    toast("Долгота должна быть от -180 до 180", "error");
    return;
  }
  if (!Number.isFinite(radius) || radius < 10 || radius > 500) {
    toast("Радиус срабатывания должен быть от 10 до 500 м", "error");
    return;
  }

  const payload = {
    title: d.fTitle.value.trim(),
    short_description: d.fShort.value.trim() || null,
    description: d.fDesc.value.trim() || null,
    lat,
    lon,
    trigger_radius_m: radius,
    status: d.fPublished.checked ? "published" : "draft",
    image_media_id: pendingImage ? pendingImage.id : current ? current.image_media_id : null,
    audio_media_id: pendingAudio ? pendingAudio.id : current ? current.audio_media_id : null,
  };

  busy = true;
  d.saveBtn.disabled = true;
  try {
    let saved;
    if (current && current.id) {
      saved = await request("PATCH", `/manage/points/${current.id}`, payload);
      toast("Точка сохранена", "success");
    } else {
      saved = await request("POST", "/manage/points", payload);
      toast("Точка создана", "success");
    }
    current = saved;
    originalSnapshot = snapshot();
    pendingImage = null;
    pendingAudio = null;
    map && map.clearDraftMarker();
    window.dispatchEvent(new CustomEvent("points:changed"));
    await openEditor(saved, null);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось сохранить точку", "error");
  } finally {
    busy = false;
    d.saveBtn.disabled = false;
  }
}

async function handleDelete() {
  if (!current || !current.id) return;
  const ok = await confirmDialog(`Удалить точку «${current.title}»? Это действие необратимо.`);
  if (!ok) return;
  const d = ids();
  d.deleteBtn.disabled = true;
  try {
    await request("DELETE", `/manage/points/${current.id}`);
    toast("Точка удалена", "success");
    window.dispatchEvent(new CustomEvent("points:changed"));
    await closeEditor(true);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось удалить точку", "error");
  } finally {
    d.deleteBtn.disabled = false;
  }
}

// ─── map wiring ───

/** @param {AgMap} agMap */
export function attachMap(agMap) {
  map = agMap;
  map.callbacks.onMapClick = async (lat, lon) => {
    if (isDirty() && !(await confirmDialog("Есть несохранённые изменения. Создать новую точку без сохранения текущей?"))) return;
    await openEditor(null, { lat, lon });
  };
  map.callbacks.onMarkerClick = async (pointId) => {
    if (current && current.id === pointId) return;
    if (isDirty() && !(await confirmDialog("Есть несохранённые изменения. Открыть другую точку без сохранения?"))) return;
    await openPointById(pointId);
  };
  map.callbacks.onMarkerDragEnd = async (pointId, lat, lon) => {
    if (!current || current.id !== pointId) {
      if (isDirty() && !(await confirmDialog("Есть несохранённые изменения. Открыть перемещённую точку без сохранения?"))) return;
      await openPointById(pointId);
    }
    const d = ids();
    d.fLat.value = String(lat.toFixed(6));
    d.fLon.value = String(lon.toFixed(6));
    syncCircle(lat, lon);
  };
}

/** @param {string} id */
export async function openPointById(id) {
  try {
    const point = await request("GET", `/manage/points/${id}`);
    await openEditor(point, null);
    map && map.panTo(id);
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось загрузить точку", "error");
  }
}

/** Refresh the placemarks shown on the map from the full points list. */
export async function refreshMapPoints() {
  if (!map) return;
  try {
    const page = await request("GET", "/manage/points?limit=500&offset=0");
    map.renderPoints(page.items);
  } catch (err) {
    // Non-fatal: map just stays empty/stale.
  }
}

// ─── panel form wiring (called once) ───

export function initPanel() {
  const d = ids();
  d.form.addEventListener("submit", handleSubmit);
  d.deleteBtn.addEventListener("click", handleDelete);
  d.closeBtn && d.closeBtn.addEventListener("click", () => closeEditor(false));
  d.fRadius.addEventListener("input", () => {
    const lat = Number(d.fLat.value);
    const lon = Number(d.fLon.value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) syncCircle(lat, lon);
  });
  d.fLat.addEventListener("change", () => {
    const lat = Number(d.fLat.value);
    const lon = Number(d.fLon.value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      syncCircle(lat, lon);
      if (current && current.id && map) map.showDraftMarker(lat, lon);
    }
  });
  d.fLon.addEventListener("change", () => {
    const lat = Number(d.fLat.value);
    const lon = Number(d.fLon.value);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      syncCircle(lat, lon);
      if (current && current.id && map) map.showDraftMarker(lat, lon);
    }
  });
  d.imgInput.addEventListener("change", () => {
    const file = d.imgInput.files && d.imgInput.files[0];
    d.imgInput.value = "";
    if (file) handleUpload("image", file);
  });
  d.audioInput.addEventListener("change", () => {
    const file = d.audioInput.files && d.audioInput.files[0];
    d.audioInput.value = "";
    if (file) handleUpload("audio", file);
  });
  d.imgRemove && d.imgRemove.addEventListener("click", () => handleRemoveMedia("image"));
  d.audioRemove && d.audioRemove.addEventListener("click", () => handleRemoveMedia("audio"));
}

// ─── points list screen ───

function listIds() {
  return {
    search: /** @type {HTMLInputElement} */ (document.getElementById("points-search")),
    status: /** @type {HTMLSelectElement} */ (document.getElementById("points-status-filter")),
    list: document.getElementById("points-list"),
    empty: document.getElementById("points-empty"),
    prev: /** @type {HTMLButtonElement} */ (document.getElementById("points-prev")),
    next: /** @type {HTMLButtonElement} */ (document.getElementById("points-next")),
    info: document.getElementById("points-page-info"),
  };
}

export function initPointsList(onOpenPointRequest) {
  const d = listIds();
  d.search.addEventListener("input", () => {
    window.clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      listState.q = d.search.value.trim();
      listState.offset = 0;
      loadList(onOpenPointRequest);
    }, 300);
  });
  d.status.addEventListener("change", () => {
    listState.status = d.status.value;
    listState.offset = 0;
    loadList(onOpenPointRequest);
  });
  d.prev.addEventListener("click", () => {
    listState.offset = Math.max(0, listState.offset - PAGE_SIZE);
    loadList(onOpenPointRequest);
  });
  d.next.addEventListener("click", () => {
    listState.offset += PAGE_SIZE;
    loadList(onOpenPointRequest);
  });
  window.addEventListener("points:changed", () => loadList(onOpenPointRequest));
}

export async function loadList(onOpenPointRequest) {
  const d = listIds();
  if (!d.list) return;
  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(listState.offset) });
  if (listState.q) params.set("q", listState.q);
  if (listState.status) params.set("status", listState.status);
  try {
    const page = await request("GET", `/manage/points?${params.toString()}`);
    listState.total = page.total;
    clear(/** @type {Element} */ (d.list));
    if (!page.items.length) {
      d.empty && (d.empty.style.display = "flex");
    } else {
      d.empty && (d.empty.style.display = "none");
      for (const point of page.items) {
        const row = el(
          "div",
          {
            class: "list-row",
            role: "button",
            tabindex: "0",
            onclick: () => onOpenPointRequest(point.id),
            onkeydown: (/** @type {KeyboardEvent} */ ev) => {
              if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                onOpenPointRequest(point.id);
              }
            },
          },
          [
            el("div", { class: "list-row-main" }, [
              el("div", { class: "list-row-title", textContent: point.title }),
              el("div", { class: "list-row-sub", textContent: point.short_description || "" }),
            ]),
            el("div", { class: "list-row-meta" }, [
              el("span", {
                class: `badge ${point.status === "published" ? "badge-published" : "badge-draft"}`,
                textContent: point.status === "published" ? "Опубликована" : "Черновик",
              }),
            ]),
          ]
        );
        d.list.appendChild(row);
      }
    }
    const from = page.total === 0 ? 0 : listState.offset + 1;
    const to = Math.min(listState.offset + PAGE_SIZE, page.total);
    d.info && (d.info.textContent = `${from}–${to} из ${page.total}`);
    d.prev.disabled = listState.offset === 0;
    d.next.disabled = listState.offset + PAGE_SIZE >= page.total;
  } catch (err) {
    toast(err instanceof ApiError ? err.message : "Не удалось загрузить точки", "error");
  }
}

export function getPointsTotal() {
  return listState.total;
}
