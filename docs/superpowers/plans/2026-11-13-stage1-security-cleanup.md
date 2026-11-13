# Stage 1: Security & Cleanup Implementation Plan

> **For agentic workers:** each task below is a self-contained brief. Do only your task, touch only the files it lists, do not commit, do not push, do not read or print `config.json` values.

**Goal:** No secret ships in the extension, the repo or the hosted site; dead code and junk files are gone; the extension still loads and compares.

**Architecture:** Same no-build vanilla-JS MV3 extension. Public Supabase URL + anon key move to a tiny committed `supabase_config.js`; everything secret stays in a git-ignored `config.json` used only by the Python bots. Packaging goes through an allowlist script so nothing else can leak into the store zip.

**Tech Stack:** Chrome MV3, vanilla JS, Python 3 (stdlib only), Node 24 built-in test runner, Supabase Postgres.

**Spec:** `docs/superpowers/specs/2026-11-13-extension-overhaul-design.md`

## Global Constraints

- Hebrew RTL UI text stays as is. No new dependencies. No build step.
- Never print, log or commit values from `config.json`.
- Untracked files are not deleted from disk, only git-ignored. Tracked junk is removed with `git rm`.
- Product substitutes that come from the DB `substitutes` table (read-only, source `live-substitute`) stay for now. Only the Gemini / AI path and the anon write RPC are removed.
- Firestore analytics (`sendAnalyticsEvent`) stays until stage 3.

## Review Focus

1. A product name containing `<img src=x onerror=...>` scanned from a store page must render as text in the popup.
2. The packed zip must not contain `config.json`, `.py`, `prices.json`, or any string matching a JWT / `AIza` / `AQ.` key other than the Supabase anon key.
3. Popup must still compare when `supabase_config.js` values are present and no `config.json` exists.
4. Removing the four AI blocks must not break brace balance or the `live-substitute` branches next to them.
5. `firebase deploy` must publish only `public/`.

---

### Task A: Repo and packaging hygiene

**Files:**
- Modify: `.gitignore`, `firebase.json`, `ai_substitute_bot.py:8`, `generate_substitutes.py:18`
- Move: `dashboard.html` -> `public/dashboard.html` (`git mv`)
- Remove (`git rm`): `index.html`, `404.html`, `shufersal_search.html`, `prices_backup_20260611_222222.json`, `prices_backup_20260612_003351.json`, `test_output.json`, `corona.txt`, `couscous.txt`, `ptitim.txt`, `ptitim_full.txt`
- Create: `pack_extension.py`, `tests/test_pack_extension.py`

- [ ] **Step 1:** `.gitignore` gains: `*.zip`, `*.gz`, `scratch/`, `.omc/`, `prices_backup_*.json`, `dist/`, `apply_db_changes.py`. Keep the existing `config.json` and `.env` lines.
- [ ] **Step 2:** `firebase.json` `hosting.public` becomes `"public"`; `git mv dashboard.html public/dashboard.html`; `git rm` the files listed above.
- [ ] **Step 3:** In the two Python bots replace the hardcoded `GEMINI_API_KEY = "..."` literal with `GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")` (add `import os` if missing). Do not echo the old value anywhere.
- [ ] **Step 4:** Write the failing test `tests/test_pack_extension.py` (stdlib `unittest`): calls `pack_extension.build(out_path)` into a temp dir, then asserts the zip (a) contains `manifest.json`, `popup.html`, `popup.js`, `supabase_config.js`, `safe_html.js` and every file named in manifest `content_scripts[].js`; (b) contains no `config.json`, no `prices.json`, no name ending `.py`, `.zip`, `.md`, `.sql`; (c) no member's text matches `AIza[0-9A-Za-z_-]{20,}` or `AQ\.[0-9A-Za-z_-]{20,}` or the word `supabase_db_password`. Run `python -m unittest tests.test_pack_extension -v`; expected: fails on import.
- [ ] **Step 5:** Implement `pack_extension.py` with `build(out_path: str) -> list[str]` (returns packed names) and a `__main__` that writes `dist/extension.zip`. Allowlist = `manifest.json`, `popup.html`, `popup.js`, `settings.html`, `settings.js`, `branch_service.js`, `supabase_config.js`, `safe_html.js`, plus every `content_scripts[].js` entry read from the manifest. `build` raises `SystemExit` if an allowlisted file is missing or if any packed text matches the secret patterns from Step 4.
- [ ] **Step 6:** Run the test. `supabase_config.js` and `safe_html.js` are created by Task B; if they do not exist yet when you run, create nothing yourself: report the test result as "blocked on Task B files" and stop.

**Report:** files changed, test output, anything surprising.

### Task B: Secrets, Gemini and unsafe HTML out of the extension

**Files:**
- Create: `supabase_config.js`, `safe_html.js`, `tests/safe_html.test.js`
- Modify: `popup.js`, `popup.html:514`, `manifest.json`, `shufersal_injector.js:133`, and any `console.log` in `*_injector.js` that prints a token

**Interfaces produced:**
- `supabase_config.js`: `const SUPABASE_URL = '...'; const SUPABASE_ANON_KEY = '...';` (plain script, loaded before `popup.js`).
- `safe_html.js`: `function esc(value) -> string`, HTML-escapes `& < > " '`; `null`/`undefined` -> `''`. Ends with `if (typeof module !== 'undefined') module.exports = { esc };`.

- [ ] **Step 1:** Generate `supabase_config.js` without displaying the key: run a Python one-liner that reads `supabase_url` and `supabase_anon_key` from `config.json` and writes the two `const` lines. Verify with `node --check supabase_config.js` only.
- [ ] **Step 2:** Write `tests/safe_html.test.js` (`node:test`, `node:assert`): `esc('<img src=x onerror=alert(1)>')` equals `'&lt;img src=x onerror=alert(1)&gt;'`; `esc('a"b\'c&d')` equals `'a&quot;b&#39;c&amp;d'`; `esc(null) === ''`; `esc(5) === '5'`. Run `node --test tests/`; expected: fails, module not found. Then write `safe_html.js`; expected: passes.
- [ ] **Step 3:** `popup.html`: load `supabase_config.js` and `safe_html.js` before `popup.js`.
- [ ] **Step 4:** `popup.js` secrets: delete the `config.json` fetch block (around lines 123-142), the `GEMINI_*` variables and the local `SUPABASE_URL` / `SUPABASE_ANON_KEY` declarations (they now come from `supabase_config.js`). Delete the offline branch that fetches `prices.json` (around line 2049) and any condition that only existed to choose it.
- [ ] **Step 5:** `popup.js` Gemini: delete `findCandidatesFromDB`, `searchStoreForCandidates`, `askGeminiForSubstitute`, `saveSubstituteToSupabase`, and the four `if (!foundSub && ... && GEMINI_API_KEY) { ... }` blocks (around lines 2446, 2501, 2557, 2614). Then delete every helper left with zero callers (check each of `extractWeight`, `findProductByName`, `extractSearchQuery`, `resolveStoreCodeToBarcode`, `searchRamiLevyCatalog`, `agentVictoryDebug`, `debugVictoryConnection` with grep before deleting). Remove `'ai-substitute'` from the source checks but keep `'live-substitute'`.
- [ ] **Step 6:** `popup.js` unsafe HTML: every value that originates from a store page or the DB (product names, store names from data, error text) and is interpolated into a string assigned to `innerHTML` goes through `esc(...)`. Status lines that are plain text use `textContent`. Literal markup written by us stays.
- [ ] **Step 7:** `manifest.json`: remove `*://generativelanguage.googleapis.com/*`; remove the whole `web_accessible_resources` key; bump `version` to `2.1`; add
  `"content_security_policy": {"extension_pages": "default-src 'self'; script-src 'self'; object-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self' https://*.supabase.co https://firestore.googleapis.com https://*.rami-levy.co.il https://*.shufersal.co.il https://*.victoryonline.co.il https://*.victory.co.il https://*.mck.co.il"}`.
  Before removing `web_accessible_resources`, grep that no content script calls `chrome.runtime.getURL`.
- [ ] **Step 8:** Injectors: remove or redact any `console.log` that prints a CSRF token, bearer token or `ecomtoken`.
- [ ] **Step 9:** Verify: `node --check` on `popup.js`, `settings.js`, `branch_service.js`, every `*_injector.js`, `shufersal_main_helper.js`; `python -c "import json;json.load(open('manifest.json',encoding='utf-8'))"`; `node --test tests/`; `grep -ci "gemini\|config\.json\|prices\.json" popup.js` prints `0`.

**Report:** line count of `popup.js` before and after, the verification output, and every place where you were unsure whether a value was store-derived.

### Task C: Database lockdown SQL (written by the lead, run by the owner)

**Files:** Create `sql/2026-11-13_stage1_lockdown.sql`.

- [ ] Drop the three `"Allow write access to authenticated users on ..."` policies; drop `upsert_substitute(text,text,text)`; `REVOKE ALL` on the three tables from `anon, authenticated` then `GRANT SELECT`; set `search_path = public` on `find_candidates` and limit its execute grant to `anon, authenticated`. Idempotent (`IF EXISTS`).

### Task D: Independent review

A fresh reviewer reads `git diff` for the branch against the Review Focus list and the Global Constraints, runs the two test suites and `python pack_extension.py`, and reports defects with file and line.
