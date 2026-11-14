# Stage 2: Victory Re-platform Fix and Guest Mode Implementation Plan

> **For agentic workers:** do only your task, touch only the files it lists, do not commit or push, do not `git add`. Never call a store API yourself to "try it": the facts below were observed from the sites' own traffic on 2026-11-13 and are the contract. Do not read `config.json`.

**Goal:** Price comparison and cart building work for a visitor who has no account, or is not signed in, at Victory and Rami Levy; Victory works again at all; a missing login at any chain never aborts the comparison.

**Architecture:** Keep the existing pattern: code that talks to a chain runs inside that chain's own tab (`chrome.scripting.executeScript` from `popup.js`, or the chain's content script), so requests are same-site and use whatever session the visitor has. No new files except tests. The modular split of `popup.js` from the spec is deferred until the extension can be exercised in a real Chrome.

**Tech Stack:** Chrome MV3, vanilla JS, Node 24 `node:test`.

**Spec:** `docs/superpowers/specs/2026-11-13-extension-overhaul-design.md`

## Global Constraints

- Hebrew UI strings stay Hebrew. No new dependencies. No build step. Minimal diff: no reformatting or renaming of code you do not need to change.
- A chain adapter must never throw to its caller; on any failure it returns its normal "no results" shape plus a debug reason.
- Never bypass a CAPTCHA or bot check. On HTTP 429 or a response carrying `captchaAction`, stop calling that chain and report it in the debug reason.
- Text from chain responses that reaches `innerHTML` goes through `esc()` (from `safe_html.js`).
- Do not store or log chain tokens.

## Observed API facts (the contract)

### Victory (new platform, replaces Stor.ai retailer 1470 entirely)

- Site `https://www.victoryonline.co.il`. API base `https://api.victoryonline.co.il/api/web`. Every JSON response is `{"status":"success","data":...}`; anything else is failure. CORS allows the site origin. No auth needed for anything below. If the visitor is signed in the site adds `Authorization: Bearer <token>`; we do not need it.
- `GET /branches` -> `data: [{id:"26", name:"אופקים", address:"אפיקים 1, אופקים", isPickup, isDelivery, ...}]`. No `city` field; the city is the text after the last comma of `address`, falling back to `name`.
- `GET /products?id[]=<id>&id[]=<id>&branchId=<branchId>` -> `data: [{id, name, sku, inStock, price, isWeight, sales:[{name, description, saleId}]}]`. `sku` is the barcode.
- Search is Algolia. `POST https://QF3L7C47QU-dsn.algolia.net/1/indexes/*/queries?x-algolia-api-key=0abb07df3782882c383198f99009782d&x-algolia-application-id=QF3L7C47QU` (public search-only key that the site ships to every browser), body
  `{"requests":[{"indexName":"products","query":"<barcode>","hitsPerPage":6,"page":0,"facetFilters":[["inStockBranches:<branchId>"]],"relevancyStrictness":0}]}`.
  Response `results[0].hits[]`: `{id:"7338", name, sku:"7290004131074", price:7.35, inStock, isWeight, sales:[], inStockBranches:["1","3",...], objectID}`. A barcode query returns fuzzy neighbours too: accept only the hit whose `sku` equals the barcode after stripping leading zeros on both sides. Several `requests` may be batched in one POST (one per barcode); keep batches at 20 or fewer.
- Default branch when the visitor chose none: `"55"`.
- Guest cart: `GET /cart/session` -> `data.sessionId`. The site keeps it in `localStorage["cart-session-id"]` (plain string). `GET /cart` with header `Cart-Session-Id: <id>` -> `data.items: [{id, name, price, regularPrice, totalPrice, quantity, inStock, isWeight, featuredImage}]` (the barcode is the path segment after `/product-images/` or `/gs1/` in `featuredImage`). `PUT /cart` with headers `Content-Type: application/json` and `Cart-Session-Id`, body is a bare JSON array `[{"id":"17657","quantity":1}]`; it adds or sets those lines and returns the whole cart in the same shape.
- The old `victory_code` values in our DB are Stor.ai ids and are meaningless now. Match by barcode only (DB keys look like `P_7290004131074`).

### Rami Levy (guest)

- `POST https://www.rami-levy.co.il/api/v2/cart` works with no token: body `{"store":331,"isClub":0,"supplyAt":"<ISO date>","items":{"3025":"1.00"},"meta":null}` -> 200 with priced `items` and `sales`. Signed-in visitors additionally send `ecomtoken` and `authorization: Bearer` headers and `meta.uid`.
- A guest's cart is not kept on the server. It lives in `localStorage["ramilevy"]` (JSON, vuex-persist) at `cart.items`: an array of full catalog product objects, each with an added `amount` (number). `authuser.user` is `null` for a guest. `cart.storeId` may be `null` for a guest; fall back to the branch from extension settings, then `331`.
- Catalog objects come from `POST https://www.rami-levy.co.il/api/catalog` (no token), body `{"q":"<text or barcode>","store":"331","size":N}` -> `data:[{id, barcode, name, price:{price}, ...}]`. Read the existing code for the request form it already uses for id lookups before adding another.

### Machsanei HaShuk

- Still Stor.ai (`/v2/retailers/1107`). It sits behind a Cloudflare bot check that blocked our test browser, so guest behaviour is unverified. Change only the error path (Task 3).

## Review Focus

1. Guest on Victory with an empty cart and no `cart-session-id` yet: building a cart must create the session, store it, and the site must show the items after reload.
2. A barcode whose Algolia result contains only fuzzy neighbours must be reported as "not found", never priced from the wrong product.
3. Signed-in Rami Levy visitor: behaviour unchanged from before (server cart with token).
4. One chain failing (network error, 429, bot check) must leave the other chains' totals on screen.
5. Weighted products (`isWeight`) and quantities above 1 keep their quantity through scan, compare and build.

---

### Task 1: Victory adapter on the new API

**Files:**
- Modify: `popup.js` (`scanVictoryCart`, `agentVictoryAgent`, and the Victory branches inside `compareCarts` only as far as their inputs and outputs change), `victory_injector.js`, `branch_service.js` (`API_ENDPOINTS.victory`, `fetchBranchesGeneric`)
- Create: `victory_match.js`, `tests/victory_match.test.js`; load `victory_match.js` in `popup.html` before `popup.js`

**Interfaces:**
- Produces in `victory_match.js` (plain script plus `module.exports` guard, like `safe_html.js`):
  - `normalizeBarcode(value) -> string`: digits only, `P_` prefix and leading zeros removed.
  - `pickExactHit(hits, barcode) -> hit | null`: the hit whose `normalizeBarcode(sku)` equals `normalizeBarcode(barcode)`.
  - `barcodeFromImage(url) -> string | null`: for the two image path forms above.
  - `cityFromAddress(address, name) -> string`.
- `agentVictoryAgent(items)` keeps the exact return shape its callers already consume (`{ results, debug }`); read the callers first and keep every field they read. Because it is serialized into the page by `executeScript`, it cannot reference outer-scope helpers: pass the helper functions' logic inline or inject `victory_match.js` into the tab first with `files:`.

- [ ] **Step 1:** Write `tests/victory_match.test.js`: `normalizeBarcode('P_0007290004131074') === '7290004131074'`; `pickExactHit([{sku:'7290004135072'},{sku:'7290004131074',id:'7338'}], 'P_7290004131074').id === '7338'`; `pickExactHit([{sku:'7290004135072'}], '7290004131074') === null`; `pickExactHit([], 'x') === null`; `barcodeFromImage('https://d.cloudfront.net/media/product-images/7290113392304/7290113392304.jpg') === '7290113392304'`; `barcodeFromImage('https://d.cloudfront.net/gs1/7290004131074/7290004131074_S1.jpg') === '7290004131074'`; `barcodeFromImage('') === null`; `cityFromAddress('אפיקים 1, אופקים', 'אופקים') === 'אופקים'`; `cityFromAddress('', 'אשקלון מרכז') === 'אשקלון מרכז'`. Run `node --test`; expected: fails, module missing.
- [ ] **Step 2:** Implement `victory_match.js`; run `node --test`; expected: all pass.
- [ ] **Step 3:** `branch_service.js`: Victory endpoint becomes `https://api.victoryonline.co.il/api/web/branches`; unwrap `data`; map to the existing `{id, name, city, address, network}` shape using `cityFromAddress` (load `victory_match.js` in `settings.html` before `branch_service.js`).
- [ ] **Step 4:** `agentVictoryAgent`: delete the Stor.ai token/branch/cart discovery. New flow: branch = the Victory branch from extension settings (find how the current code passes branch ids to agents and reuse it) or `"55"`; batch Algolia queries by barcode; `pickExactHit`; emit one result per item with the new product `id`, live `price`, `inStock`, and the matched name. Items with no barcode or no exact hit are reported as not found. No token means nothing here: remove the `noToken` early return for Victory.
- [ ] **Step 5:** `scanVictoryCart`: read `localStorage["cart-session-id"]`; if absent return an empty cart; else `GET /cart` and map items to the shape the other scanners return, with barcode from `barcodeFromImage`.
- [ ] **Step 6:** `victory_injector.js`: read the saved cart from `chrome.storage.local` exactly as today; resolve each line to a new-platform `id` (use the id saved by the comparison if present, else Algolia by barcode); get or create the session (`localStorage["cart-session-id"]`, else `GET /cart/session` and store it); one `PUT /cart` with the whole array; show the existing status box; reload on success. Remove the "אנא התחבר" failure path.
- [ ] **Step 7:** In `compareCarts`, wherever the Victory result used to carry `noToken`, drop that branch. Verify: `node --check` on the three JS files, `node --test`, and `grep -n "1470\|retailers" popup.js victory_injector.js branch_service.js` shows no Victory Stor.ai remnants.

### Task 2: Rami Levy guest cart

**Files:** Modify `rami_levy_injector.js`; create `tests/rami_guest.test.js` and, if needed for testability, `rami_guest.js` (listed in the manifest content script entry before `rami_levy_injector.js` and in `pack_extension.py`'s allowlist via the manifest).

**Interfaces:**
- `mergeGuestCart(state, products, quantities) -> state`: pure. `state` is the parsed `localStorage["ramilevy"]` object, `products` catalog objects, `quantities` a map id -> number. Returns a new state whose `cart.items` contains each product once with `amount` set (existing lines for the same `id` are replaced, other existing lines kept). Tolerates missing `state.cart` / `cart.items`.

- [ ] **Step 1:** Tests: merging into `{cart:{items:[]}}` adds items with `amount`; an existing line with the same `id` is replaced, not duplicated; an unrelated existing line is kept; `mergeGuestCart({}, [p], {[p.id]: 2}).cart.items[0].amount === 2`; the input object is not mutated. Run, expect failure, implement, expect pass.
- [ ] **Step 2:** In the injector, decide guest vs signed-in by whether a token was found (existing logic). Signed-in: unchanged. Guest: fetch catalog objects for the saved cart's product ids, `mergeGuestCart`, write `localStorage["ramilevy"]`, reload. Replace the guest dead end with this path and keep the status messages in Hebrew.
- [ ] **Step 3:** `node --check rami_levy_injector.js`, `node --test`.

### Task 3: A missing login never aborts the comparison

**Files:** Modify `popup.js` (Machsanei HaShuk agent error path and the result rendering that prints `לא מחובר ל...`).

- [ ] **Step 1:** For Machsanei HaShuk with no token: still attempt the public catalog lookup without the `Authorization` header (same endpoints, same filters). If it returns 401/403 or the bot-check page, return `{results: [], debug: {needsLogin: true}}`.
- [ ] **Step 2:** Rendering: when a chain has `needsLogin`, its column shows DB prices if the DB has them, labelled `מחיר ישן` with the `updated_at` date when available, and a one-line hint `התחברו לאתר <chain> לקבלת מחיר עדכני`. The other chains render normally. No chain's failure may reach the outer `catch` that replaces the whole result with an error.
- [ ] **Step 3:** `node --check popup.js`; `node --test`.

### Task 4: Independent review

A fresh reviewer checks the diff against "Observed API facts" and "Review Focus", runs `node --test` and `python -m unittest tests.test_pack_extension`, and reports defects with file and line.
