#!/usr/bin/env python3
"""
server.py — local server for the room-annotation tool. Standard library only.

  * Serves the static frontend (web/), rendered images, uploads/, and manifest.json
    (an empty manifest when none has been built yet, so the tool boots to import).
  * Drives the in-app PDF import (rendering runs in a preprocess.py subprocess so the
    server stays stdlib-only):
      POST /api/import/upload?path=<rel>  -> store one uploaded PDF under uploads/
      POST /api/import/scan               -> thumbnails + folder/drawing inventory
      POST /api/import/build              -> save the mapping, render images + manifest
      POST /api/import/reset              -> clear uploads/images/manifest/map
  * Proxies the NetBox DCIM API so the token stays server-side (CORS-free):
      GET /api/netbox/rooms?site=<slug>&floor=<slug>   -> rooms on that floor
      GET /api/netbox/locations?site=<slug>&q=<text>   -> location search
      GET /api/netbox/racks?location=<id>              -> racks in a location
      GET /api/netbox/devices?location=<id>            -> unracked devices there
      POST /api/netbox/sync-room                       -> cache racks for one
                                                          room (the selected Location)
  * Persists editor data (atomic write + .bak backup):
      GET/POST /api/annotations     (room polygons)
      GET/POST /api/siteplan        (user building hotspots)
      GET/POST /api/rackplacements  (rack/device positions inside rooms)
      GET/POST /api/pagelayouts     (per-floor sheet arrangement grid)
      GET      /api/rackcache       (synced rack/device inventory, regenerable)

Run:  python3 server.py   (reads config.json for NetBox url/token/port)
"""

import json
import os
import shutil
import ssl
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Serializes import scan/build so two render passes can't clobber images/ + manifest.
IMPORT_LOCK = threading.Lock()


class Config:
    """NetBox connection + server settings from config.json."""
    def __init__(self, path):
        data = json.load(open(path))
        self.netbox_url = data["netbox_url"].rstrip("/")
        self.token = data["netbox_token"]
        self.port = data.get("port", 8765)
        self.ssl_ctx = None if data.get("verify_ssl", True) \
            else ssl._create_unverified_context()


class NetBoxProxy:
    """Talks to the NetBox DCIM API and trims responses for the frontend."""
    def __init__(self, config):
        self.cfg = config
        self._site_ids = {}   # slug -> id cache

    def _get(self, path, params=None):
        url = self.cfg.netbox_url + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={
            "Authorization": "Token " + self.cfg.token,   # NetBox uses Token, not Bearer
            "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30, context=self.cfg.ssl_ctx) as r:
            return json.load(r)

    @staticmethod
    def _trim(loc):
        return {
            "id": loc["id"], "name": loc["name"], "slug": loc["slug"],
            "url": loc.get("display_url") or loc.get("url"),
            "depth": loc.get("_depth", 0),
        }

    def site_id(self, slug):
        if slug not in self._site_ids:
            data = self._get("/api/dcim/sites/", {"slug": slug})
            self._site_ids[slug] = data["results"][0]["id"] if data["count"] else None
        return self._site_ids[slug]

    def rooms(self, site_slug, floor_slug):
        """Rooms = child Locations of the floor Location; falls back to all
        Locations under the site when the floor slug has no Location."""
        sid = self.site_id(site_slug)
        if not sid:
            return {"error": "site not found: " + site_slug, "rooms": []}
        floor = None
        if floor_slug:
            fd = self._get("/api/dcim/locations/", {"site_id": sid, "slug": floor_slug})
            if fd["count"]:
                floor = fd["results"][0]
        if floor:
            kids = self._get("/api/dcim/locations/", {"parent_id": floor["id"], "limit": 1000})
            rooms = [self._trim(x) for x in kids["results"]]
            if rooms:
                return {"floor": self._trim(floor), "rooms": rooms}
            allu = self._get("/api/dcim/locations/", {"site_id": sid, "limit": 1000})
            return {"floor": self._trim(floor), "rooms": [self._trim(x) for x in allu["results"]]}
        allu = self._get("/api/dcim/locations/", {"site_id": sid, "limit": 1000})
        return {"floor": None, "rooms": [self._trim(x) for x in allu["results"]]}

    def locations(self, site_slug, q):
        sid = self.site_id(site_slug)
        if not sid:
            return {"rooms": []}
        params = {"site_id": sid, "limit": 200}
        if q:
            params["q"] = q
        data = self._get("/api/dcim/locations/", params)
        return {"rooms": [self._trim(x) for x in data["results"]]}

    @staticmethod
    def _trim_rack(r):
        return {
            "id": r["id"], "name": r["name"],
            "url": r.get("display_url") or r.get("url"),
            "u_height": r.get("u_height"),
        }

    @staticmethod
    def _trim_device(d):
        # `role` is NetBox 4.x; `device_role` is the 3.x name. The frontend keys the
        # marker glyph off role.slug/name (with a device-name keyword fallback), so a
        # missing role degrades gracefully.
        role = d.get("role") or d.get("device_role") or {}
        dtype = d.get("device_type") or {}
        return {
            "id": d["id"], "name": d.get("name") or d.get("display"),
            "url": d.get("display_url") or d.get("url"),
            "role": {"slug": role.get("slug"), "name": role.get("name")} if role else None,
            "device_type": {"model": dtype.get("model"), "u_height": dtype.get("u_height")} if dtype else None,
        }

    def racks(self, location_id):
        """Racks directly in a Location (the room)."""
        if not location_id:
            return {"racks": []}
        data = self._get("/api/dcim/racks/", {"location_id": location_id, "limit": 1000})
        return {"racks": [self._trim_rack(x) for x in data["results"]]}

    def unracked_devices(self, location_id):
        """Devices assigned to a Location but not mounted in any rack
        (rack_id=null is NetBox's 'no rack' filter)."""
        if not location_id:
            return {"devices": []}
        data = self._get("/api/dcim/devices/",
                         {"location_id": location_id, "rack_id": "null", "limit": 1000})
        return {"devices": [self._trim_device(x) for x in data["results"]]}


class JsonStore:
    """A JSON file persisted atomically, keeping the previous version as .bak."""
    def __init__(self, path, default):
        self.path = path
        self.default = default

    def load(self):
        if os.path.isfile(self.path):
            return json.load(open(self.path))
        return self.default

    def save(self, data):
        tmp = self.path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2)
        if os.path.isfile(self.path):
            os.replace(self.path, self.path + ".bak")
        os.replace(tmp, self.path)


class Handler(BaseHTTPRequestHandler):
    """Routes requests to static files, the NetBox proxy, and the JSON stores.
    Dependencies are injected as class attributes by ToolServer."""
    root = None          # SCRIPT_DIR
    proxy = None         # NetBoxProxy
    annotations = None   # JsonStore
    siteplan = None      # JsonStore
    rackcache = None     # JsonStore (regenerable: synced rack/device inventory)
    placements = None    # JsonStore (user data: rack/device positions in rooms)
    pagelayouts = None   # JsonStore (user data: per-floor sheet arrangement)
    importmap = None     # JsonStore (user data: in-app PDF import mapping)

    CONTENT_TYPES = {
        ".html": "text/html", ".js": "application/javascript",
        ".css": "text/css", ".png": "image/png", ".json": "application/json",
        ".woff2": "font/woff2", ".pdf": "application/pdf",
    }

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _static(self, relpath):
        full = os.path.normpath(os.path.join(self.root, relpath))
        if not full.startswith(self.root) or not os.path.isfile(full):
            return self.send_error(404)
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type",
                         self.CONTENT_TYPES.get(os.path.splitext(full)[1], "application/octet-stream"))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        try:
            if path == "/":
                return self._static("web/index.html")
            if path == "/api/annotations":
                return self._json(self.annotations.load())
            if path == "/api/siteplan":
                return self._json(self.siteplan.load())
            if path == "/api/rackcache":
                return self._json(self.rackcache.load())
            if path == "/api/rackplacements":
                return self._json(self.placements.load())
            if path == "/api/pagelayouts":
                return self._json(self.pagelayouts.load())
            if path == "/api/netbox/rooms":
                return self._json(self.proxy.rooms(qs.get("site", [""])[0], qs.get("floor", [""])[0]))
            if path == "/api/netbox/locations":
                return self._json(self.proxy.locations(qs.get("site", [""])[0], qs.get("q", [""])[0]))
            if path == "/api/netbox/racks":
                return self._json(self.proxy.racks(qs.get("location", [""])[0]))
            if path == "/api/netbox/devices":
                return self._json(self.proxy.unracked_devices(qs.get("location", [""])[0]))
            if path == "/manifest.json":
                # Serve the built manifest, or an empty one so the un-imported tool
                # boots into its "import a facility" state instead of erroring.
                if os.path.isfile(os.path.join(self.root, "manifest.json")):
                    return self._static("manifest.json")
                return self._json({"siteplan": None, "buildings": []})
            if path.startswith(("/web/", "/images/", "/uploads/")):
                # uploaded thumbnails/PDFs carry spaces, so unquote before serving.
                relpath = urllib.parse.unquote(path.lstrip("/"))
                full = os.path.normpath(os.path.join(self.root, relpath))
                subdir = os.path.join(self.root, relpath.split("/")[0]) + os.sep
                if not full.startswith(subdir):
                    return self.send_error(403)
                return self._static(relpath)
            self.send_error(404)
        except urllib.error.HTTPError as e:
            self._json({"error": "netbox %d: %s" % (e.code, e.reason)}, 502)
        except Exception as e:  # noqa
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            # PDF upload carries a raw binary body, so handle it before JSON parsing.
            if path == "/api/import/upload":
                rel = urllib.parse.parse_qs(parsed.query).get("path", [""])[0]
                return self._json(self._save_upload(rel))
            n = int(self.headers.get("Content-Length", 0))
            data = json.loads(self.rfile.read(n) or b"{}")
            if path == "/api/annotations":
                self.annotations.save(data)
                return self._json({"ok": True, "floors": len(data)})
            if path == "/api/siteplan":
                self.siteplan.save(data)
                return self._json({"ok": True, "hotspots": len(data.get("hotspots", []))})
            if path == "/api/rackplacements":
                self.placements.save(data)
                return self._json({"ok": True, "floors": len(data)})
            if path == "/api/pagelayouts":
                self.pagelayouts.save(data)
                return self._json({"ok": True, "floors": len(data)})
            if path == "/api/netbox/sync-room":
                return self._json(self._sync_room(data))
            if path == "/api/import/scan":
                return self._json(self._run_preprocess("scan"))
            if path == "/api/import/build":
                return self._json(self._import_build(data))
            if path == "/api/import/reset":
                return self._json(self._import_reset())
            self.send_error(404)
        except urllib.error.HTTPError as e:
            self._json({"error": "netbox %d: %s" % (e.code, e.reason)}, 502)
        except Exception as e:  # noqa
            self._json({"error": str(e)}, 500)

    # ---- in-app PDF import (rendering runs in a preprocess.py subprocess) ----
    def _safe_join(self, rel):
        """Resolve an upload-relative path inside uploads/, rejecting traversal."""
        base = os.path.normpath(os.path.join(self.root, "uploads"))
        full = os.path.normpath(os.path.join(base, rel))
        if full != base and not full.startswith(base + os.sep):
            raise ValueError("path escapes uploads/")
        return full

    def _save_upload(self, rel):
        """Write one uploaded PDF (raw request body) into uploads/<rel>."""
        if not rel or not rel.lower().endswith(".pdf"):
            raise ValueError("a .pdf path is required")
        dest = self._safe_join(rel)
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(body)
        return {"ok": True, "bytes": len(body)}

    def _run_preprocess(self, mode):
        """Spawn `python3 preprocess.py <mode>` (keeps pypdfium2 out of the server).
        scan returns its stdout inventory; build returns its stderr log."""
        with IMPORT_LOCK:
            proc = subprocess.run(
                [sys.executable, os.path.join(self.root, "preprocess.py"), mode],
                capture_output=True, text=True, cwd=self.root)
        if proc.returncode != 0:
            return {"ok": False, "error": (proc.stderr or proc.stdout).strip()
                    or "preprocess failed"}
        if mode == "scan":
            try:
                return {"ok": True, **json.loads(proc.stdout or "{}")}
            except json.JSONDecodeError:
                return {"ok": False, "error": (proc.stderr or proc.stdout)[:1000]}
        return {"ok": True, "log": proc.stderr.strip()}

    def _import_build(self, data):
        """Persist the wizard's import map, then render images + manifest."""
        self.importmap.save(data)
        return self._run_preprocess("build")

    def _import_reset(self):
        """Clear an import so the user can start over (uploads/images/manifest/map)."""
        for d in ("uploads", "images"):
            shutil.rmtree(os.path.join(self.root, d), ignore_errors=True)
        for f in ("manifest.json", "import-map.json", "import-map.stub.json"):
            try:
                os.remove(os.path.join(self.root, f))
            except FileNotFoundError:
                pass
        return {"ok": True}

    def _sync_room(self, data):
        """Refresh the rack cache for one Location (the selected room): fetch its
        racks + unracked devices and merge them into rackcache.json, leaving every
        other room's cached entry untouched. Powers the per-room Refresh button."""
        loc_id = data.get("location")
        if loc_id is None:
            raise ValueError("location required")
        cache = self.rackcache.load()
        locations = cache.get("locations", {})
        racks = self.proxy.racks(loc_id)["racks"]
        devices = self.proxy.unracked_devices(loc_id)["devices"]
        locations[str(loc_id)] = {"name": data.get("name", ""), "racks": racks, "devices": devices}
        self.rackcache.save({"syncedAt": datetime.now(timezone.utc).isoformat(),
                             "locations": locations})
        return {"ok": True, "racks": len(racks), "devices": len(devices)}


class ToolServer:
    """Wires dependencies into the request handler and serves forever."""
    def __init__(self, script_dir):
        self.script_dir = script_dir
        self.cfg = Config(os.path.join(script_dir, "config.json"))
        Handler.root = script_dir
        Handler.proxy = NetBoxProxy(self.cfg)
        Handler.annotations = JsonStore(os.path.join(script_dir, "annotations.json"), {})
        Handler.siteplan = JsonStore(os.path.join(script_dir, "siteplan.json"), {"hotspots": []})
        Handler.rackcache = JsonStore(os.path.join(script_dir, "rackcache.json"),
                                      {"locations": {}, "syncedAt": None})
        Handler.placements = JsonStore(os.path.join(script_dir, "rackplacements.json"), {})
        Handler.pagelayouts = JsonStore(os.path.join(script_dir, "pagelayouts.json"), {})
        Handler.importmap = JsonStore(os.path.join(script_dir, "import-map.json"),
                                      {"buildings": {}})

    def serve(self):
        os.chdir(self.script_dir)
        httpd = ThreadingHTTPServer(("127.0.0.1", self.cfg.port), Handler)
        print("Facility map tool -> http://127.0.0.1:%d/" % self.cfg.port)
        print("NetBox:", self.cfg.netbox_url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    ToolServer(os.path.dirname(os.path.abspath(__file__))).serve()
