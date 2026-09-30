// @ts-check
import { request, ApiError } from "./api.js";

/**
 * @typedef {{ id: string, url: string, resource_type: string, format: string,
 *   duration_seconds: number|null }} MediaRef
 */

const LIMITS = {
  image: { maxBytes: 5 * 1024 * 1024, formats: ["jpg", "jpeg", "png", "webp"], mimes: ["image/jpeg", "image/png", "image/webp"] },
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
 * Upload a file end-to-end: client validation, signed URL, direct
 * multipart POST to Cloudinary with progress, then server-side confirm.
 * @param {"image"|"audio"} kind
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<MediaRef>}
 */
export async function uploadMedia(kind, file, onProgress) {
  const invalid = validateFile(kind, file);
  if (invalid) throw new ApiError(0, invalid);

  const sign = await request("POST", "/manage/media/sign", { kind });

  await postToCloudinary(sign, file, onProgress);

  const confirmed = await request("POST", "/manage/media/confirm", {
    kind,
    public_id: sign.public_id,
  });
  return confirmed;
}

/**
 * @param {any} sign
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<void>}
 */
function postToCloudinary(sign, file, onProgress) {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.append("file", file);
    form.append("api_key", sign.api_key);
    form.append("timestamp", String(sign.timestamp));
    form.append("signature", sign.signature);
    form.append("folder", sign.folder);
    form.append("public_id", sign.public_id);
    if (sign.allowed_formats) form.append("allowed_formats", sign.allowed_formats);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", sign.upload_url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress((e.loaded / e.total) * 100);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new ApiError(xhr.status, "Не удалось загрузить файл в хранилище"));
      }
    };
    xhr.onerror = () => reject(new ApiError(0, "Сбой сети при загрузке файла"));
    xhr.send(form);
  });
}
