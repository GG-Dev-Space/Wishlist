/**
 * Shopify.gs  |  Gem Gallery Wishlist: Shopify product sync
 *
 * Pulls every variant (SKU, title, price, photo, product URL) from the Shopify
 * Admin GraphQL API, writes it to a "Shopify" tab, and serves it to the
 * wishlist page in the same shape the page already reads: { "000-00000": { d, p, img, ... } }.
 *
 * Auth: Dev Dashboard app + client credentials grant (the only path for new
 * custom apps since Jan 1, 2026). Tokens last ~24h and are cached here.
 *
 * SETUP
 * 1. Shopify admin > Settings > Apps > Develop apps > Build apps in Dev Dashboard.
 *    Create an app, scopes: read_products (add read_inventory if you want stock counts).
 *    Release a version and install it on the Gem Gallery store.
 * 2. Apps Script > Project Settings > Script Properties:
 *      SHOPIFY_CLIENT_ID      from Dev Dashboard > Settings
 *      SHOPIFY_CLIENT_SECRET  from Dev Dashboard > Settings
 *    Store domain comes from CONFIG.SHOPIFY_DOMAIN in Code.gs.
 * 3. Run shopifyTest() once from the editor to authorize and confirm the token works.
 * 4. Run shopifySync() once, then installShopifyTrigger() to refresh every 15 min.
 * 5. Redeploy the web app (Deploy > Manage deployments > edit > New version).
 *
 * Code.gs getInventory() already calls mergeShopifyInventory_(). Until the
 * Shopify tab exists, the merge is a no-op and the sheet inventory serves as before.
 */

var SHOPIFY_API_VERSION = '2026-10';      // bump quarterly; any supported version works
var SHOPIFY_TAB = 'Shopify';
var SHOPIFY_PAGE_SIZE = 100;              // keeps each query well under the 1000-point cost cap
var SHOPIFY_SKIP_STATUSES = ['ARCHIVED']; // include DRAFT/UNLISTED so in-store-only pieces still resolve

/**
 * 'enrich'  : existing sheet decides which SKUs are valid; Shopify fills photo, title, price.
 * 'union'   : any SKU in either source is valid. Shopify wins on overlapping fields.
 * 'shopify' : Shopify only. Use once every in-store piece lives in Shopify.
 */
var MERGE_MODE = 'union';

/* ------------------------------------------------------------------ */
/* Public entry points                                                 */
/* ------------------------------------------------------------------ */

function shopifyTest() {
  var res = shopifyGraphQL_('{ shop { name myshopifyDomain } productsCount { count } }', {});
  Logger.log(JSON.stringify(res.data));
}

/** Full pull from Shopify into the Shopify tab. Run on a timer. */
function shopifySync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var rows = [];
    var cursor = null, hasNext = true, pages = 0;
    var q =
      'query($first:Int!,$after:String){' +
      ' productVariants(first:$first, after:$after){' +
      '  pageInfo{ hasNextPage endCursor }' +
      '  nodes{' +
      '   sku price compareAtPrice' +
      '   image{ url }' +
      '   product{ title handle status onlineStoreUrl' +
      '     featuredMedia{ preview{ image{ url } } } }' +
      '  }' +
      ' }' +
      '}';

    while (hasNext && pages < 200) {
      var res = shopifyGraphQL_(q, { first: SHOPIFY_PAGE_SIZE, after: cursor });
      var conn = res.data.productVariants;
      conn.nodes.forEach(function (v) {
        var sku = normalizeSku_(v.sku);
        if (!sku) return;
        if (SHOPIFY_SKIP_STATUSES.indexOf(v.product.status) > -1) return;
        var img = (v.image && v.image.url) ||
          (v.product.featuredMedia && v.product.featuredMedia.preview && v.product.featuredMedia.preview.image &&
           v.product.featuredMedia.preview.image.url) || '';
        rows.push([
          sku,
          v.product.title,
          num_(v.price),
          num_(v.compareAtPrice),
          img,
          v.product.onlineStoreUrl || '',
          v.product.status
        ]);
      });
      hasNext = conn.pageInfo.hasNextPage;
      cursor = conn.pageInfo.endCursor;
      pages++;
      throttle_(res);
    }

    writeShopifyTab_(rows);
    clearInventoryCache();  // Code.gs: next page load gets fresh data
    Logger.log('Shopify sync: ' + rows.length + ' SKUs across ' + pages + ' pages');
  } finally {
    lock.releaseLock();
  }
}

/**
 * Run before retiring the old Inventory sync. Logs every tag number on the
 * Inventory tab that Shopify doesn't have. Zero missing = safe to switch.
 */
function auditShopifyCoverage() {
  var sheetInv = getSheetInventory_();
  var shop = getShopifyInventory_();
  var missing = Object.keys(sheetInv).filter(function (k) { return !shop[k]; });
  Logger.log('Inventory tab: ' + Object.keys(sheetInv).length + ' | Shopify: ' + Object.keys(shop).length +
    ' | On Inventory tab but not in Shopify: ' + missing.length);
  if (missing.length) Logger.log(missing.slice(0, 200).join(', ') + (missing.length > 200 ? ' …' : ''));
}

function installShopifyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'shopifySync') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('shopifySync').timeBased().everyMinutes(15).create();
}

/** Map of SKU -> item, in the wishlist page's format. Fast: reads the tab, cached 10 min. */
function getShopifyInventory_() {
  var cache = CacheService.getScriptCache();
  var hit = getChunked_(cache, 'shopify_inv_v1');
  if (hit) return JSON.parse(hit);

  var sh = shopifySheet_().getSheetByName(SHOPIFY_TAB);
  var out = {};
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues().forEach(function (r) {
      var sku = String(r[0]);
      if (!sku) return;
      var price = Number(r[2]) || 0, compare = Number(r[3]) || 0;
      out[sku] = {
        d: r[1],                              // legacy keys: current page reads d/p/img
        p: price ? fmtPrice_(price) : '',
        img: r[4],
        title: r[1],
        price: price || null,
        compareAt: compare > price ? compare : null,
        url: r[5]
      };
    });
  }
  putChunked_(cache, 'shopify_inv_v1', JSON.stringify(out), 600);
  return out;
}

/** Combine your existing sheet inventory with Shopify per MERGE_MODE. */
function mergeShopifyInventory_(sheetInv) {
  var shop = getShopifyInventory_();
  // Safety net: a failed or empty sync never blanks the form.
  if (!Object.keys(shop).length) return sheetInv || {};
  if (MERGE_MODE === 'shopify') return shop;

  var out = {};
  Object.keys(sheetInv || {}).forEach(function (k) {
    var sku = normalizeSku_(k) || k;
    out[sku] = Object.assign({}, sheetInv[k], shop[sku] ? pickFilled_(shop[sku]) : {});
  });
  if (MERGE_MODE === 'union') {
    Object.keys(shop).forEach(function (sku) { if (!out[sku]) out[sku] = shop[sku]; });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Shopify transport                                                   */
/* ------------------------------------------------------------------ */

function shopifyToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('shopify_token');
  if (cached) return cached;

  var p = PropertiesService.getScriptProperties();
  var resp = UrlFetchApp.fetch('https://' + shopDomain_() + '/admin/oauth/access_token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      client_id: p.getProperty('SHOPIFY_CLIENT_ID'),
      client_secret: p.getProperty('SHOPIFY_CLIENT_SECRET')
    },
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    throw new Error('Shopify token request failed (' + resp.getResponseCode() + '): ' + resp.getContentText().slice(0, 300));
  }
  var body = JSON.parse(resp.getContentText());
  var ttl = Math.min(21600, Math.max(60, (body.expires_in || 86400) - 600)); // CacheService max is 6h
  cache.put('shopify_token', body.access_token, ttl);
  return body.access_token;
}

function shopifyGraphQL_(query, variables, retry) {
  var resp = UrlFetchApp.fetch('https://' + shopDomain_() + '/admin/api/' + SHOPIFY_API_VERSION + '/graphql.json', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'X-Shopify-Access-Token': shopifyToken_() },
    payload: JSON.stringify({ query: query, variables: variables }),
    muteHttpExceptions: true
  });
  var code = resp.getResponseCode();

  if (code === 401 && !retry) {               // token expired early: refresh once
    CacheService.getScriptCache().remove('shopify_token');
    return shopifyGraphQL_(query, variables, true);
  }
  if (code === 429 && (retry || 0) < 3) {
    Utilities.sleep(2000);
    return shopifyGraphQL_(query, variables, (retry || 0) + 1);
  }
  if (code !== 200) throw new Error('Shopify ' + code + ': ' + resp.getContentText().slice(0, 300));

  var body = JSON.parse(resp.getContentText());
  if (body.errors) {
    var throttled = body.errors.some(function (e) { return e.extensions && e.extensions.code === 'THROTTLED'; });
    if (throttled && (retry || 0) < 3) { Utilities.sleep(2000); return shopifyGraphQL_(query, variables, (retry || 0) + 1); }
    throw new Error('Shopify GraphQL: ' + JSON.stringify(body.errors).slice(0, 400));
  }
  return body;
}

function throttle_(res) {
  var t = res.extensions && res.extensions.cost && res.extensions.cost.throttleStatus;
  if (!t) return;
  var need = (res.extensions.cost.requestedQueryCost || 300) + 50;
  if (t.currentlyAvailable < need) {
    Utilities.sleep(Math.ceil((need - t.currentlyAvailable) / t.restoreRate) * 1000);
  }
}

/* ------------------------------------------------------------------ */
/* Sheet + cache helpers                                               */
/* ------------------------------------------------------------------ */

function shopifySheet_() { return ss_(); }  // same spreadsheet as Code.gs

function shopDomain_() {
  return PropertiesService.getScriptProperties().getProperty('SHOPIFY_SHOP') || CONFIG.SHOPIFY_DOMAIN;
}

function writeShopifyTab_(rows) {
  var ss = shopifySheet_();
  var sh = ss.getSheetByName(SHOPIFY_TAB) || ss.insertSheet(SHOPIFY_TAB);
  var head = [['SKU', 'Title', 'Price', 'Compare at', 'Image', 'URL', 'Status']];
  sh.clearContents();
  sh.getRange(1, 1, 1, 7).setValues(head).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, 1).setNumberFormat('@'); // keep SKUs as text
    sh.getRange(2, 1, rows.length, 7).setValues(rows);
  }
  sh.setFrozenRows(1);
  sh.getRange(1, 9).setValue('Last sync: ' + new Date().toLocaleString());
}

// CacheService caps values at 100KB; split large maps across keys.
function putChunked_(cache, key, str, ttl) {
  var size = 90000, n = Math.ceil(str.length / size), map = {};
  for (var i = 0; i < n; i++) map[key + '_' + i] = str.substr(i * size, size);
  map[key + '_n'] = String(n);
  try { cache.putAll(map, ttl); } catch (e) {}
}
function getChunked_(cache, key) {
  var n = cache.get(key + '_n');
  if (!n) return null;
  var keys = [];
  for (var i = 0; i < +n; i++) keys.push(key + '_' + i);
  var got = cache.getAll(keys), parts = [];
  for (var j = 0; j < keys.length; j++) { if (got[keys[j]] == null) return null; parts.push(got[keys[j]]); }
  return parts.join('');
}

/* ------------------------------------------------------------------ */
/* Small utilities                                                     */
/* ------------------------------------------------------------------ */

/** EDGE tag format: 8 digits shown as 000-00000. Anything else is skipped. */
function normalizeSku_(raw) {
  var d = String(raw || '').replace(/\D/g, '');
  return d.length === 8 ? d.slice(0, 3) + '-' + d.slice(3) : '';
}

function num_(v) { var n = parseFloat(v); return isFinite(n) ? n : ''; }

function fmtPrice_(n) {
  var whole = Math.round(n * 100) % 100 === 0;
  var s = (whole ? Math.round(n) : n.toFixed(2)).toString();
  var parts = s.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return '$' + parts.join('.');
}

function pickFilled_(o) {
  var out = {};
  Object.keys(o).forEach(function (k) { if (o[k] !== '' && o[k] != null) out[k] = o[k]; });
  return out;
}
