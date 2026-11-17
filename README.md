# Gem Gallery Wishlist

Event wishlist and raffle intake for Ladies Night. One form for associates and customers: guest details, up to five pieces by tag number, optional "Helped by" associate, optional send-to-someone.

## Structure

| Path | What it is | Where it runs |
| --- | --- | --- |
| `index.html` | The wishlist page | GitHub Pages |
| `apps-script/Code.gs` | Web app API: inventory, submissions, duplicate guard | Google Apps Script (bound to the Wishlist sheet) |
| `apps-script/Shopify.gs` | Shopify product sync and inventory merge | Google Apps Script (same project) |
| `wheel.html` | Raffle prize wheel for the in-store display | GitHub Pages |

**This repo is the source of truth.** Edit here, then paste the Apps Script files into the editor and redeploy. Never commit credentials; Shopify keys live only in Apps Script Script Properties.

## Data flow

```
Shopify ──(every 15 min)──> "Shopify" tab ─┐
Inventory tab (EDGE sync) ─────────────────┴─> getInventory() ──> index.html
index.html ──(POST entry)──> Submissions + Entry List tabs
```

## Backend setup (one time)

1. **Shopify app:** Shopify admin > Settings > Apps > Develop apps > Build apps in Dev Dashboard. Create "Wishlist Sync", Admin API scope `read_products`, release, install on the store. Copy the Client ID and Client secret.
2. **Script Properties** (Apps Script > Project Settings):
   - `SHOPIFY_CLIENT_ID`
   - `SHOPIFY_CLIENT_SECRET`
3. **Sheet:** Submissions tab, cell R1 = `Entry ID`.
4. **Run once, in order:** `shopifyTest` (approve permissions) > `shopifySync` > `auditShopifyCoverage` > `installShopifyTrigger`.
5. **Deploy:** Deploy > Manage deployments > edit current > Version: New version > Deploy. Editing the existing deployment keeps the URL in `index.html` valid.

If `shopifyTest` fails on permissions, add `https://www.googleapis.com/auth/script.external_request` to `oauthScopes` in `appsscript.json`.

## Shipping a change

| Changed | Do this |
| --- | --- |
| `index.html` | Merge to `main`. Pages rebuilds in about a minute. |
| `apps-script/*.gs` | Merge to `main`, paste into the Apps Script editor, deploy a new version. |
| Inventory tab edited by hand | Run `clearInventoryCache` to publish immediately. |

## Per-event settings

Top of `index.html`, `CONFIG`:
- `eventName`, `drawTime`, `maxItems`, `showTotal`

Override the draw time without a code change: `.../?draw=8:00 PM tonight`

Preview with sample pieces, nothing saved: `.../?demo`

## Inventory source

`MERGE_MODE` in `Shopify.gs`:
- `union` (default): a tag is valid if it is on the Inventory tab or in Shopify. Shopify wins on photo, title, price.
- `enrich`: Inventory tab decides validity; Shopify only fills details.
- `shopify`: Shopify only. Switch once `auditShopifyCoverage` reports 0 missing, then the old Inventory sync can be retired.

An empty or failed Shopify sync always falls back to the Inventory tab.

## Event night

- Associates type their name once per device; it is remembered.
- Customers scan a QR code to the page and fill everything in themselves.
- On weak wifi, entries save on the device and sync automatically. Keep the page open until the "waiting to sync" pill clears.

## Raffle wheel

`wheel.html` spins through tonight's entries from the Submissions tab.

- **Setup once:** run `setupWheel` in Apps Script. The log prints the wheel link with its key. Open it once per display; the key is remembered.
- **What it shows:** entry number and first name + last initial only. One slot per guest (duplicate phone numbers keep the earliest entry).
- **Which entries:** today's by default. Add `?since=all` or `?since=2026-11-19` to change.
- **Controls:** Space or the hub to spin, F full screen, R refresh, M sound. New entries load every 20 seconds between spins.
- **Winners:** "Remove and spin again" takes the winner out and spins for the next prize. Drawn winners are remembered on that display; "Reset winners" puts them back.
- **Rehearse:** `wheel.html?demo=150` spins 150 sample names; nothing is read from the sheet.
