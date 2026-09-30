#!/usr/bin/env python3
"""In-memory mock of the AudioGuide admin API, for local frontend verification.
Serves the repo's static files AND implements the /api/v1 contract (auth,
points, routes, users, local media upload + `/media/...` file serving) well
enough to exercise the admin panel end to end.
Usage: python3 dev/mock_server.py [port]   (default 8766). Stdlib only.
"""
import hashlib, json, os, re, secrets, sys, time, traceback, uuid
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SESSION_COOKIE = "ag_session"

USERS, SESSIONS, POINTS, ROUTES, MEDIA = {}, {}, {}, {}, {}  # token_hash -> user_id
MEDIA_FILES = {}  # public_id ("images/<hex>.jpg" | "audio/<hex>.<ext>") -> raw bytes

IMAGE_EXTS = ("jpg", "jpeg", "png", "webp")
AUDIO_EXTS = ("mp3", "m4a", "aac", "ogg", "wav")
MEDIA_CONTENT_TYPES = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp",
    "mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "ogg": "audio/ogg", "wav": "audio/wav",
}

POINT_FIELDS = ("title", "short_description", "description", "lat", "lon",
                "trigger_radius_m", "status", "image_media_id", "audio_media_id")
ROUTE_FIELDS = ("title", "description", "transport", "status", "cover_media_id",
                 "intro_audio_media_id", "duration_minutes", "distance_meters")


def now_iso():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def seed():
    for uid, email, name, pw, role in (
        (str(uuid.uuid4()), "admin@example.com", "Админ", "admin-password-1", "admin"),
        (str(uuid.uuid4()), "ed@example.com", "Редактор Эд", "editor-password-1", "editor"),
    ):
        USERS[uid] = {"id": uid, "email": email, "name": name, "password": pw, "role": role,
                       "is_active": True, "last_login_at": None, "created_at": now_iso()}


class ApiError(Exception):
    def __init__(self, status, detail):
        self.status, self.detail = status, detail


def user_out(u):
    return {k: u[k] for k in ("id", "email", "name", "role", "is_active", "last_login_at", "created_at")}


def media_ref(mid):
    if not mid or mid not in MEDIA:
        return None
    m = MEDIA[mid]
    return {"id": m["id"], "url": m["url"], "resource_type": m["resource_type"],
             "format": m["format"], "duration_seconds": m["duration_seconds"]}


def point_out(p):
    out = dict(p)
    out["image"] = media_ref(p.get("image_media_id"))
    out["audio"] = media_ref(p.get("audio_media_id"))
    out["route_ids"] = [r["id"] for r in ROUTES.values() if p["id"] in r["point_ids"]]
    return out


def route_out(r):
    out = dict(r)
    out["cover"] = media_ref(r.get("cover_media_id"))
    out["intro_audio"] = media_ref(r.get("intro_audio_media_id"))
    out["point_ids"] = list(r["point_ids"])
    return out


class Handler(BaseHTTPRequestHandler):
    server_version = "AGMock/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[mock] " + (fmt % args) + "\n")

    # ── response helpers ──

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def _send_no_content(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except ValueError:
            raise ApiError(422, "Invalid JSON body")

    def _read_raw(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        return self.rfile.read(length) if length else b""

    def _require_csrf(self):
        if self.headers.get("X-Requested-With") != "fetch":
            raise ApiError(403, "Missing X-Requested-With header")

    def _current_user(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        token = jar[SESSION_COOKIE].value if SESSION_COOKIE in jar else None
        user_id = SESSIONS.get(hashlib.sha256(token.encode()).hexdigest()) if token else None
        if not user_id or user_id not in USERS or not USERS[user_id]["is_active"]:
            raise ApiError(401, "Not authenticated")
        return USERS[user_id]

    def _require_admin(self):
        user = self._current_user()
        if user["role"] != "admin":
            raise ApiError(403, "Forbidden")
        return user

    def _set_session_cookie(self, token):
        c = cookies.SimpleCookie()
        c[SESSION_COOKIE] = token
        c[SESSION_COOKIE]["path"], c[SESSION_COOKIE]["httponly"] = "/", True
        self.send_header("Set-Cookie", c[SESSION_COOKIE].OutputString())

    def _clear_session_cookie(self):
        c = cookies.SimpleCookie()
        c[SESSION_COOKIE] = ""
        c[SESSION_COOKIE]["path"], c[SESSION_COOKIE]["max-age"] = "/", 0
        self.send_header("Set-Cookie", c[SESSION_COOKIE].OutputString())

    # ── dispatch ──

    def do_GET(self): self._dispatch("GET")
    def do_POST(self): self._dispatch("POST")
    def do_PATCH(self): self._dispatch("PATCH")
    def do_PUT(self): self._dispatch("PUT")
    def do_DELETE(self): self._dispatch("DELETE")

    def _dispatch(self, method):
        # http.server decodes the request line as latin-1; recover UTF-8 text
        # (needed for Cyrillic search queries) before parsing it.
        try:
            fixed_path = self.path.encode("iso-8859-1").decode("utf-8")
        except (UnicodeDecodeError, UnicodeEncodeError):
            fixed_path = self.path
        parsed = urlparse(fixed_path)
        path, query = parsed.path, parse_qs(parsed.query)
        try:
            if path.startswith("/api/v1/"):
                self._require_csrf()
                self._route_api(method, path[len("/api/v1"):], query)
            elif path.startswith("/media/") and method == "GET":
                self._serve_media(path)
            else:
                self._serve_static(path)
        except ApiError as e:
            self._send_json(e.status, {"detail": e.detail})
        except Exception as e:  # pragma: no cover - safety net
            traceback.print_exc()
            self._send_json(500, {"detail": "Internal Server Error: %s" % e})

    def _serve_static(self, path):
        safe = os.path.normpath("/index.html" if path == "/" else path).lstrip("/")
        full = os.path.join(ROOT, safe)
        if not full.startswith(ROOT) or not os.path.isfile(full):
            return self._send_json(404, {"detail": "Not found"})
        ctype = "text/css" if full.endswith(".css") else "application/javascript" if full.endswith(".js") else "text/html"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _serve_media(self, path):
        public_id = path[len("/media/"):]
        data = MEDIA_FILES.get(public_id)
        if data is None:
            return self._send_json(404, {"detail": "Not found"})
        ext = public_id.rsplit(".", 1)[-1].lower() if "." in public_id else ""
        ctype = MEDIA_CONTENT_TYPES.get(ext, "application/octet-stream")
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ── api router ──

    ROUTES_TABLE = [
        ("POST", r"^/auth/login$", "_login"),
        ("POST", r"^/auth/logout$", "_logout"),
        ("GET", r"^/auth/me$", "_me"),
        ("GET", r"^/manage/points$", "_list_points"),
        ("POST", r"^/manage/points$", "_create_point"),
        ("GET", r"^/manage/points/([^/]+)$", "_get_point"),
        ("PATCH", r"^/manage/points/([^/]+)$", "_patch_point"),
        ("DELETE", r"^/manage/points/([^/]+)$", "_delete_point"),
        ("GET", r"^/manage/routes$", "_list_routes"),
        ("POST", r"^/manage/routes$", "_create_route"),
        ("GET", r"^/manage/routes/([^/]+)$", "_get_route"),
        ("PATCH", r"^/manage/routes/([^/]+)$", "_patch_route"),
        ("DELETE", r"^/manage/routes/([^/]+)$", "_delete_route"),
        ("PUT", r"^/manage/routes/([^/]+)/points$", "_set_route_points"),
        ("GET", r"^/manage/users$", "_list_users"),
        ("POST", r"^/manage/users$", "_create_user"),
        ("PATCH", r"^/manage/users/([^/]+)$", "_patch_user"),
        ("POST", r"^/manage/media$", "_media_upload"),
        ("DELETE", r"^/manage/media/([^/]+)$", "_media_delete"),
    ]

    def _route_api(self, method, path, query):
        for rmethod, pattern, handler_name in self.ROUTES_TABLE:
            if rmethod != method:
                continue
            m = re.match(pattern, path)
            if not m:
                continue
            handler = getattr(self, handler_name)
            args = list(m.groups())
            if handler_name in ("_list_points", "_list_routes"):
                args.append(query)
            return handler(*args)
        self._send_json(404, {"detail": "Not found"})

    # ── auth ──

    def _login(self):
        body = self._read_json()
        email = str(body.get("email", "")).strip().lower()
        user = next((u for u in USERS.values() if u["email"] == email), None)
        if not user or user["password"] != body.get("password") or not user["is_active"]:
            raise ApiError(401, "Invalid email or password")
        token = secrets.token_urlsafe(32)
        SESSIONS[hashlib.sha256(token.encode()).hexdigest()] = user["id"]
        user["last_login_at"] = now_iso()
        body_bytes = json.dumps(user_out(user)).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self._set_session_cookie(token)
        self.send_header("Content-Length", str(len(body_bytes)))
        self.end_headers()
        self.wfile.write(body_bytes)

    def _logout(self):
        jar = cookies.SimpleCookie(self.headers.get("Cookie", ""))
        if SESSION_COOKIE in jar:
            SESSIONS.pop(hashlib.sha256(jar[SESSION_COOKIE].value.encode()).hexdigest(), None)
        self.send_response(204)
        self._clear_session_cookie()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _me(self):
        self._send_json(200, user_out(self._current_user()))

    # ── generic list/patch used by points & routes ──

    def _query_page(self, store, query, sort_key, title_field="title", reverse=False):
        status, q = (query.get("status") or [None])[0], (query.get("q") or [None])[0]
        limit, offset = int((query.get("limit") or ["50"])[0]), int((query.get("offset") or ["0"])[0])
        items = list(store.values())
        if status:
            items = [x for x in items if x["status"] == status]
        if q:
            items = [x for x in items if q.lower() in x[title_field].lower()]
        items.sort(key=sort_key, reverse=reverse)
        return items[offset:offset + limit], len(items)

    def _apply_patch(self, entity, body, fields, user):
        for key in fields:
            if key in body:
                entity[key] = body[key]
        entity["updated_by_id"] = user["id"]
        entity["updated_at"] = now_iso()

    # ── points ──

    def _list_points(self, query):
        self._current_user()
        page, total = self._query_page(POINTS, query, lambda p: p["title"])
        self._send_json(200, {"items": [point_out(p) for p in page], "total": total})

    def _create_point(self):
        user = self._current_user()
        body = self._read_json()
        pid = str(uuid.uuid4())
        point = {f: body.get(f) for f in POINT_FIELDS}
        point.update({"id": pid, "trigger_radius_m": body.get("trigger_radius_m", 50),
                       "status": body.get("status", "draft"), "created_by_id": user["id"],
                       "updated_by_id": user["id"], "created_at": now_iso(), "updated_at": now_iso()})
        POINTS[pid] = point
        self._send_json(201, point_out(point))

    def _get_point(self, pid):
        self._current_user()
        if pid not in POINTS:
            raise ApiError(404, "Point not found")
        self._send_json(200, point_out(POINTS[pid]))

    def _patch_point(self, pid):
        user = self._current_user()
        if pid not in POINTS:
            raise ApiError(404, "Point not found")
        self._apply_patch(POINTS[pid], self._read_json(), POINT_FIELDS, user)
        self._send_json(200, point_out(POINTS[pid]))

    def _delete_point(self, pid):
        self._current_user()
        if pid not in POINTS:
            raise ApiError(404, "Point not found")
        del POINTS[pid]
        for r in ROUTES.values():
            r["point_ids"] = [x for x in r["point_ids"] if x != pid]
        self._send_no_content()

    # ── routes ──

    def _list_routes(self, query):
        self._current_user()
        page, total = self._query_page(ROUTES, query, lambda r: r["created_at"], reverse=True)
        self._send_json(200, {"items": [route_out(r) for r in page], "total": total})

    def _create_route(self):
        user = self._current_user()
        body = self._read_json()
        rid = str(uuid.uuid4())
        route = {f: body.get(f) for f in ROUTE_FIELDS}
        route.update({"id": rid, "transport": body.get("transport", "walk"),
                       "status": body.get("status", "draft"), "point_ids": [],
                       "created_by_id": user["id"], "updated_by_id": user["id"],
                       "created_at": now_iso(), "updated_at": now_iso()})
        ROUTES[rid] = route
        self._send_json(201, route_out(route))

    def _get_route(self, rid):
        self._current_user()
        if rid not in ROUTES:
            raise ApiError(404, "Route not found")
        self._send_json(200, route_out(ROUTES[rid]))

    def _patch_route(self, rid):
        user = self._current_user()
        if rid not in ROUTES:
            raise ApiError(404, "Route not found")
        self._apply_patch(ROUTES[rid], self._read_json(), ROUTE_FIELDS, user)
        self._send_json(200, route_out(ROUTES[rid]))

    def _delete_route(self, rid):
        self._require_admin()
        if rid not in ROUTES:
            raise ApiError(404, "Route not found")
        del ROUTES[rid]
        self._send_no_content()

    def _set_route_points(self, rid):
        self._current_user()
        if rid not in ROUTES:
            raise ApiError(404, "Route not found")
        point_ids = self._read_json().get("point_ids", [])
        if len(point_ids) != len(set(point_ids)):
            raise ApiError(422, "point_ids must be unique")
        missing = [pid for pid in point_ids if pid not in POINTS]
        if missing:
            raise ApiError(422, "Unknown point ids: %s" % ", ".join(missing))
        ROUTES[rid]["point_ids"] = list(point_ids)
        ROUTES[rid]["updated_at"] = now_iso()
        self._send_json(200, route_out(ROUTES[rid]))

    # ── users ──

    def _list_users(self):
        self._require_admin()
        items = sorted(USERS.values(), key=lambda u: u["created_at"])
        self._send_json(200, [user_out(u) for u in items])

    def _create_user(self):
        self._require_admin()
        body = self._read_json()
        email = str(body.get("email", "")).strip().lower()
        if any(u["email"] == email for u in USERS.values()):
            raise ApiError(409, "Email already registered")
        if len(body.get("password", "")) < 10:
            raise ApiError(422, "password: ensure this value has at least 10 characters")
        uid = str(uuid.uuid4())
        user = {"id": uid, "email": email, "name": body.get("name", ""), "password": body["password"],
                 "role": body.get("role", "editor"), "is_active": True, "last_login_at": None,
                 "created_at": now_iso()}
        USERS[uid] = user
        self._send_json(201, user_out(user))

    def _patch_user(self, uid):
        admin = self._require_admin()
        if uid not in USERS:
            raise ApiError(404, "User not found")
        body, user = self._read_json(), USERS[uid]
        if uid == admin["id"] and (body.get("role") == "editor" or body.get("is_active") is False):
            raise ApiError(400, "Cannot demote or deactivate yourself")
        for key in ("name", "role", "is_active"):
            if body.get(key) is not None:
                user[key] = body[key]
        if body.get("password"):
            if len(body["password"]) < 10:
                raise ApiError(422, "password: ensure this value has at least 10 characters")
            user["password"] = body["password"]
        self._send_json(200, user_out(user))

    # ── media ──

    def _media_upload(self):
        user = self._current_user()
        m = re.search(r"boundary=(.+)", self.headers.get("Content-Type", ""))
        if not m:
            raise ApiError(422, "Файл повреждён или не является изображением")
        boundary, fields, filename = m.group(1).strip('"').encode(), {}, "upload.bin"
        for part in self._read_raw().split(b"--" + boundary):
            part = part.strip(b"\r\n")
            if not part or part == b"--" or b"\r\n\r\n" not in part:
                continue
            head, data = part.split(b"\r\n\r\n", 1)
            data = data.rstrip(b"\r\n")
            name_m = re.search(rb'name="([^"]+)"', head)
            if not name_m:
                continue
            field = name_m.group(1).decode()
            if field == "file":
                fname_m = re.search(rb'filename="([^"]+)"', head)
                if fname_m:
                    filename = fname_m.group(1).decode()
                fields["_file_bytes"] = data
            else:
                fields[field] = data.decode(errors="ignore")

        kind = fields.get("kind")
        if kind not in ("image", "audio"):
            raise ApiError(422, "Неподдерживаемый формат файла")

        file_bytes = fields.get("_file_bytes", b"")
        ext = (filename.rsplit(".", 1)[-1] if "." in filename else "").lower()
        allowed = IMAGE_EXTS if kind == "image" else AUDIO_EXTS
        if ext not in allowed:
            detail = "Файл повреждён или не является изображения" if kind == "image" else "Файл повреждён или не является аудио"
            raise ApiError(422, "Неподдерживаемый формат файла" if not ext else detail)

        # Real backend always re-encodes images to JPEG; keep the mock's stored
        # extension in sync with that so `<MEDIA_ROOT>/images/<hex>.jpg` holds.
        fmt = "jpg" if kind == "image" else ext
        subdir = "images" if kind == "image" else "audio"
        public_id = "%s/%s.%s" % (subdir, uuid.uuid4().hex, fmt)
        MEDIA_FILES[public_id] = file_bytes

        mid = str(uuid.uuid4())
        MEDIA[mid] = {"id": mid, "public_id": public_id, "resource_type": kind, "format": fmt,
                       "bytes": len(file_bytes), "duration_seconds": 12.3 if kind == "audio" else None,
                       "url": "/media/%s" % public_id, "uploaded_by_id": user["id"], "created_at": now_iso()}
        self._send_json(201, media_ref(mid))

    def _media_delete(self, mid):
        self._current_user()
        if mid not in MEDIA:
            raise ApiError(404, "Media not found")
        used = any(p.get("image_media_id") == mid or p.get("audio_media_id") == mid for p in POINTS.values())
        used = used or any(r.get("cover_media_id") == mid or r.get("intro_audio_media_id") == mid for r in ROUTES.values())
        if used:
            raise ApiError(409, "Media is in use")
        public_id = MEDIA[mid].get("public_id")
        del MEDIA[mid]
        MEDIA_FILES.pop(public_id, None)
        self._send_no_content()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    seed()
    server = ThreadingHTTPServer(("0.0.0.0", port), Handler)
    print("Mock AudioGuide API + static server on http://localhost:%d" % port)
    print("Admin: admin@example.com / admin-password-1")
    print("Editor: ed@example.com / editor-password-1")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
