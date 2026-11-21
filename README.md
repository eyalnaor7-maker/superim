# Supermarket Cart Compare

A Chrome extension I built to answer a question I kept asking while shopping online: would this exact cart be cheaper at another supermarket?

You fill a cart on one of four Israeli chains (Shufersal, Rami Levy, Victory or Machsanei HaShuk), click the extension, and about ten seconds later you see what the same cart costs at the other three. The totals include delivery fees and multi-buy deals. If another chain comes out cheaper, one more click builds the cart there for you.

<p>
  <img src="docs/screenshots/comparison.png" alt="Comparison result: the same 6-product cart priced at four chains, cheapest first" width="300">
  <img src="docs/screenshots/dashboard.png" alt="Analytics dashboard with demo data: comparisons per day, savings found, cheapest chain" width="520">
</p>

On the left is a real comparison. On the right is the usage dashboard, shown here with demo data ([open the demo](https://supermarket-compare-81306.web.app/dashboard.html?demo=1)).

## How it works

The extension reads the cart from the site you're on. Each chain stores it differently: one keeps it in page state, another in local storage, another behind an API. So there's a small reader for each.

Then it has to find the same products at the other chains. I built a product database from the price files that Israeli chains are required by law to publish. It holds about 5,800 products per chain, and products are matched by barcode. The Python scripts that built it are in [`data_pipeline/`](data_pipeline).

Database prices go stale, so the extension also asks all four sites for live prices at the same time, each in a hidden tab, using the site's own search.

Getting a fair total took most of the work:
- A deal like "2 for ₪115" is applied line by line, the same way the chain's checkout does it.
- The delivery fee depends on your city and street and on the delivery day, so it's looked up for your address.
- A chain that's missing half your cart would look cheap. To avoid that, savings are counted only on products found at both chains.

When you choose a chain, the extension empties the cart you already have there and fills it with the matched products.

## Data and the dashboard

Everything lives in PostgreSQL on Supabase: products, prices per chain, substitutes, anonymous usage events and feedback. The SQL migrations are in [`sql/`](sql).

The dashboard ([`public/dashboard.html`](public/dashboard.html)) gets its data from one SQL function and draws it with Chart.js. It shows:
- comparisons per day
- how much money the comparisons found
- which chain came out cheapest
- how often people moved their cart to another chain
- the top cities and the most compared products

I kept the logging small on purpose. It records totals and product names, never a whole cart and never a user id. A city only appears once it has at least 3 comparisons, so nobody can be picked out.

## Finding substitutes with AI

Sometimes a product simply isn't sold at a chain. There's a switch in the extension that asks Google's Gemini for a replacement. I didn't want the model inventing products, so the work is split:

1. SQL makes a shortlist of similar products by name similarity (`pg_trgm`). Only products sold at the chain where the original is missing go on the list.
2. Gemini picks up to two products from that list.
3. The server throws away any answer that isn't on the list, then saves the choice. Every later comparison uses it automatically.

This runs in a Supabase Edge Function ([`supabase/functions/ai-substitutes`](supabase/functions/ai-substitutes/index.ts)). You need an account to use it. Each account gets one search a day, and the database enforces the limit with a primary key. The extension shows how much of the daily limit is left.

## Security and testing

- Every table has Row Level Security. Price tables are read-only for the public key, and each user can read only their own rows.
- The extension ships only Supabase's public key. [`pack_extension.py`](pack_extension.py) builds the package from a fixed list of files, and it stops if it finds anything that looks like a secret key.
- Accounts are email and password through Supabase Auth. Sign-in attempts are rate limited, and users can delete their own account.
- There are 38 automated tests covering price math, deals, delivery fees and cart parsing. I also test every change in a real Chrome with the extension loaded.

## Built with

- **Extension:** JavaScript (Chrome Manifest V3), HTML and CSS, with a Hebrew right-to-left interface and a Leaflet map
- **Backend:** Supabase (PostgreSQL, Auth, Edge Functions in TypeScript)
- **Data:** Python for the XML price feeds, SQL for aggregation and similarity search
- **AI:** Google Gemini
- **Dashboard:** Chart.js, hosted on Firebase
- **Development:** I wrote the code with an AI coding assistant (Claude Code) and checked each change in Chrome DevTools

## Where things are

- **The comparison window:** `popup.js` and `popup.html`. This covers reading the cart, the live price lookups and the totals.
- **The results screen:** `results_view.js`, written as pure functions so it can be tested.
- **Building the cart on each site:** the `*_injector.js` files.
- **Chain-specific rules:** `victory_match.js` and `rami_guest.js`, for prices, deals and delivery fees.
- **Settings:** `settings.html` and `settings.js`.
- **Project status notes:** [`docs/HANDOFF.md`](docs/HANDOFF.md), in Hebrew.

## Running it

```bash
node --test                 # run the tests
python pack_extension.py    # build dist/extension.zip
```

1. Unzip `dist/extension.zip`.
2. In `chrome://extensions`, choose "Load unpacked" and pick the unzipped folder.
3. Open a cart on one of the four chains and click the extension icon.
