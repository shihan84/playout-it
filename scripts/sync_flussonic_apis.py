#!/usr/bin/env python3
"""Fetch, validate and snapshot official Flussonic OpenAPI references.

Requires Python 3.11+ standard library only. Never writes the application's
pinned root openapi.json.
"""
import argparse
import datetime as dt
import hashlib
import json
import pathlib
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
DEST = ROOT / "docs" / "flussonic" / "references"
APIS = {
    "media-server": "https://flussonic.com/doc/api/reference.json",
    "streaming": "https://flussonic.com/doc/api/streaming.json",
    "central": "https://flussonic.com/doc/api/central.json",
    "authorization": "https://flussonic.com/doc/api/authorization.json",
    "config-external": "https://flussonic.com/doc/api/config-external.json",
    # Watcher and layout URLs need to be resolved from the official API list
    # before inclusion; do not guess schema download paths.
}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--strict", action="store_true", help="fail if any reference fails")
    args = parser.parse_args()
    DEST.mkdir(parents=True, exist_ok=True)
    manifest_path = DEST / "manifest.json"
    old = {}
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text(encoding="utf-8")).get("apis", {})
    manifest = {}
    errors = []
    for name, url in APIS.items():
        path = DEST / (name + ".openapi.json")
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "playout-it-openapi-sync/1.0", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=45) as response:
                raw = response.read(15 * 1024 * 1024 + 1)
            if len(raw) > 15 * 1024 * 1024:
                raise ValueError("schema exceeds 15 MiB limit")
            obj = json.loads(raw)
            if not isinstance(obj, dict) or not isinstance(obj.get("paths"), dict) or not (
                str(obj.get("openapi", "")).startswith("3.") or obj.get("swagger") == "2.0"
            ):
                raise ValueError("response is not an OpenAPI/Swagger document")
            normalized = (json.dumps(obj, indent=2, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
            sha = hashlib.sha256(normalized).hexdigest()
            if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != sha:
                path.write_bytes(normalized)
            manifest[name] = {"source": url, "version": obj.get("info", {}).get("version"),
                              "openapi": obj.get("openapi", obj.get("swagger")),
                              "paths": len(obj["paths"]), "sha256": sha,
                              "file": path.name, "status": "verified"}
            print(f"OK {name}: {len(obj['paths'])} paths, version {manifest[name]['version']}")
        except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
            errors.append(name)
            print(f"ERROR {name}: {exc}", file=sys.stderr)
            if path.exists():
                # Existing snapshot is retained; never mark it as freshly verified.
                prior = old.get(name, {})
                manifest[name] = {**prior, "source": url, "file": path.name, "status": "stale"}
            else:
                manifest[name] = {"source": url, "status": "unavailable"}
    payload = {"schema_version": 1, "apis": manifest}
    manifest_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    if errors and args.strict:
        print("Failed references: " + ", ".join(errors), file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
