"""Automated daily XML catalog sync for Israeli Price Transparency portals.

Discovers and downloads the latest PriceFull (.gz / .xml) file for:
  - Shufersal (7290027600007)
  - Rami Levy (7290058140886)
  - Victory (7290696200003)
  - Machsanei HaShuk (7290661400001)

Extracts non-weighted EAN items, normalizes UnitQty/Quantity to base units
(g / ml / unit), and upserts in batches of 500 rows to Supabase REST.
Uses Python 3.11+ standard library only.
"""
from __future__ import annotations

import argparse
import gzip
import html
from html.parser import HTMLParser
import http.cookiejar
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

BATCH_SIZE = 500
REQUEST_TIMEOUT = 60
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)
INVALID_XML_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
EAN_RE = re.compile(r"^\d{7,14}$")

CHAINS = {
    "shufersal": {"code": "7290027600007", "label": "Shufersal"},
    "rami_levy": {"code": "7290058140886", "label": "Rami Levy"},
    "victory": {"code": "7290696200003", "label": "Victory"},
    "machsanei_hashuk": {"code": "7290661400001", "label": "Machsanei HaShuk"},
}

UNIT_ALIASES = {
    "g": ("g", 1.0),
    "gr": ("g", 1.0),
    "gram": ("g", 1.0),
    "grams": ("g", 1.0),
    "ג": ("g", 1.0),
    "ג'": ("g", 1.0),
    "ג׳": ("g", 1.0),
    "גר": ("g", 1.0),
    "גר'": ("g", 1.0),
    "גר׳": ("g", 1.0),
    "גרם": ("g", 1.0),
    "גרמים": ("g", 1.0),
    "kg": ("g", 1000.0),
    "kilogram": ("g", 1000.0),
    "kilograms": ("g", 1000.0),
    "קג": ("g", 1000.0),
    'ק"ג': ("g", 1000.0),
    "קילו": ("g", 1000.0),
    "קילוגרם": ("g", 1000.0),
    "ml": ("ml", 1.0),
    "milliliter": ("ml", 1.0),
    "milliliters": ("ml", 1.0),
    "מל": ("ml", 1.0),
    'מ"ל': ("ml", 1.0),
    "מיליליטר": ("ml", 1.0),
    "l": ("ml", 1000.0),
    "liter": ("ml", 1000.0),
    "liters": ("ml", 1000.0),
    "litre": ("ml", 1000.0),
    "litres": ("ml", 1000.0),
    "ל": ("ml", 1000.0),
    "ל'": ("ml", 1000.0),
    "ל׳": ("ml", 1000.0),
    "ליטר": ("ml", 1000.0),
    "unit": ("unit", 1.0),
    "units": ("unit", 1.0),
    "pcs": ("unit", 1.0),
    "ea": ("unit", 1.0),
    "each": ("unit", 1.0),
    "יח": ("unit", 1.0),
    "יח'": ("unit", 1.0),
    "יח׳": ("unit", 1.0),
    "יחידה": ("unit", 1.0),
    "יחידות": ("unit", 1.0),
    "יחידה/ות": ("unit", 1.0),
}


class LinkExtractor(HTMLParser):
    """Collects href attributes from <a> tags in portal index pages."""

    def __init__(self) -> None:
        super().__init__()
        self.hrefs: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return
        for key, val in attrs:
            if key.lower() == "href" and val:
                self.hrefs.append(html.unescape(val.strip()))


def build_opener() -> urllib.request.OpenerDirector:
    """Create an HTTP opener with cookies and standard headers."""
    jar = http.cookiejar.CookieJar()
    ctx = ssl.create_default_context()
    opener = urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(jar),
        urllib.request.HTTPSHandler(context=ctx),
    )
    opener.addheaders = [
        ("User-Agent", USER_AGENT),
        ("Accept-Language", "he-IL,he;q=0.9,en;q=0.8"),
    ]
    return opener


def http_get(opener: urllib.request.OpenerDirector, url: str) -> bytes:
    req = urllib.request.Request(url, method="GET")
    with opener.open(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read()


def http_post_form(opener: urllib.request.OpenerDirector, url: str, data: dict[str, str]) -> bytes:
    encoded = urllib.parse.urlencode(data).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=encoded,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with opener.open(req, timeout=REQUEST_TIMEOUT) as resp:
        return resp.read()


def extract_links(page_html: str, base_url: str) -> list[str]:
    parser = LinkExtractor()
    parser.feed(page_html)
    links = [urllib.parse.urljoin(base_url, href) for href in parser.hrefs]
    # Also scan raw URLs in inline JS/tables (some portals emit unquoted or JS-embedded links)
    for m in re.findall(r"""(?:https?://[^\s"'<>]+|/?CompetitionsRegulationsFiles/[^\s"'<>]+)""", page_html):
        links.append(urllib.parse.urljoin(base_url, html.unescape(m)))
    return list(dict.fromkeys(links))


def pick_latest_pricefull(candidates: list[str], chain_code: str) -> str | None:
    """Pick the newest PriceFull (.gz / .xml) link for the given chain code."""
    pattern = re.compile(rf"PriceFull{re.escape(chain_code)}[-_](\d+)[-_](\d+)", re.IGNORECASE)
    scored: list[tuple[str, int, str]] = []
    for url in candidates:
        lower = url.lower()
        if f"pricefull{chain_code}" not in lower:
            continue
        if ".gz" not in lower and ".xml" not in lower:
            continue
        m = pattern.search(url)
        ts = m.group(2) if m else "0"
        # Prefer online/main branch codes when timestamps tie
        store_bonus = 1 if (m and m.group(1) in {"000", "001", "039", "413"}) else 0
        scored.append((ts, store_bonus, url))
    if not scored:
        return None
    scored.sort(key=lambda item: (item[0], item[1], item[2]), reverse=True)
    return scored[0][2]


def discover_shufersal(opener: urllib.request.OpenerDirector, chain_code: str) -> bytes:
    urls = [
        "https://prices.shufersal.co.il/FileObject/UpdateCategory?catID=2&storeId=0&page=1",
        "https://prices.shufersal.co.il/?catID=2",
    ]
    for page_url in urls:
        try:
            body = http_get(opener, page_url).decode("utf-8", errors="replace")
            target = pick_latest_pricefull(extract_links(body, page_url), chain_code)
            if target:
                print(f"[shufersal] Downloading {target.split('?')[0]}")
                return http_get(opener, target)
        except Exception as exc:
            print(f"[shufersal] Discovery attempt failed on {page_url}: {exc}")
    raise RuntimeError("Could not discover Shufersal PriceFull file")


def discover_rami_levy(opener: urllib.request.OpenerDirector, chain_code: str) -> bytes:
    login_url = "https://publishedprices.co.il/login/user"
    http_post_form(opener, login_url, {"username": "RamiLevi", "password": ""})
    # Try JSON directory listing first, then HTML fallback
    candidates: list[str] = []
    try:
        raw_dir = http_get(opener, "https://publishedprices.co.il/file/json/dir").decode("utf-8", errors="replace")
        entries = json.loads(raw_dir)
        rows = entries if isinstance(entries, list) else entries.get("aaData", [])
        for row in rows:
            name = row.get("name") if isinstance(row, dict) else (row[0] if isinstance(row, list) and row else "")
            if name:
                candidates.append(f"https://publishedprices.co.il/file/d/{urllib.parse.quote(str(name))}")
    except Exception:
        page_html = http_get(opener, "https://publishedprices.co.il/file").decode("utf-8", errors="replace")
        candidates.extend(extract_links(page_html, "https://publishedprices.co.il/file"))

    target = pick_latest_pricefull(candidates, chain_code)
    if not target:
        raise RuntimeError("Could not discover Rami Levy PriceFull file on publishedprices.co.il")
    print(f"[rami_levy] Downloading {target}")
    return http_get(opener, target)


def discover_matrix_portal(
    opener: urllib.request.OpenerDirector,
    store_key: str,
    chain_code: str,
    portal_urls: list[str],
) -> bytes:
    for page_url in portal_urls:
        try:
            body = http_get(opener, page_url).decode("utf-8", errors="replace")
            target = pick_latest_pricefull(extract_links(body, page_url), chain_code)
            if target:
                print(f"[{store_key}] Downloading {target}")
                return http_get(opener, target)
        except Exception as exc:
            print(f"[{store_key}] Discovery attempt failed on {page_url}: {exc}")
    raise RuntimeError(f"Could not discover {store_key} PriceFull file")


def fetch_chain_payload(store_key: str) -> bytes:
    opener = build_opener()
    chain_code = CHAINS[store_key]["code"]
    if store_key == "shufersal":
        return discover_shufersal(opener, chain_code)
    if store_key == "rami_levy":
        return discover_rami_levy(opener, chain_code)
    if store_key == "victory":
        return discover_matrix_portal(
            opener,
            store_key,
            chain_code,
            [
                f"https://laibcatalog.co.il/NBCompetitionRegulations.aspx?code={chain_code}",
                "https://laibcatalog.co.il/",
                f"https://matrixcatalog.co.il/NBCompetitionRegulations.aspx?code={chain_code}",
                "https://matrixcatalog.co.il/NBCompetitionRegulations.aspx",
            ],
        )
    if store_key == "machsanei_hashuk":
        return discover_matrix_portal(
            opener,
            store_key,
            chain_code,
            [
                f"https://matrixcatalog.co.il/NBCompetitionRegulations.aspx?code={chain_code}",
                "https://matrixcatalog.co.il/NBCompetitionRegulations.aspx",
                f"https://laibcatalog.co.il/NBCompetitionRegulations.aspx?code={chain_code}",
                "https://prices.mck.co.il/",
            ],
        )
    raise ValueError(f"Unknown chain: {store_key}")


def normalize_unit(unit_qty_text: str | None, quantity_text: str | None) -> tuple[float | int | None, str | None]:
    """Normalize Israeli XML UnitQty + Quantity into (unit_qty, unit_type) in g / ml / unit."""
    if not unit_qty_text or not quantity_text:
        return None, None
    unit_key = re.sub(r"\s+", "", unit_qty_text.strip().lower())
    mapping = UNIT_ALIASES.get(unit_key)
    if not mapping:
        return None, None
    try:
        qty = float(quantity_text.strip().replace(",", "."))
    except ValueError:
        return None, None
    if qty <= 0:
        return None, None
    base_type, factor = mapping
    scaled = round(qty * factor, 3)
    if scaled <= 0:
        return None, None
    if scaled.is_integer():
        return int(scaled), base_type
    return scaled, base_type


def _local_tag(tag: str) -> str:
    return tag.rsplit("}", 1)[-1] if "}" in tag else tag


def _item_fields(elem: ET.Element) -> dict[str, str]:
    fields: dict[str, str] = {}
    for child in elem:
        fields[_local_tag(child.tag)] = (child.text or "").strip()
    return fields


def parse_pricefull_payload(raw_bytes: bytes, store_name: str) -> tuple[list[dict], list[dict]]:
    """Decompress (if gzipped) and parse PriceFull XML into products + store_products rows."""
    xml_bytes = gzip.decompress(raw_bytes) if raw_bytes[:2] == b"\x1f\x8b" else raw_bytes
    text = xml_bytes.decode("utf-8", errors="replace")
    clean = INVALID_XML_CHARS_RE.sub("", text)
    root = ET.fromstring(clean.encode("utf-8"))

    products_by_bc: dict[str, dict] = {}
    store_by_bc: dict[str, dict] = {}
    now_iso = datetime.now(timezone.utc).isoformat()

    for elem in root.iter():
        if _local_tag(elem.tag) not in ("Item", "Product"):
            continue
        f = _item_fields(elem)
        weighted = f.get("bIsWeighted", f.get("BisWeighted", ""))
        if weighted != "0":
            continue

        raw_code = f.get("ItemCode", "")
        if not EAN_RE.fullmatch(raw_code):
            continue

        name = f.get("ItemName", "")[:200]
        if not name:
            continue

        try:
            price = round(float(f.get("ItemPrice", "")), 2)
        except ValueError:
            continue
        if price <= 0:
            continue

        unit_qty, unit_type = normalize_unit(
            f.get("UnitQty") or f.get("UnitOfMeasure"),
            f.get("Quantity"),
        )
        barcode = f"P_{raw_code}"

        products_by_bc[barcode] = {
            "barcode": barcode,
            "name": name,
            "unit_qty": unit_qty,
            "unit_type": unit_type,
        }

        internal_code = f.get("ItemId") or f.get("InternalCode") or f.get("StoreCode") or ""
        if not internal_code and store_name == "shufersal":
            internal_code = barcode

        row: dict[str, object] = {
            "barcode": barcode,
            "store_name": store_name,
            "price": price,
            "updated_at": now_iso,
        }
        if internal_code and internal_code != raw_code:
            row["store_code"] = internal_code

        existing = store_by_bc.get(barcode)
        if existing is None or price < float(existing["price"]):
            store_by_bc[barcode] = row

    return list(products_by_bc.values()), list(store_by_bc.values())


def postgrest_upsert(
    supabase_url: str,
    service_role_key: str,
    table_query: str,
    rows: list[dict],
    batch_size: int = BATCH_SIZE,
) -> int:
    """Upsert rows to Supabase PostgREST in uniform batches."""
    if not rows:
        return 0
    url = f"{supabase_url.rstrip('/')}/rest/v1/{table_query}"
    headers = {
        "apikey": service_role_key,
        "Authorization": f"Bearer {service_role_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    sent = 0
    for start in range(0, len(rows), batch_size):
        chunk = rows[start : start + batch_size]
        payload = json.dumps(chunk, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
                if resp.status not in (200, 201, 204):
                    raise RuntimeError(f"Unexpected status {resp.status} from {table_query}")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", errors="replace")[:400]
            raise RuntimeError(f"Supabase error {err.code} on {table_query}: {detail}") from err
        sent += len(chunk)
    return sent


def sync_rows(
    products: list[dict],
    store_rows: list[dict],
    dry_run: bool,
    batch_size: int,
) -> None:
    if dry_run:
        print(
            f"[dry-run] Would upsert {len(products)} products and {len(store_rows)} store_products "
            f"in batches of {batch_size}."
        )
        if products:
            print(f"[dry-run] Sample product: {json.dumps(products[0], ensure_ascii=False)}")
        if store_rows:
            print(f"[dry-run] Sample store_product: {json.dumps(store_rows[0], ensure_ascii=False)}")
        return

    supabase_url = os.environ["SUPABASE_URL"]
    service_key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]

    sent_products = postgrest_upsert(
        supabase_url, service_key, "products?on_conflict=barcode", products, batch_size
    )
    # PostgREST requires every object in a bulk JSON array to share the same keys.
    with_code = [r for r in store_rows if "store_code" in r]
    without_code = [r for r in store_rows if "store_code" not in r]
    sent_store = 0
    sent_store += postgrest_upsert(
        supabase_url, service_key, "store_products?on_conflict=barcode,store_name", with_code, batch_size
    )
    sent_store += postgrest_upsert(
        supabase_url, service_key, "store_products?on_conflict=barcode,store_name", without_code, batch_size
    )
    print(f"Upserted {sent_products} products and {sent_store} store_products rows.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Daily XML catalog sync to Supabase")
    parser.add_argument("--dry-run", action="store_true", help="Parse and print counts without writing to Supabase")
    parser.add_argument(
        "--chains",
        default=",".join(CHAINS.keys()),
        help="Comma-separated list of chains to sync",
    )
    parser.add_argument(
        "--xml-file",
        action="append",
        default=[],
        metavar="CHAIN=PATH",
        help="Optional local .xml/.gz file override for testing (e.g. victory=sample.xml)",
    )
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help="Upsert batch size (default 500)")
    args = parser.parse_args(argv)

    if not args.dry_run and (
        not os.environ.get("SUPABASE_URL") or not os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    ):
        print("Error: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (or pass --dry-run).", file=sys.stderr)
        return 1

    local_files: dict[str, str] = {}
    for spec in args.xml_file:
        if "=" not in spec:
            print(f"Invalid --xml-file '{spec}', expected CHAIN=PATH", file=sys.stderr)
            return 2
        chain, path = spec.split("=", 1)
        local_files[chain.strip()] = path.strip()

    selected = [c.strip() for c in args.chains.split(",") if c.strip()]
    all_products: dict[str, dict] = {}
    all_store_rows: list[dict] = []
    successes = 0

    for store_key in selected:
        if store_key not in CHAINS:
            print(f"Warning: unknown chain '{store_key}', skipping.", file=sys.stderr)
            continue
        try:
            if store_key in local_files:
                with open(local_files[store_key], "rb") as fh:
                    raw = fh.read()
            else:
                raw = fetch_chain_payload(store_key)
            products, store_rows = parse_pricefull_payload(raw, store_key)
            print(f"[{store_key}] Parsed {len(products)} valid EAN products.")
            for p in products:
                prev = all_products.get(p["barcode"])
                if prev is None or (prev.get("unit_qty") is None and p.get("unit_qty") is not None):
                    all_products[p["barcode"]] = p
            all_store_rows.extend(store_rows)
            successes += 1
        except Exception as exc:
            print(f"[{store_key}] Failed: {exc}", file=sys.stderr)

    if successes == 0:
        print("Error: no chain catalogs succeeded.", file=sys.stderr)
        return 1

    sync_rows(list(all_products.values()), all_store_rows, args.dry_run, args.batch_size)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
