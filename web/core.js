/*
 * PocketLedger core logic (no DOM access, so it can be unit-tested in Node).
 *  - classifyMessage / parseMessage : decide whether a bank/UPI message is a DEBIT and extract its fields
 *  - applyParsed                    : add a debit, or merge it into the entry it duplicates (SMS + app alert, re-posts)
 *  - buildXlsx / buildCsv           : offline export (no CDN, no libraries)
 */
(function (root) {
  'use strict';

  var DEFAULT_CATEGORIES = [
    'Food & Dining', 'Commute & Fuel', 'Shopping & E-Commerce', 'Groceries',
    'Sports & Recreation', 'Bills & Subscriptions', 'Personal Care', 'Health & Fitness', 'Other'
  ];

  /* ------------------------------------------------------------------ */
  /*  Category inference (merchant name only, whole-word matches)        */
  /* ------------------------------------------------------------------ */
  var CATEGORY_RULES = [
    ['Commute & Fuel', 'rapido|uber|ola|blusmart|namma yatri|petrol|diesel|fuel|shell|hpcl|bpcl|iocl|indian oil|irctc|redbus|ixigo|makemytrip|indigo|metro|fastag|toll|parking|cab|taxi|bike'],
    ['Food & Dining', 'swiggy|zomato|eatsure|restaurant|cafe|coffee|chai|tea|starbucks|mcdonalds?|kfc|burger king|dominos|pizza|dining|food|bakery|biryani|kitchen|dhaba'],
    ['Groceries', 'blinkit|zepto|instamart|bigbasket|jiomart|dmart|dunzo|grocery|groceries|supermarket|kirana|fresh|mart'],
    ['Shopping & E-Commerce', 'amazon|flipkart|myntra|ajio|nykaa|meesho|decathlon|lenskart|zudio|croma|reliance|store|retail|mall|shop'],
    ['Sports & Recreation', 'tsg|badminton|indikarting|karting|timezone|bookmyshow|turf|arena|sports?|game|gaming|cricket|pvr|inox'],
    ['Personal Care', 'pilgrim|salon|barber|grooming|spa|perfume|urban company|beauty'],
    ['Health & Fitness', 'gym|fitness|cult|pharmacy|pharmeasy|netmeds|apollo|medplus|1mg|practo|hospital|clinic|protein|medical|diagnostic'],
    ['Bills & Subscriptions', 'airtel|jio|vodafone|bsnl|act fibernet|electricity|bescom|adani|tata power|tata play|netflix|spotify|hotstar|youtube|prime|google play|apple|recharge|broadband|insurance|emi|rent']
  ].map(function (r) { return [r[0], new RegExp('\\b(?:' + r[1] + ')\\b', 'i')]; });

  function inferCategory(merchant) {
    var text = String(merchant || '');
    for (var i = 0; i < CATEGORY_RULES.length; i++) {
      if (CATEGORY_RULES[i][1].test(text)) return CATEGORY_RULES[i][0];
    }
    return 'Other';
  }

  /* ------------------------------------------------------------------ */
  /*  Debit-only classification                                          */
  /* ------------------------------------------------------------------ */

  // Messages that are never an expense: OTPs, failures, reminders, requests, promos
  var RE_IGNORE = new RegExp([
    '\\b(?:otp|one[- ]time password|verification code|passcode)\\b',
    '\\b(?:failed|declined|unsuccessful|rejected|cancell?ed|insufficient)\\b',
    '\\bnot\\s+(?:been\\s+)?(?:debited|processed|completed)\\b',
    '\\b(?:will be|to be|scheduled to be|is due|are due|due on|due by|pending)\\b',
    '\\b(?:payment|collect|money)\\s+request\\b',
    '\\brequested\\s+(?:you\\s+)?(?:rs|inr|₹|money)',
    '\\bthank you for\\b',
    '\\b(?:offer|discount|coupon|voucher|pre-?approved|apply now|get up to|win up to|flat\\s+(?:rs|₹))\\b|% off'
  ].join('|'), 'i');

  // Money coming IN, whatever else the message says
  var RE_STRONG_CREDIT = /\b(?:refund(?:ed)?|cashback|reversal|reversed|received|deposited|salary)\b|\b(?:paid|sent)\s+you\b|\b(?:credit|cr)\s+alert\b/i;
  // Money going OUT
  var RE_DEBIT = /\b(?:debited|spent|paid|purchased?|withdrawn|withdrawal|charged|deducted|sent)\b|\bpayment\s+of\b|\btransferred\s+to\b|\b(?:txn|transaction)\s+of\b|\bdebit\s+(?:of|by)\b/i;
  var RE_WEAK_CREDIT = /\bcredited\b/i;

  /** @returns {'debit'|'credit'|'ignore'} */
  function classifyMessage(text) {
    text = String(text || '');
    if (!text.trim()) return 'ignore';
    if (RE_IGNORE.test(text)) return 'ignore';
    if (RE_STRONG_CREDIT.test(text)) return 'credit';
    if (RE_DEBIT.test(text)) return 'debit';      // "debited from you ... credited to <payee>" is still a debit
    if (RE_WEAK_CREDIT.test(text)) return 'credit';
    return 'ignore';
  }

  /* ------------------------------------------------------------------ */
  /*  Field extraction                                                   */
  /* ------------------------------------------------------------------ */

  var NUM = '[0-9][0-9,]*(?:\\.[0-9]{1,2})?';

  function toNumber(str) { return parseFloat(str.replace(/,/g, '')); }

  function extractAmount(text) {
    var re = new RegExp('(?:\\brs\\.?|\\binr|₹)\\s*:?\\s*(' + NUM + ')', 'gi');
    var m, best = 0;
    while ((m = re.exec(text)) !== null) {
      var before = text.slice(Math.max(0, m.index - 22), m.index);
      // skip balances / limits: "Avl Bal Rs 12,000", "Available limit INR 5,000"
      if (/(?:bal(?:ance)?|avl|avail(?:able)?|limit|outstanding)[\s:.\-a-z\/]*$/i.test(before)) continue;
      var n = toNumber(m[1]);
      if (n > 0) { best = n; break; }
    }
    if (!best) {   // "500.00 Rs"
      var t = text.match(new RegExp('(' + NUM + ')\\s*(?:rs\\.?|inr|₹)', 'i'));
      if (t) best = toNumber(t[1]);
    }
    if (!best) {   // SBI style: "debited by 500.0"
      var d = text.match(new RegExp('\\b(?:debited|debit|paid|spent|withdrawn|sent|charged|deducted)\\s+(?:by|of|for|with)?\\s*(' + NUM + ')\\b', 'i'));
      if (d) best = toNumber(d[1]);
    }
    return best > 0 ? best : 0;
  }

  function titleCase(s) {
    return s.toLowerCase().replace(/(^|[\s\-&.])([a-z])/g, function (_, a, b) { return a + b.toUpperCase(); });
  }

  function cleanMerchant(raw) {
    var s = String(raw || '').replace(/\s+/g, ' ').replace(/[.\-_ ]+$/g, '').trim();
    s = s.replace(/\s+upi$/i, '');
    if (!s || /^[0-9 ]+$/.test(s)) return '';
    if (s === s.toUpperCase() || s === s.toLowerCase()) s = titleCase(s);
    return s;
  }

  // Where a payee name ends
  var STOP = '(?=\\s+(?:on|using|via|from|through|ref(?:no)?|upi|vpa|a\\/c|ac|acct|account|date|dated|at|for|txn|utr|if|not|is|was|has|successful(?:ly)?|completed|done)\\b|[.;,(\\n\\/:]|$)';
  var NAME = '([A-Za-z0-9][A-Za-z0-9&\'._\\- ]{1,40}?)';

  // Tried in order; the first one that yields a sensible name wins. ('vpa' = group 1 is a UPI handle)
  var PAYEE_PATTERNS = [
    ['\\bUPI\\/[A-Za-z0-9]{2,4}\\/\\d{6,}\\/([^\\/\\n]{2,40}?)\\s*(?:\\/|$)', 'name'],                      // UPI/P2A/123456/Rahul Kumar/
    ['\\b(?:payee|beneficiary|merchant|receiver)(?:\\s+name)?\\s*[:\\-]\\s*' + NAME + STOP, 'name'],         // Payee: Rahul Kumar
    ['\\b(?:paid|sent|transferred)\\s+(?:₹|rs\\.?|inr)?\\s*:?\\s*' + NUM + '\\s+(?:from\\s+.*?\\s+)?to\\s+(?!vpa\\b)' + NAME + STOP, 'name'],  // Paid ₹5 to X / Sent Rs5 From A/c To X
    ['(?:₹|\\brs\\.?|\\binr)\\s*:?\\s*' + NUM + '\\s+(?:sent|paid|transferred)\\s+to\\s+' + NAME + STOP, 'name'],   // Rs 500 sent to X
    ['\\byou\\s+paid\\s+(?!(?:₹|rs|inr)\\b)(?!\\d)' + NAME + '(?=\\s+(?:₹|rs\\.?|inr)\\s*\\d)', 'name'],    // You paid X ₹500
    ['\\btowards\\s+' + NAME + STOP, 'name'],                                                                // ...towards X
    ['(?:^|[;,.]\\s*)' + NAME + '\\s+credited\\b', 'name'],                                                  // ICICI: "; X credited."
    ['\\bvpa\\s+([A-Za-z0-9._\\-]+)@[A-Za-z0-9]+', 'vpa'],                                                   // to VPA x@bank
    ['\\bto\\s+([A-Za-z0-9._\\-]+)@[A-Za-z][A-Za-z0-9]+', 'vpa'],                                            // to x@bank
    ['\\bat\\s+(?!\\d)' + NAME + STOP, 'name'],                                                              // card spend: at X
    ['\\bto\\s+(?!vpa\\b|a\\/c\\b|ac\\b|your\\b|you\\b|the\\b|my\\b)' + NAME + STOP, 'name']                 // generic: to X / trf to X
  ].map(function (p) { return [new RegExp(p[0], 'i'), p[1]]; });

  var BAD_PAYEE = /^(?:a\/c|ac|acct|account|your|you|bank|upi|ref|xx+|x+\d*|ending|card)\b/i;

  function extractMerchant(text) {
    if (/\batm\b/i.test(text) && /\bwithdraw/i.test(text)) return 'ATM Withdrawal';
    for (var i = 0; i < PAYEE_PATTERNS.length; i++) {
      var m = text.match(PAYEE_PATTERNS[i][0]);
      if (!m || !m[1]) continue;
      var c;
      if (PAYEE_PATTERNS[i][1] === 'vpa') {
        var handle = m[1].replace(/[0-9._\-]+/g, ' ').trim();
        c = handle.length > 1 ? titleCase(handle) : '';
      } else {
        c = cleanMerchant(m[1]);
      }
      if (c && !BAD_PAYEE.test(c)) return c;
    }
    return 'Unknown';
  }

  /* ---- bank + account ---- */
  var BANKS = [
    ['HDFC Bank', '\\bhdfc'], ['SBI Card', '\\bsbi\\s*card|\\bsbicrd'], ['SBI', '\\bsbi(?!\\s*life)|\\bstate bank of india'],
    ['ICICI Bank', '\\bicici'], ['Axis Bank', '\\baxis'], ['Kotak Bank', '\\bkotak'],
    ['PNB', '\\bpnb\\b|\\bpunjab national'], ['Bank of Baroda', '\\bbank of baroda|\\bbob(?:sms|card|upi)?\\b|\\bbarodb'],
    ['Canara Bank', '\\bcanara|\\bcnrb'], ['Union Bank', '\\bunion bank|\\bunionb'], ['IDFC First Bank', '\\bidfc'],
    ['Yes Bank', '\\byes\\s*bank'], ['IndusInd Bank', '\\bindusind'], ['Federal Bank', '\\bfederal\\s*bank|\\bfedbnk'],
    ['RBL Bank', '\\brbl'], ['AU Small Finance Bank', '\\bau\\s*small\\s*finance|\\bau\\s*bank'],
    ['Central Bank of India', '\\bcentral bank of india'], ['Bank of Maharashtra', '\\bbank of maharashtra'],
    ['Bank of India', '\\bbank of india|\\bboi\\b'], ['Indian Bank', '\\bindian bank'],
    ['Indian Overseas Bank', '\\bindian overseas|\\biob\\b'], ['UCO Bank', '\\buco\\b'], ['Bandhan Bank', '\\bbandhan'],
    ['South Indian Bank', '\\bsouth indian bank'], ['Karnataka Bank', '\\bkarnataka bank'],
    ['Paytm Payments Bank', '\\bpaytm\\s*payments\\s*bank|\\bppbl'], ['Airtel Payments Bank', '\\bairtel\\s*payments\\s*bank'],
    ['India Post Payments Bank', '\\bippb|\\bindia post'], ['Standard Chartered', '\\bstandard chartered'],
    ['Citibank', '\\bciti\\s*bank'], ['HSBC', '\\bhsbc'], ['DBS Bank', '\\bdbs\\b'], ['J&K Bank', '\\bj\\s*&\\s*k bank|\\bjk bank']
  ].map(function (b) { return [b[0], new RegExp(b[1], 'i')]; });

  var BANK_GENERIC = /(?:^|[\s,;(])((?:[A-Z][A-Za-z&]+\s){1,2}Bank)\b/;
  var BANK_JUNK = /^(?:Your|The|This|Dear|My|Our|Not|Any|Bank|UPI|Mob|Avl)\b/;

  function extractBank(text) {
    // ignore the payee's UPI handle (x@okaxis) and the UPI/P2A/.../NAME/BANK/ trail: they name the OTHER party's bank
    var t = text.replace(/[A-Za-z0-9._\-]+@[A-Za-z0-9]+/g, ' ').replace(/\bUPI\/\S+/gi, ' ');
    for (var i = 0; i < BANKS.length; i++) if (BANKS[i][1].test(t)) return BANKS[i][0];
    var g = t.match(BANK_GENERIC);
    if (g && !BANK_JUNK.test(g[1])) return g[1];
    return '';
  }

  var ACCT_RE = /\b(?:a\/c|ac|acct|account|card)\b[\s:.]*(?:no\b\.?|number)?[\s:.]*(?:ending(?:\s+(?:with|in))?)?[\s:.]*[xX*•]*\s*(\d{3,6})\b/i;

  function extractAcct(text) {
    var m = text.match(ACCT_RE);
    return m ? m[1].slice(-4) : '';
  }

  function extractMode(text) {
    if (/credit\s*card|\bcc\b/i.test(text)) return 'Credit Card';
    if (/debit\s*card|\batm\b/i.test(text)) return 'Debit Card';
    if (/\bupi\b|\bvpa\b|google\s*pay|gpay|phonepe|paytm|bhim/i.test(text)) return 'UPI';
    if (/netbanking|net banking|\bneft\b|\bimps\b|\brtgs\b/i.test(text)) return 'NetBanking';
    if (/\bcard\b/i.test(text)) return 'Card';
    return 'Bank';
  }

  function extractRef(text) {
    var s = text.match(/\bUPI\/[A-Za-z0-9]{2,4}\/(\d{6,})/i);
    if (s) return s[1];
    var re = /\b(?:upi\s*(?:ref(?:erence)?|txn)?\s*(?:no\.?|id)?|ref(?:erence)?\s*(?:no\.?|number|id)?|txn\s*(?:id|no\.?)|transaction\s*id|utr)[\s:.#\-]*([A-Za-z0-9]{6,24})/gi;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (/\d/.test(m[1])) return m[1];
    }
    return '';
  }

  function nowLocal(d) {
    d = d || new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /**
   * Parse a bank / UPI / card message.
   * Returns { kind:'debit', amount, merchant, category, mode, bank, acct, refId, date, raw }
   *      or { kind:'credit'|'ignore', reason }
   */
  function parseMessage(text, now) {
    var raw = String(text || '').replace(/\s+/g, ' ').trim();
    var kind = classifyMessage(raw);
    if (kind === 'credit') return { kind: 'credit', reason: 'Money received, not tracked' };
    if (kind !== 'debit') return { kind: 'ignore', reason: 'Not a spending message' };
    var amount = extractAmount(raw);
    if (!amount) return { kind: 'ignore', reason: 'No amount found' };
    var merchant = extractMerchant(raw);
    return {
      kind: 'debit',
      amount: amount,
      merchant: merchant,
      category: inferCategory(merchant),
      mode: extractMode(raw),
      bank: extractBank(raw),
      acct: extractAcct(raw),
      refId: extractRef(raw),
      date: nowLocal(now),
      raw: raw
    };
  }

  /* ------------------------------------------------------------------ */
  /*  De-duplication + merging                                           */
  /*  Uses only values the user cannot edit (capturedAt, fps, refId), so  */
  /*  editing an entry never lets the same alert slip in a second time.   */
  /* ------------------------------------------------------------------ */

  function fingerprint(raw) {
    var s = String(raw || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return h.toString(16) + ':' + s.length;
  }

  function newId() { return 'exp-' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }

  var SAME_TEXT_MS = 10 * 60 * 1000;   // the very same alert re-posted
  var OTHER_SOURCE_MS = 3 * 60 * 1000; // bank SMS + UPI-app alert for one payment
  var MANUAL_MS = 5 * 60 * 1000;       // you typed it in just before the alert arrived

  /** @returns index of the entry that is the same payment, or -1 */
  function findDuplicate(list, p, ts) {
    var fp = fingerprint(p.raw);
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      var cap = e.capturedAt || Date.parse(String(e.date) + ':00');
      var near = function (ms) { return !isNaN(cap) && Math.abs(ts - cap) < ms; };
      var fps = e.fps || (e.rawNotification ? [fingerprint(e.rawNotification)] : []);
      if (fps.indexOf(fp) >= 0 && near(SAME_TEXT_MS)) return i;
      if (p.refId && e.refId) {
        if (p.refId === e.refId) return i;
        continue; // two different reference ids are two different payments
      }
      if (Number(e.amount) === p.amount && near(e.source === 'Manual' ? MANUAL_MS : OTHER_SOURCE_MS)) return i;
    }
    return -1;
  }

  /** Fill in details the entry is missing. Never overwrites anything that is already set. */
  function mergeInto(e, p) {
    var changed = false;
    if ((!e.merchant || e.merchant === 'Unknown') && p.merchant && p.merchant !== 'Unknown') {
      e.merchant = p.merchant;
      if (!e.category || e.category === 'Other') e.category = p.category;
      changed = true;
    }
    if (!e.bank && p.bank) { e.bank = p.bank; changed = true; }
    if (!e.acct && p.acct) { e.acct = p.acct; changed = true; }
    if (!e.refId && p.refId) { e.refId = p.refId; changed = true; }
    if ((!e.mode || e.mode === 'Bank') && p.mode && p.mode !== 'Bank' && e.mode !== p.mode) { e.mode = p.mode; changed = true; }
    var fp = fingerprint(p.raw);
    e.fps = e.fps || (e.rawNotification ? [fingerprint(e.rawNotification)] : []);
    if (e.fps.indexOf(fp) < 0) e.fps.push(fp);
    return changed;
  }

  /**
   * Add a parsed debit to the list, or merge it into the entry it duplicates.
   * Only debits are ever added; credits / noise return action 'ignored'.
   * @returns {{action:'added'|'merged'|'duplicate'|'ignored', entry:Object|null}}
   */
  function applyParsed(list, p, ts) {
    if (!p || p.kind !== 'debit') return { action: 'ignored', entry: null };
    ts = ts || Date.now();
    var idx = findDuplicate(list, p, ts);
    if (idx >= 0) {
      var changed = mergeInto(list[idx], p);
      return { action: changed ? 'merged' : 'duplicate', entry: list[idx] };
    }
    var entry = {
      id: newId(), date: p.date, merchant: p.merchant, category: p.category, amount: p.amount,
      mode: p.mode, bank: p.bank, acct: p.acct, source: 'Auto', refId: p.refId, comment: '',
      rawNotification: p.raw, capturedAt: ts, fps: [fingerprint(p.raw)]
    };
    list.unshift(entry);
    return { action: 'added', entry: entry };
  }

  /* ------------------------------------------------------------------ */
  /*  Export: CSV                                                        */
  /* ------------------------------------------------------------------ */

  var HEADERS = ['Date & Time', 'Paid to', 'Category', 'Amount (INR)', 'Payment Mode', 'Bank', 'Account (last 4)', 'Source', 'Reference ID', 'Note'];

  function csvCell(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheet formula injection
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function buildCsv(expenses) {
    var lines = [HEADERS.map(csvCell).join(',')];
    expenses.forEach(function (x) {
      lines.push([
        csvCell((x.date || '').replace('T', ' ')), csvCell(x.merchant), csvCell(x.category),
        Number(x.amount) || 0, csvCell(x.mode), csvCell(x.bank), csvCell(x.acct), csvCell(x.source), csvCell(x.refId), csvCell(x.comment)
      ].join(','));
    });
    return '﻿' + lines.join('\r\n'); // BOM so Excel reads UTF-8 (₹, accents) correctly
  }

  /* ------------------------------------------------------------------ */
  /*  Export: minimal .xlsx (OOXML in a STORE-only zip)                  */
  /* ------------------------------------------------------------------ */

  var enc = new TextEncoder();
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zipStore(files) {
    var now = new Date();
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), data = f.data, crc = crc32(data);
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, data);

      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + data.length;
    });
    var cdSize = central.reduce(function (a, b) { return a + b.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
    var all = parts.concat(central, [new Uint8Array(end.buffer)]);
    var total = all.reduce(function (a, b) { return a + b.length; }, 0);
    var out = new Uint8Array(total), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  function xmlEsc(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colName(i) {
    var s = '';
    for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
    return s;
  }

  // "2026-11-16T09:30" -> Excel serial date (local wall-clock time, no timezone shift)
  function excelSerial(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?/.exec(s || '');
    if (!m) return null;
    var ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) - Date.UTC(1899, 11, 30);
    return ms / 86400000;
  }

  // Style ids defined in STYLES_XML below
  var ST = { header: 1, money: 2, datetime: 3, bold: 4, boldMoney: 5, percent: 6 };

  function cellXml(c, ref) {
    if (c == null || c === '') return '';
    if (typeof c !== 'object') c = { v: c };
    var s = c.s ? ' s="' + c.s + '"' : '';
    if (c.f) return '<c r="' + ref + '"' + s + '><f>' + xmlEsc(c.f) + '</f><v>' + (Number(c.v) || 0) + '</v></c>';
    if (typeof c.v === 'number') return '<c r="' + ref + '"' + s + '><v>' + c.v + '</v></c>';
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(c.v) + '</t></is></c>';
  }

  function sheetXml(rows, widths) {
    var cols = widths.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('');
    var data = rows.map(function (row, r) {
      var cells = row.map(function (c, ci) { return cellXml(c, colName(ci) + (r + 1)); }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      '<cols>' + cols + '</cols><sheetData>' + data + '</sheetData></worksheet>';
  }

  var STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="3">' +
    '<numFmt numFmtId="164" formatCode="&quot;₹&quot;#,##0.00"/>' +
    '<numFmt numFmtId="165" formatCode="dd\\-mmm\\-yyyy\\ hh:mm"/>' +
    '<numFmt numFmtId="166" formatCode="0.0%"/></numFmts>' +
    '<fonts count="3">' +
    '<font><sz val="11"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>' +
    '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F2937"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="7">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="2" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
    '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

  function head(labels) { return labels.map(function (l) { return { v: l, s: ST.header }; }); }
  function round2(n) { return Math.round(n * 100) / 100; }

  /** Builds a 3-sheet workbook (Expenses, By Category, By Month). Returns Uint8Array. */
  function buildXlsx(expenses) {
    var list = expenses.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var n = list.length, total = 0;

    var ledger = [head(HEADERS)];
    list.forEach(function (x) {
      var amt = Number(x.amount) || 0; total += amt;
      var ser = excelSerial(x.date);
      ledger.push([
        ser == null ? (x.date || '') : { v: ser, s: ST.datetime },
        x.merchant || '', x.category || '', { v: amt, s: ST.money },
        x.mode || '', x.bank || '', x.acct || '', x.source || '', x.refId || '', x.comment || ''
      ]);
    });
    if (n) ledger.push([{ v: 'Total', s: ST.bold }, '', '', { v: round2(total), f: 'SUM(D2:D' + (n + 1) + ')', s: ST.boldMoney }]);

    var cats = {}, months = {};
    list.forEach(function (x) {
      var a = Number(x.amount) || 0, c = x.category || 'Other', mo = String(x.date || '').slice(0, 7) || 'Unknown';
      (cats[c] = cats[c] || { n: 0, t: 0 }).n++; cats[c].t += a;
      (months[mo] = months[mo] || { n: 0, t: 0 }).n++; months[mo].t += a;
    });
    var catRows = [head(['Category', 'Transactions', 'Total (INR)', 'Share'])];
    Object.keys(cats).sort(function (a, b) { return cats[b].t - cats[a].t; }).forEach(function (c, i) {
      catRows.push([c, cats[c].n, { v: round2(cats[c].t), s: ST.money }, { v: total ? cats[c].t / total : 0, s: ST.percent }]);
    });
    var cn = catRows.length - 1;
    if (cn) catRows.push([{ v: 'Total', s: ST.bold }, { v: n, f: 'SUM(B2:B' + (cn + 1) + ')', s: ST.bold },
      { v: round2(total), f: 'SUM(C2:C' + (cn + 1) + ')', s: ST.boldMoney }]);

    var monthRows = [head(['Month', 'Transactions', 'Total (INR)'])];
    Object.keys(months).sort().forEach(function (mo) {
      monthRows.push([mo, months[mo].n, { v: round2(months[mo].t), s: ST.money }]);
    });

    var sheets = [
      { name: 'Expenses', xml: sheetXml(ledger, [20, 26, 24, 15, 15, 22, 12, 14, 18, 36]) },
      { name: 'By Category', xml: sheetXml(catRows, [26, 14, 16, 10]) },
      { name: 'By Month', xml: sheetXml(monthRows, [14, 14, 16]) }
    ];

    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map(function (s, i) {
        return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
      }).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      sheets.map(function (s, i) { return '<sheet name="' + s.name + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') +
      '</sheets></workbook>';
    var wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map(function (s, i) {
        return '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
      }).join('') +
      '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';

    var files = [
      { name: '[Content_Types].xml', data: enc.encode(ct) },
      { name: '_rels/.rels', data: enc.encode(rels) },
      { name: 'xl/workbook.xml', data: enc.encode(wb) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(wbRels) },
      { name: 'xl/styles.xml', data: enc.encode(STYLES_XML) }
    ];
    sheets.forEach(function (s, i) { files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(s.xml) }); });
    return zipStore(files);
  }

  function toBase64(bytes) {
    if (typeof bytes === 'string') bytes = enc.encode(bytes);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  var api = {
    DEFAULT_CATEGORIES: DEFAULT_CATEGORIES,
    inferCategory: inferCategory,
    classifyMessage: classifyMessage,
    parseMessage: parseMessage,
    applyParsed: applyParsed,
    findDuplicate: findDuplicate,
    mergeInto: mergeInto,
    fingerprint: fingerprint,
    extractBank: extractBank,
    newId: newId,
    BANK_NAMES: BANKS.map(function (b) { return b[0]; }),
    buildCsv: buildCsv,
    buildXlsx: buildXlsx,
    toBase64: toBase64,
    nowLocal: nowLocal
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PLCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
