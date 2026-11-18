/**
 * Ladies Night Wishlist Intake - Backend API
 */

const CONFIG = {
  EVENT_NAME: 'Ladies Night',
  STORE_NAME: 'Gem Gallery',
  MAX_SKUS: 5,
  SHOPIFY_DOMAIN: 'fvspi3-1p.myshopify.com',
  SHEETS: {
    INV: 'Inventory',
    CUST: 'Customers',
    SUB: 'Submissions',
    LIST: 'Entry List'
  }
};

const SKU_RE = /^\d{3}-\d{5}$/;
const ENTRY_ID_COL = 18;  // Submissions column R, after Send Email
const ENTRY_TYPE_COL = 19; // Submissions column S: "Original" or "Add-on to #N"
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'getInventory') {
    const inv = getInventory();
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success', inventory: inv }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (e && e.parameter && e.parameter.action === 'getEntries') {
    let out;
    try { out = { status: 'success', entries: getEntries_(e.parameter) }; }
    catch (err) { out = { status: 'error', message: err.message }; }
    return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput("Ladies Night Wishlist API Active.");
}

/* ------------------------------------------------------------------ */
/* Prize wheel feed                                                    */
/* ------------------------------------------------------------------ */

/**
 * Raffle entries for wheel.html. Read only.
 * - Requires ?key= matching Script Property WHEEL_KEY (run setupWheel once).
 * - Returns entry number + "First L." only. No phone, email or full last name.
 * - ?since=YYYY-MM-DD (default: today, script time zone) or ?since=all.
 * - One slot per guest: duplicate phone numbers keep the earliest entry.
 */
function getEntries_(params) {
  const key = PropertiesService.getScriptProperties().getProperty('WHEEL_KEY');
  if (!key || params.key !== key) throw new Error('Not authorized.');

  const tz = Session.getScriptTimeZone();
  const since = params.since || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  const sub = sheet_(CONFIG.SHEETS.SUB);
  if (sub.getLastRow() < 2) return [];
  const rows = sub.getRange(2, 1, sub.getLastRow() - 1, 6).getValues(); // A..F: no, time, associate, first, last, phone

  const seen = {};
  const out = [];
  rows.forEach(function (r) {
    const no = r[0], when = r[1], first = clean_(r[3]), last = clean_(r[4]);
    const phone = normPhone_(r[5]);
    if (!no || !first) return;
    if (since !== 'all') {
      if (!(when instanceof Date)) return;
      if (Utilities.formatDate(when, tz, 'yyyy-MM-dd') < since) return;
    }
    if ((phone && seen[phone]) || seen['#' + no]) return;   // add-ons share the original's number
    if (phone) seen[phone] = true;
    seen['#' + no] = true;
    out.push({ n: no, name: first + (last ? ' ' + last.charAt(0).toUpperCase() + '.' : '') });
  });
  return out;
}

/** Run once from the editor. Creates the wheel key and logs the wheel link. */
function setupWheel() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('WHEEL_KEY');
  if (!key) { key = Utilities.getUuid().replace(/-/g, '').slice(0, 16); props.setProperty('WHEEL_KEY', key); }
  Logger.log('Wheel link: https://gg-dev-space.github.io/Wishlist/wheel.html?key=' + key);
}

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    const result = submitEntry(contents);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success', entryNo: result.entryNo, merged: !!result.merged,
        added: result.added, skipped: result.skipped || [], total: result.total }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// Sheet inventory merged with Shopify (see Shopify.gs). Cached in chunks:
// the merged map with photo URLs outgrows CacheService's 100KB single-value cap.
function getInventory() {
  const cache = CacheService.getScriptCache();
  const cachedData = getChunked_(cache, 'INV_CACHE');
  if (cachedData) return JSON.parse(cachedData);

  let inv = getSheetInventory_();
  try { inv = mergeShopifyInventory_(inv); } catch (e) { console.error('Shopify merge skipped: ' + e.message); }

  putChunked_(cache, 'INV_CACHE', JSON.stringify(inv), 900);
  return inv;
}

function getSheetInventory_() {

  const sh = sheet_(CONFIG.SHEETS.INV);
  const dataRange = sh.getDataRange();
  const rows = dataRange.getDisplayValues().slice(1);
  const formulas = dataRange.getFormulas().slice(1);
  const inv = {};

  rows.forEach(function (r, i) {
    const sku = normSku_(r[0]);
    const rawVal = (formulas[i] && formulas[i][3]) ? formulas[i][3] : (r[3] || '');
    const imgMatch = rawVal.match(/https?:\/\/[^\s"'<>()=,]+/);
    const imgUrl = imgMatch ? imgMatch[0] : '';

    if (SKU_RE.test(sku)) inv[sku] = { d: r[1], p: r[2], img: imgUrl };
  });

  return inv;
}

/** Run after editing the Inventory tab by hand to publish changes immediately. */
function clearInventoryCache() {
  const cache = CacheService.getScriptCache();
  cache.remove('INV_CACHE_n');
  cache.remove('shopify_inv_v1_n');
}

function submitEntry(p) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const first = clean_(p.first);
    const last = clean_(p.last);
    const email = clean_(p.email).toLowerCase();
    const phone = normPhone_(p.phone);
    const associate = clean_(p.associate);

    if (!first || !last) throw new Error('Enter first and last name.');
    if (phone.length !== 10) throw new Error('Enter a 10-digit phone number.');
    if (!email || !EMAIL_RE.test(email)) throw new Error('Enter a valid email address.');

    let send = null;
    if (p.send) {
      send = { first: clean_(p.send.first), last: clean_(p.send.last), email: clean_(p.send.email).toLowerCase() };
      if (!send.first || !send.last) throw new Error('Enter the first and last name of the person to send this to.');
      if (!send.email || !EMAIL_RE.test(send.email)) throw new Error('Enter a valid email address for the person to send this to.');
    }
    const sendName = send ? send.first + ' ' + send.last : '';
    const sendEmail = send ? send.email : '';

    const inv = getInventory();
    const skus = [];
    (p.skus || []).forEach(function (s) {
      const n = normSku_(s);
      if (n && skus.indexOf(n) === -1) skus.push(n);
    });
    if (!skus.length) throw new Error('Add at least one item.');
    if (skus.length > CONFIG.MAX_SKUS) throw new Error('Up to ' + CONFIG.MAX_SKUS + ' items per entry.');
    const bad = skus.filter(function (s) { return !inv[s]; });
    if (bad.length) throw new Error('Not in inventory: ' + bad.join(', '));

    const status = 'Unmatched';
    const custNo = '';

    const sub = sheet_(CONFIG.SHEETS.SUB);

    // Duplicate guard: the page resends queued entries after a dropped connection.
    // Same entryId means it already landed; return the original entry number.
    const entryId = clean_(p.entryId);
    if (entryId && sub.getLastRow() > 1) {
      const hit = sub.getRange(2, ENTRY_ID_COL, sub.getLastRow() - 1, 1)
        .createTextFinder(entryId).matchEntireCell(true).findNext();
      if (hit) return { entryNo: sub.getRange(hit.getRow(), 1).getValue(), duplicate: true };
    }

    // One raffle entry per guest per night. A later submission from the same
    // mobile number (or email) joins the guest's original entry: same entry
    // number, only new pieces are added, still one slot on the wheel.
    const original = findTodaysEntry_(sub, phone, email);
    const list = sheet_(CONFIG.SHEETS.LIST);
    let entryNo, toAdd = skus, skipped = [], already = [];
    if (original) {
      entryNo = original.entryNo;
      already = listedSkus_(list, entryNo);
      toAdd = skus.filter(function (s) { return already.indexOf(s) === -1; });
      skipped = skus.filter(function (s) { return already.indexOf(s) > -1; });
      if (!toAdd.length) {
        return { entryNo: entryNo, merged: true, added: 0, skipped: skipped, total: already.length };
      }
    } else {
      // Next number = highest existing + 1, so deleting test rows never causes repeats.
      const lastRow = sub.getLastRow();
      entryNo = lastRow > 1
        ? Math.max.apply(null, sub.getRange(2, 1, lastRow - 1, 1).getValues().map(function (r) { return Number(r[0]) || 0; })) + 1
        : 1;
    }
    const now = new Date();
    const fullName = first + ' ' + last;
    const phoneFmt = fmtPhone_(phone);

    const subRow = [entryNo, now, associate, first, last, phoneFmt, email, status, custNo];
    for (let i = 0; i < CONFIG.MAX_SKUS; i++) subRow.push(toAdd[i] || '');
    subRow.push(send ? send.first : '', send ? send.last : '', sendEmail);
    subRow.push(entryId);                                              // column R: Entry ID
    subRow.push(original ? 'Add-on to #' + entryNo : 'Original');     // column S: Entry Type
    sub.getRange(sub.getLastRow() + 1, 1, 1, subRow.length).setValues([subRow]);

    const start = list.getLastRow() + 1;
    const listRows = toAdd.map(function (s) {
      return [entryNo, status, custNo, fullName, phoneFmt, email, s, inv[s].d, inv[s].p, false, sendName, sendEmail];
    });
    list.getRange(start, 1, listRows.length, listRows[0].length).setValues(listRows);
    list.getRange(start, 10, listRows.length, 1).insertCheckboxes();

    return { entryNo: entryNo, merged: !!original, added: toAdd.length, skipped: skipped, total: already.length + toAdd.length };
  } finally {
    lock.releaseLock();
  }
}

/** Earliest submission made today (script time zone) with this mobile number or email. */
function findTodaysEntry_(sub, phone, email) {
  if (sub.getLastRow() < 2) return null;
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const rows = sub.getRange(2, 1, sub.getLastRow() - 1, 7).getValues();   // A..G
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!(r[1] instanceof Date) || Utilities.formatDate(r[1], tz, 'yyyy-MM-dd') !== today) continue;
    if (normPhone_(r[5]) === phone || (email && String(r[6]).trim().toLowerCase() === email)) {
      return { entryNo: r[0], row: i + 2 };
    }
  }
  return null;
}

/** Tag numbers already on an entry's wishlist (Entry List tab). */
function listedSkus_(list, entryNo) {
  if (list.getLastRow() < 2) return [];
  return list.getRange(2, 1, list.getLastRow() - 1, 7).getValues()
    .filter(function (r) { return String(r[0]) === String(entryNo); })
    .map(function (r) { return normSku_(r[6]); });
}

function ss_() {
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing tab: ' + name);
  return sh;
}

function normSku_(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 8 ? d.slice(0, 3) + '-' + d.slice(3) : String(v || '').trim();
}

function normPhone_(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length === 11 && d.charAt(0) === '1' ? d.slice(1) : d;
}

function fmtPhone_(d) {
  return '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6);
}

function clean_(v) {
  return String(v || '').trim().replace(/\s+/g, ' ');
}