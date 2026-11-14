import json
import os
import re
import sys
import tempfile
import unittest
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pack_extension  # noqa: E402

REQUIRED = ["manifest.json", "popup.html", "popup.js", "supabase_config.js", "safe_html.js"]
FORBIDDEN_NAMES = ["config.json", "prices.json"]
FORBIDDEN_SUFFIXES = (".py", ".zip", ".md", ".sql")
SECRET_RES = [
    re.compile(r"AIza[0-9A-Za-z_-]{20,}"),
    re.compile(r"AQ\.[0-9A-Za-z_-]{20,}"),
    re.compile(r"supabase_db_password"),
]


class TestPackExtension(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.out = os.path.join(cls._tmp.name, "extension.zip")
        with open(os.path.join(ROOT, "supabase_config.js"), encoding="utf-8") as f:
            if "SUPABASE_ANON_KEY = ''" in f.read():
                cls._tmp.cleanup()
                raise unittest.SkipTest("no anon key in supabase_config.js yet; packaging is blocked by design")
        cls.packed = pack_extension.build(cls.out)
        with open(os.path.join(ROOT, "manifest.json"), encoding="utf-8") as f:
            cls.manifest = json.load(f)
        cls.zip = zipfile.ZipFile(cls.out)
        cls.members = cls.zip.namelist()

    @classmethod
    def tearDownClass(cls):
        cls.zip.close()
        cls._tmp.cleanup()

    def test_contains_required_and_content_script_files(self):
        content_js = [js for cs in self.manifest.get("content_scripts", []) for js in cs.get("js", [])]
        for name in REQUIRED + content_js:
            self.assertIn(name, self.members)

    def test_excludes_secrets_data_and_dev_files(self):
        for name in self.members:
            self.assertNotIn(name, FORBIDDEN_NAMES)
            self.assertFalse(name.endswith(FORBIDDEN_SUFFIXES), name)

    def test_no_secret_patterns_in_packed_text(self):
        for name in self.members:
            pack_extension.check_text(name, self.zip.read(name).decode("utf-8", errors="ignore"))


def _jwt(role):
    import base64
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
    return ".".join([enc({"alg": "HS256", "typ": "JWT"}), enc({"iss": "supabase", "role": role}), "x" * 43])


class TestCheckText(unittest.TestCase):
    def test_anon_token_is_allowed(self):
        pack_extension.check_text("supabase_config.js", f"const SUPABASE_ANON_KEY = '{_jwt('anon')}';")

    def test_service_role_token_is_rejected(self):
        with self.assertRaises(SystemExit):
            pack_extension.check_text("supabase_config.js", f"const SUPABASE_ANON_KEY = '{_jwt('service_role')}';")

    def test_empty_anon_key_is_rejected(self):
        with self.assertRaises(SystemExit):
            pack_extension.check_text("supabase_config.js", "const SUPABASE_ANON_KEY = '';")

    def test_google_key_outside_popup_is_rejected(self):
        with self.assertRaises(SystemExit):
            pack_extension.check_text("settings.js", "const FIREBASE_API_KEY = 'AIza" + "a" * 35 + "';")

    def test_secret_style_supabase_key_is_rejected(self):
        with self.assertRaises(SystemExit):
            pack_extension.check_text("supabase_config.js", "const K = 'sb_secret_abc';")


if __name__ == "__main__":
    unittest.main()
