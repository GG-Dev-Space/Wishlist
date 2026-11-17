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
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'getInventory') {
    const inv = getInventory();
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success', inventory: inv }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput("Ladies Night Wishlist API Active.");
}

function doPost(e) {
  try {
    const contents = JSON.parse(e.postData.contents);
    const result = submitEntry(contents);
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success', entryNo: result.entryNo }))
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

    const entryNo = sub.getLastRow();
    const now = new Date();
    const fullName = first + ' ' + last;
    const phoneFmt = fmtPhone_(phone);

    const subRow = [entryNo, now, associate, first, last, phoneFmt, email, status, custNo];
    for (let i = 0; i < CONFIG.MAX_SKUS; i++) subRow.push(skus[i] || '');
    subRow.push(send ? send.first : '', send ? send.last : '', sendEmail);
    subRow.push(entryId);  // column R: Entry ID
    sub.getRange(sub.getLastRow() + 1, 1, 1, subRow.length).setValues([subRow]);

    const list = sheet_(CONFIG.SHEETS.LIST);
    const start = list.getLastRow() + 1;
    const listRows = skus.map(function (s) {
      return [entryNo, status, custNo, fullName, phoneFmt, email, s, inv[s].d, inv[s].p, false, sendName, sendEmail];
    });
    list.getRange(start, 1, listRows.length, listRows[0].length).setValues(listRows);
    list.getRange(start, 10, listRows.length, 1).insertCheckboxes();

    return { entryNo: entryNo };
  } finally {
    lock.releaseLock();
  }
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