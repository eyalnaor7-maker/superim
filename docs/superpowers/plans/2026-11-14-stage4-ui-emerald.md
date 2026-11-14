# Stage 4: "Emerald" UI for Popup and Settings Implementation Plan

> **For agentic workers:** do only your task, touch only the files it lists, do not commit, push or `git add`. Do not read `config.json`. Do not call any store API.

**Goal:** The popup and the settings page look like direction 1 ("אמרלד") of `docs/mockups/popup-directions.html`, with no change to what the extension does.

**Architecture:** Presentation only. Popup CSS moves from the inline `<style>` in `popup.html` to `popup.css`. The store-summary markup that `compareCarts` builds inline (the `live-header` block and the `orderedStores.forEach` loop, about `popup.js:1984-2041`) moves to one pure function in a new `results_view.js` so it can be unit-tested and previewed outside Chrome. Everything else in `popup.js` stays where it is.

**Tech Stack:** Chrome MV3, vanilla JS and CSS, no build step, Node 24 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-extension-overhaul-design.md` (section on UI) and the chosen mockup `docs/mockups/popup-directions.html` (column 1, class `.t1`). The mockup's CSS values are the design tokens: copy them.

## Global Constraints

- Hebrew RTL. Hebrew strings stay Hebrew. No emoji in the UI: use the two inline SVG icons from the mockup.
- No new dependencies, no web fonts, no external URLs (manifest CSP is `default-src 'self'`; `style-src 'self' 'unsafe-inline'`). Font stack: `system-ui, 'Segoe UI', Arial, sans-serif`.
- Every element id that `popup.js` or `settings.js` reads must still exist with the same meaning: `settingsBtn`, `userSettingsBtn`, `storePanel`, `noteShufersal`, `toggleShufersal`, `noteRamiLevy`, `toggleRamiLevy`, `noteVictory`, `toggleVictory`, `noteMCK`, `toggleMCK`, `compareBtn`, `status`, `result`, `detailsToggle`, `toggleArrow`, `detailsContent`, `switchToRamiLevy`, `switchToVictory`, `switchToMCK`, `switchToShufersal`, and in settings `city-input`, `shufersal-branch`, `rami-levy-branch`, `victory-branch`, `mck-branch`, `save-btn`. Grep both scripts for `getElementById`/`querySelector` before deleting any markup.
- Any text that reaches `innerHTML` and comes from a store or the cart goes through `esc()` (`safe_html.js`). `store.info` is already escaped or a literal: keep passing it as is.
- Popup width 360px. Colours only from the `.t1` token set, defined once as CSS custom properties on `:root`.
- Do not add controls that do nothing (no Google sign-in button, no "delete my data": those arrive with stage 3).
- Minimal diff in `popup.js` outside the block being replaced.

## Review Focus

1. The active store is the cheapest: the hero must not show a saving of ₪0.00; it says the current cart is already the cheapest and shows no build button for the active store.
2. No store has data: hero shows a neutral "no prices found" state, nothing throws.
3. A store with `hasData: false` shows its `debugInfo` (or `ממתין לנתונים...`) and no price; Victory and Machsanei HaShuk keep their "בחר ..." button in that state as today.
4. A store name containing `<` or `&` is rendered as text.
5. Each `switchTo*` button id appears at most once in the output, for every ordering of the stores.

---

### Task 1: `results_view.js` and its test

**Files:** Create `results_view.js`, `tests/results_view.test.js`. Modify `popup.js` (replace the block described above with one call), `popup.html` (script tag before `popup.js`), `pack_extension.py` (`BASE_FILES` gains `results_view.js` and `popup.css`), `tests/test_pack_extension.py` only if it lists files.

**Interface (plain script plus `module.exports` guard, same pattern as `safe_html.js`; in Node it `require`s `./safe_html.js` for `esc`):**

`renderStoreSummary({ orderedStores, sortable, activeStore, itemCount }) -> string`

- `orderedStores` / `sortable`: the arrays `compareCarts` already builds; each store is `{ key, name, total, info, hasData, debugInfo }`, `key` one of `shufersal | ramiLevy | victory | machsaneiHashuk`.
- Output, top to bottom, using the mockup's class names (`hero`, `lbl`, `big`, `pill`, `win`, `row`, `av`, `grow`, `sub`, `tot`, `cta`, `list`, `end`, `diff`, `warn`):
  - Hero. If the cheapest store is not the active one and the saving against the active store is above 0.01: label `החיסכון שלך בעגלה הזו`, the saving as `₪37.80`, pill `<percent>% פחות מ<active store name>` (percent rounded to a whole number; omit the pill when the active store has no data). If the active store is the cheapest: label `העגלה שלך כבר הכי זולה`, big text is that store's total. If `sortable` is empty: label `לא נמצאו מחירים`, no number.
  - Winner card for `sortable[0]`: avatar, name, `info`, total, and one `cta` button `לבנות את העגלה ב<name>` carrying that store's `switchTo*` id. No button when the winner is the active store.
  - One list row per remaining store: avatar, name, `info` (or `debugInfo` in class `warn` when `hasData` is false), total and `+₪x.xx` difference against the cheapest (omitted when no data), and a small secondary button with that store's `switchTo*` id and the same labels the current code uses (`עבור ל...` / `בחר ...`); the active store's row shows `העגלה הנוכחית שלך` and no button.
  - Avatar: first Hebrew letter of the name on a per-store colour: shufersal `#e11d48`, ramiLevy `#2563eb`, victory `#f97316`, machsaneiHashuk `#7c3aed`.
- Prices formatted with `toFixed(2)`.

- [ ] **Step 1:** Write `tests/results_view.test.js` with a helper `stores()` returning four sample stores (ramiLevy 412.3, victory 428.9, shufersal 450.1 active, machsaneiHashuk `hasData:false, debugInfo:'מחירים לא נמצאו'`). Assertions: output contains `₪37.80` and `8% פחות משופרסל`; contains exactly one `id="switchToRamiLevy"` and it is inside the element with class `win`; contains `+₪16.60`; contains `מחירים לא נמצאו` and no price for machsaneiHashuk; no `id="switchToShufersal"` when shufersal is active. Second case, active store cheapest (activeStore `ramiLevy`): contains `העגלה שלך כבר הכי זולה`, does not contain `₪0.00`, no `id="switchToRamiLevy"`. Third case, `sortable: []`: contains `לא נמצאו מחירים`, does not throw. Fourth: a store named `A<b>&` appears as `A&lt;b&gt;&amp;`. Run `node --test`; expected: fails, module missing.
- [ ] **Step 2:** Implement `results_view.js`; `node --test` passes.
- [ ] **Step 3:** In `popup.js` replace the `live-header` template and the whole `orderedStores.forEach` block with `let html = renderStoreSummary({ orderedStores, sortable, activeStore, itemCount: rawCartItems.length });`. Leave the details section and all `switchTo*` click handlers untouched. `node --check popup.js`.

### Task 2: Popup shell and stylesheet

**Files:** Create `popup.css`. Modify `popup.html` (replace the `<style>` block with `<link rel="stylesheet" href="popup.css">`, restructure the static markup). Modify `popup.js` only if a start-screen text needs setting (see step 2).

- [ ] **Step 1:** `popup.css`: tokens from `.t1`; the mockup's component classes; restyle the classes the details section still emits (`details-section`, `details-toggle`, `details-content`, `section-label`, `product-list`, the product row classes, `out-section`, `out-item*`, `missing-section`, `missing-item`: grep `popup.js` for the full list) so they fit the new look; drop every rule whose class no longer appears in `popup.html`, `popup.js` or `results_view.js`.
- [ ] **Step 2:** Start screen in `popup.html`: emerald hero with brand (cart icon, `השוואת עגלות`) and the settings icon button (`userSettingsBtn`); under it a card holding `compareBtn` (gold CTA, text `להשוות מחירים`) and the line `המחירים נבדקים עכשיו מול אתרי הרשתות`. The hero headline: read how `popup.js` already detects the active site (`detectActiveStore`) and show `זיהינו עגלה ב<store>`, or `פתחו את העגלה באתר של אחת הרשתות` when the tab is not a supported site; add an element for it and set it where the existing init code runs. Do not scan the cart on open.
- [ ] **Step 3:** Store toggles: keep the four checkboxes and their note elements, presented as a compact row of chips under the card with the label `משווים מול`. Keep whatever `settingsBtn` does today working.
- [ ] **Step 4:** `status` is a single calm line under the card (secondary colour, small pulsing dot while it has text). When results render, the start hero and card are replaced by the results view (hide them from the place where `resultDiv.innerHTML` is set; restore on a new comparison).
- [ ] **Step 5:** Create `docs/mockups/popup-preview.html`: a dev-only page that links `../../popup.css`, loads `../../safe_html.js` and `../../results_view.js`, and renders three 360px frames side by side with the sample data from the test (saving case, active-is-cheapest case, no-data case). It is not packed.
- [ ] **Step 6:** `node --check popup.js`, `node --test`, `python -m unittest tests.test_pack_extension`.

### Task 3: Settings page

**Files:** Modify `settings.html` (markup and its `<style>`), `settings.js` (`populateDropdowns` only).

- [ ] **Step 1:** Same tokens and look: emerald header band with title `הגדרות`, one card `איפה קונים` with the city input and the four branch selects as rows (avatar, chain name, select), gold `save-btn` with text `לשמור`. Remove emoji. Page max width 560px, centred.
- [ ] **Step 2:** In `populateDropdowns`, when a city filter leaves a chain with at least one branch and that chain has no saved or current selection, preselect the first branch. Do not override an existing choice.
- [ ] **Step 3:** `node --check settings.js`, `node --test`.

### Task 4: Independent review

A fresh reviewer checks the diff against Global Constraints and Review Focus, confirms no id from the list is missing (`grep`), runs `node --test` and `python -m unittest tests.test_pack_extension`, and reports defects with file and line.
