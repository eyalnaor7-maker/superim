"""Pack the Chrome extension into dist/extension.zip using an explicit allowlist."""
import base64
import json
import os
import re
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
BASE_FILES = [
    "manifest.json", "popup.html", "popup.js", "settings.html", "settings.js",
    "branch_service.js", "supabase_config.js", "safe_html.js", "victory_match.js",
    "results_view.js", "popup.css", "cities.js", "sphere.js", "background.js",
    "address.js", "auth.js", "vendor/leaflet/leaflet.js", "vendor/leaflet/leaflet.css", "vendor/leaflet/LICENSE",
]
SECRET_PATTERNS = [
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"AQ\.[0-9A-Za-z_-]{20,}"),
    re.compile(r"supabase_db_password"),
    re.compile(r"sb_secret_"),
]
JWT = re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}")


def check_text(name, text):
    """Raise SystemExit if text holds a secret. Only an anon-role Supabase JWT may ship."""
    if name == "popup.js":
        # Firebase web API keys are public identifiers; the analytics one stays until stage 3 moves stats to Supabase.
        text = re.sub(r"FIREBASE_API_KEY\s*=\s*'[^']*'", "", text)
    for pat in SECRET_PATTERNS:
        if pat.search(text):
            raise SystemExit(f"secret pattern found in {name}")
    for m in JWT.finditer(text):
        payload = m.group(1) + "=" * (-len(m.group(1)) % 4)
        try:
            role = json.loads(base64.urlsafe_b64decode(payload)).get("role")
        except ValueError:
            role = None
        if role != "anon":
            raise SystemExit(f"non-anon token (role={role}) found in {name}")
    if name == "supabase_config.js" and re.search(r"SUPABASE_ANON_KEY = ''", text):
        raise SystemExit("supabase_config.js has no anon key yet")


def _allowlist():
    with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    scripts = [js for cs in manifest.get("content_scripts", []) for js in cs.get("js", [])]
    return BASE_FILES + [s for s in scripts if s not in BASE_FILES]


def build(out_path):
    names = _allowlist()
    missing = [n for n in names if not os.path.isfile(os.path.join(ROOT, n))]
    if missing:
        raise SystemExit(f"missing allowlisted files: {missing}")
    # Scan before writing, so a leak never reaches disk as a zip.
    for name in names:
        with open(os.path.join(ROOT, name), encoding="utf-8", errors="ignore") as f:
            check_text(name, f.read())
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name in names:
            zf.write(os.path.join(ROOT, name), name)
    return names


if __name__ == "__main__":
    out = os.path.join(ROOT, "dist", "extension.zip")
    packed = build(out)
    print(f"packed {len(packed)} files into {out}")
