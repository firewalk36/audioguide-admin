// @ts-check
import { CONFIG } from "./config.js";
import { ApiError, errorFromStatus } from "./api.js";

/**
 * @typedef {{ id: string, url: string, resource_type: string, format: string,
 *   duration_seconds: number|null }} MediaRef
 */

const LIMITS = {
  image: { maxBytes: 10 * 1024 * 1024, formats: ["jpg", "jpeg", "png", "webp"], mimes: ["image/jpeg", "image/png", "image/webp"] },
  audio: { maxBytes: 30 * 1024 * 1024, formats: ["mp3", "m4a", "aac", "ogg", "wav"], mimes: ["audio/mpeg", "audio/mp3", "audio/m4a", "audio/aac", "audio/ogg", "audio/wav", "audio/x-wav", "audio/x-m4a"] },
};

/**
 * @param {"image"|"audio"} kind
 * @param {File} file
 * @returns {string|null} error message, or null if the file passes.
 */
export function validateFile(kind, file) {
  const limit = LIMITS[kind];
  if (file.size > limit.maxBytes) {
    const mb = Math.round(limit.maxBytes / 1024 / 1024);
    return `Файл слишком большой (максимум ${mb} МБ)`;
  }
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!limit.formats.includes(ext)) {
    return `Недопустимый формат «.${ext}». Разрешены: ${limit.formats.join(", ")}`;
  }
  return null;
}

/**
 * Upload a file end-to-end: client-side validation, then a single
 * multipart POST to our own `/manage/media` endpoint (media is stored on
 * our own server, under the app's `MEDIA_ROOT`).
 * @param {"image"|"audio"} kind
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<MediaRef>}
 */
export async function uploadMedia(kind, file, onProgress) {
  const invalid = validateFile(kind, file);
  if (invalid) throw new ApiError(0, invalid);

  return postMedia(kind, file, onProgress);
}

/**
 * @param {"image"|"audio"} kind
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<MediaRef>}
 */
function postMedia(kind, file, onProgress) {
  const path = "/manage/media";
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("kind", kind);
    form.append("file", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", CONFIG.apiBase + path);
    xhr.setRequestHeader("X-Requested-With", "fetch");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      /** @type {any} */
      let data = null;
      if (xhr.responseText) {
        try {
          data = JSON.parse(xhr.responseText);
        } catch (parseError) {
          data = null;
        }
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(/** @type {MediaRef} */ (data));
        return;
      }
      const detail = data && typeof data.detail === "string" && data.detail ? data.detail : "";
      reject(errorFromStatus(xhr.status, detail, path, xhr.statusText));
    };
    xhr.onerror = () => reject(new ApiError(0, "Сбой сети при загрузке файла"));
    xhr.send(form);
  });
}
