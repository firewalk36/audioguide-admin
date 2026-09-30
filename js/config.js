// @ts-check

/**
 * Static runtime configuration for the admin panel.
 * There is no settings screen: these values are fixed at deploy time.
 */
export const CONFIG = {
  /** Base path for every API call; same origin as this page. */
  apiBase: "/api/v1",
  /** Yandex Maps JS API key (kept from the previous build). */
  yandexApiKey: "6d7f4f22-9bbd-4199-aad9-bd5e0053d7a3",
  /** [lat, lon] initial map center (Nizhny Novgorod). */
  mapCenter: [56.326887, 44.005986],
  mapZoom: 13,
  /** Address search needs a Yandex key with the geocoder; the current key has none. */
  geocoder: false,
};
