// @ts-check
import { CONFIG } from "./config.js";
import { escapeHtml, el } from "./dom.js";

/**
 * @typedef {{ id: string, title: string, lat: number, lon: number,
 *   trigger_radius_m: number, status: "draft"|"published" }} MapPoint
 */

let scriptPromise = /** @type {Promise<void>|null} */ (null);

/**
 * Dynamically load the Yandex Maps JS API script, with one retry on
 * failure. Resolves once `window.ymaps` is ready.
 * @returns {Promise<void>}
 */
function loadYandexMaps() {
  if (window.ymaps) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  const load = () =>
    new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://api-maps.yandex.ru/2.1/?apikey=${CONFIG.yandexApiKey}&lang=ru_RU`;
      script.onload = () => {
        // @ts-ignore ymaps global injected by the script
        window.ymaps.ready(resolve);
      };
      script.onerror = () => reject(new Error("Не удалось загрузить Яндекс Карты"));
      document.head.appendChild(script);
    });

  scriptPromise = load().catch(() => {
    scriptPromise = null; // allow a fresh retry
    return load();
  });
  return scriptPromise;
}

const PIN_COLORS = { draft: "#964219", published: "#01696f" };

export class AgMap {
  /**
   * @param {string} containerId
   * @param {{
   *   onMapClick?: (lat: number, lon: number) => void,
   *   onMarkerClick?: (pointId: string) => void,
   *   onMarkerDragEnd?: (pointId: string, lat: number, lon: number) => void,
   * }} callbacks
   */
  constructor(containerId, callbacks = {}) {
    this.containerId = containerId;
    this.callbacks = callbacks;
    this.map = /** @type {any} */ (null);
    this.placemarks = new Map();
    this.routeLine = /** @type {any} */ (null);
    this.triggerCircle = /** @type {any} */ (null);
    this.draftMarker = /** @type {any} */ (null);
  }

  /** @returns {Promise<void>} */
  async load() {
    await loadYandexMaps();
    // @ts-ignore
    const ymaps = window.ymaps;
    this.ymaps = ymaps;
    this.map = new ymaps.Map(this.containerId, {
      center: CONFIG.mapCenter,
      zoom: CONFIG.mapZoom,
      controls: ["zoomControl", "geolocationControl"],
    });
    this.map.events.add("click", (/** @type {any} */ e) => {
      const coords = e.get("coords");
      this.callbacks.onMapClick && this.callbacks.onMapClick(coords[0], coords[1]);
    });
  }

  /**
   * Re-render all point placemarks from scratch.
   * @param {MapPoint[]} points
   */
  renderPoints(points) {
    for (const pm of this.placemarks.values()) this.map.geoObjects.remove(pm);
    this.placemarks.clear();
    for (const point of points) {
      const placemark = new this.ymaps.Placemark(
        [point.lat, point.lon],
        {
          hintContent: escapeHtml(point.title),
          balloonContent: `${escapeHtml(point.title)}${point.status === "draft" ? " (черновик)" : ""}`,
        },
        {
          preset: "islands#circleIcon",
          iconColor: PIN_COLORS[point.status] || PIN_COLORS.draft,
          draggable: true,
        }
      );
      placemark.events.add("click", () => {
        this.callbacks.onMarkerClick && this.callbacks.onMarkerClick(point.id);
      });
      placemark.events.add("dragend", () => {
        const coords = placemark.geometry.getCoordinates();
        this.callbacks.onMarkerDragEnd && this.callbacks.onMarkerDragEnd(point.id, coords[0], coords[1]);
      });
      this.map.geoObjects.add(placemark);
      this.placemarks.set(point.id, placemark);
    }
  }

  /** @param {string} id */
  panTo(id) {
    const pm = this.placemarks.get(id);
    if (pm) this.map.panTo(pm.geometry.getCoordinates(), { flying: true });
  }

  /**
   * Show a draft (unsaved) marker at the given coordinates, e.g. right
   * after a map click before the point is saved.
   * @param {number} lat
   * @param {number} lon
   */
  showDraftMarker(lat, lon) {
    this.clearDraftMarker();
    this.draftMarker = new this.ymaps.Placemark([lat, lon], {}, { preset: "islands#circleDotIcon", iconColor: "#7a7974" });
    this.map.geoObjects.add(this.draftMarker);
  }

  clearDraftMarker() {
    if (this.draftMarker) {
      this.map.geoObjects.remove(this.draftMarker);
      this.draftMarker = null;
    }
  }

  /**
   * @param {number} lat
   * @param {number} lon
   * @param {number} radiusM
   */
  showTriggerCircle(lat, lon, radiusM) {
    this.clearTriggerCircle();
    this.triggerCircle = new this.ymaps.Circle(
      [[lat, lon], radiusM],
      {},
      { fillColor: "#01696f33", strokeColor: "#01696f", strokeWidth: 2 }
    );
    this.map.geoObjects.add(this.triggerCircle);
  }

  clearTriggerCircle() {
    if (this.triggerCircle) {
      this.map.geoObjects.remove(this.triggerCircle);
      this.triggerCircle = null;
    }
  }

  /** @param {[number, number][]} coords ordered [lat, lon] pairs */
  showRoutePolyline(coords) {
    this.clearRoutePolyline();
    if (coords.length < 2) return;
    this.routeLine = new this.ymaps.Polyline(
      coords,
      {},
      { strokeColor: "#01696f", strokeWidth: 3, strokeOpacity: 0.85 }
    );
    this.map.geoObjects.add(this.routeLine);
  }

  clearRoutePolyline() {
    if (this.routeLine) {
      this.map.geoObjects.remove(this.routeLine);
      this.routeLine = null;
    }
  }

  /**
   * Wire a text input as a Yandex geocoder search box: Enter geocodes the
   * text and pans/zooms the map to the first match. If the API key does
   * not include the geocoder service, the box shows an inline explanation
   * and disables itself for the rest of the session (no repeated toasts).
   * @param {HTMLInputElement} input
   */
  attachSearchBox(input) {
    input.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const query = input.value.trim();
      if (!query) return;
      try {
        const res = await this.ymaps.geocode(query, { results: 1 });
        const first = res.geoObjects.get(0);
        if (!first) return;
        const coords = first.geometry.getCoordinates();
        this.map.setCenter(coords, 17, { checkZoomRange: true });
      } catch (err) {
        this._disableSearchBox(input);
      }
    });
  }

  /**
   * Disable the geocoder search box and show an inline explanation next to
   * it, instead of repeating a toast on every failed search.
   * @param {HTMLInputElement} input
   */
  _disableSearchBox(input) {
    input.disabled = true;
    input.placeholder = "Поиск адреса недоступен";
    const wrap = input.closest(".map-search");
    if (!wrap || wrap.querySelector(".map-search-msg")) return;
    wrap.appendChild(
      el(
        "div",
        { class: "map-search-msg" },
        "Поиск адреса недоступен: ключ Яндекс.Карт не включает геокодер. Поставьте точку кликом по карте или введите координаты."
      )
    );
  }
}
