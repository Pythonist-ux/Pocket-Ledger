// Run with: node tests/core.test.js   (no dependencies)
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const core = require('../web/core.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
}

/* ---------------- Shared vectors (the Java parser is tested against the same file) ---------------- */
const vectors = fs.readFileSync(path.join(__dirname, 'vectors.tsv'), 'utf8')
  .split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => l.split('\t'));

vectors.forEach(([kind, msg, amount, payee, bank, acct, mode, ref]) => {
  test(kind + ': ' + msg.slice(0, 70), () => {
    const p = core.parseMessage(msg);
    if (kind !== 'debit') { assert.notStrictEqual(p.kind, 'debit', 'must not be tracked, got debit'); return; }
    assert.strictEqual(p.kind, 'debit', 'expected a debit, got ' + p.kind);
    const want = { amount: amount === '' ? null : Number(amount), merchant: payee, bank, acct, mode, refId: ref };
    Object.keys(want).forEach(k => {
      const w = want[k]; if (w === '' || w === null) return;
      const got = p[k] === undefined ? '' : p[k];
      assert.strictEqual(got, w === '-' ? '' : w, k + ': got ' + JSON.stringify(got));
    });
  });
});

/* ---------------- Categories ---------------- */
test('category uses whole words (service != Vi, chocolate != Ola)', () => {
  assert.strictEqual(core.inferCategory('Service Station'), 'Other');
  assert.strictEqual(core.inferCategory('Chocolate Room'), 'Other');
  assert.strictEqual(core.inferCategory('Ola Cabs'), 'Commute & Fuel');
});

/* ---------------- Duplicates, merging and edits ---------------- */
const MIN = 60 * 1000;
function ingest(list, text, ts) { return core.applyParsed(list, core.parseMessage(text, new Date(ts)), ts); }

test('same alert delivered twice -> one entry', () => {
  const list = [], t = Date.parse('2026-11-16T10:00:00');
  const msg = 'Rs. 540.00 debited from HDFC Bank A/c XX4821 to VPA zomato@hdfcbank (UPI Ref 632189445512).';
  assert.strictEqual(ingest(list, msg, t).action, 'added');
  assert.strictEqual(ingest(list, msg, t + 5000).action, 'duplicate');
  assert.strictEqual(list.length, 1);
});

test('EDITING an entry does not let a re-posted alert create a duplicate', () => {
  const list = [], t = Date.parse('2026-11-16T10:00:00');
  const msg = 'Paid Rs 60 to Chai Point via UPI';            // no reference id: worst case for dedupe
  ingest(list, msg, t);
  const e = list[0];                                         // the user now edits everything they can
  e.merchant = 'Tea stall'; e.amount = 65; e.category = 'Other'; e.date = '2026-11-10T08:00'; e.comment = 'fixed';
  assert.strictEqual(ingest(list, msg, t + 4 * MIN).action, 'duplicate');
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].merchant, 'Tea stall', 'user edits must never be overwritten');
});

test('a different payment with a different reference id is kept separate', () => {
  const list = [], t = Date.parse('2026-11-16T10:00:00');
  ingest(list, 'Rs. 540.00 debited from A/c XX4821 to VPA zomato@hdfcbank (UPI Ref 632189445512).', t);
  assert.strictEqual(ingest(list, 'Rs. 540.00 debited from A/c XX4821 to VPA zomato@hdfcbank (UPI Ref 999999999999).', t + MIN).action, 'added');
  assert.strictEqual(list.length, 2);
});

test('bank SMS + UPI-app alert for ONE payment merge into one entry (SMS first)', () => {
  const list = [], t = Date.parse('2026-11-16T10:00:00');
  ingest(list, 'Rs 500.00 debited from HDFC Bank A/c XX1234 on 16-11-26. UPI Ref 632012345678.', t);
  assert.strictEqual(list[0].merchant, 'Unknown');
  const r = ingest(list, 'Google Pay Paid ₹500 to Rahul Kumar', t + 20000);
  assert.strictEqual(r.action, 'merged');
  assert.strictEqual(list.length, 1);
  const e = list[0];
  assert.deepStrictEqual([e.merchant, e.bank, e.acct, e.refId], ['Rahul Kumar', 'HDFC Bank', '1234', '632012345678']);
});

test('bank SMS + UPI-app alert merge (app alert first)', () => {
  const list = [], t = Date.parse('2026-11-16T10:00:00');
  ingest(list, 'Google Pay Paid ₹500 to Rahul Kumar', t);
  ingest(list, 'Rs 500.00 debited from HDFC Bank A/c XX1234 on 16-11-26. UPI Ref 632012345678.', t + 20000);
  assert.strictEqual(list.length, 1);
  const e = list[0];
  assert.deepStrictEqual([e.merchant, e.bank, e.acct, e.refId], ['Rahul Kumar', 'HDFC Bank', '1234', '632012345678']);
  // and a later re-post of either alert is still recognised
  assert.strictEqual(ingest(list, 'Google Pay Paid ₹500 to Rahul Kumar', t + 5 * MIN).action, 'duplicate');
});

test('a manual entry typed just before its alert arrives is enriched, not duplicated', () => {
  const t = Date.parse('2026-11-16T10:00:00');
  const list = [{ id: 'm1', date: '2026-11-16T10:00', merchant: 'Chai', category: 'Food & Dining', amount: 60, mode: 'UPI', source: 'Manual', refId: '', comment: '', capturedAt: t }];
  const r = ingest(list, 'Rs 60.00 debited from SBI A/c XX1234 to VPA chaipoint@ybl UPI Ref 111122223333', t + 2 * MIN);
  assert.strictEqual(r.action, 'merged'); assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].merchant, 'Chai', 'keeps what the user typed');
  assert.strictEqual(list[0].bank, 'SBI');
});

test('same amount much later is a new payment', () => {
  const list = [], t = Date.parse('2026-11-16T10:00:00');
  ingest(list, 'Paid Rs 60 to Chai Point via UPI', t);
  assert.strictEqual(ingest(list, 'Paid Rs 60 to Chai Point via UPI', t + 3 * 60 * MIN).action, 'added');
});

test('credits and noise are never added', () => {
  const list = [], t = Date.now();
  ['Rs 500 credited to your A/c XX1', 'Your OTP for Rs 500 is 1234', 'You have received Rs 250'].forEach(m => assert.notStrictEqual(ingest(list, m, t).action, 'added'));
  assert.strictEqual(list.length, 0);
});

test('queued alerts use the time they arrived, not the time the app was opened', () => {
  const list = [], t = Date.parse('2026-11-15T21:45:00');
  ingest(list, 'Paid Rs 60 to Chai Point via UPI', t);
  assert.strictEqual(list[0].date, '2026-11-15T21:45');
});

/* ---------------- Exports ---------------- */
const SAMPLE = [
  { id: '1', date: '2026-11-16T09:30', merchant: 'Rapido', category: 'Commute & Fuel', amount: 145, mode: 'UPI', bank: 'HDFC Bank', acct: '4821', source: 'Auto', refId: '632109481201', comment: 'Office, "quoted" & <tag>' },
  { id: '2', date: '2026-11-15T20:15', merchant: '=HYPERLINK("x")', category: 'Sports & Recreation', amount: 600.5, mode: 'UPI', source: 'Manual', refId: '', comment: '' },
  { id: '3', date: '2026-10-30T13:10', merchant: 'Swiggy ₹ é 日本', category: 'Food & Dining', amount: 320, mode: 'Credit Card', bank: 'SBI', source: 'Manual', refId: '', comment: 'lunch' }
];

test('csv: BOM, quoting, bank column, formula-injection guard', () => {
  const csv = core.buildCsv(SAMPLE);
  assert.ok(csv.startsWith('﻿"Date & Time","Paid to"'));
  assert.ok(csv.includes('"Bank"') && csv.includes('"HDFC Bank"'));
  assert.ok(csv.includes('"Office, ""quoted"" & <tag>"'));
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"'), 'formula guard');
  assert.strictEqual(csv.split('\r\n').length, 4);
});

test('xlsx: valid zip with expected parts', () => {
  const bytes = core.buildXlsx(SAMPLE);
  assert.strictEqual(bytes[0], 0x50); assert.strictEqual(bytes[1], 0x4b); // "PK"
  const text = Buffer.from(bytes).toString('latin1');
  ['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet3.xml']
    .forEach(n => assert.ok(text.includes(n), 'missing ' + n));
  if (process.env.XLSX_OUT) fs.writeFileSync(process.env.XLSX_OUT, Buffer.from(bytes));
});

test('xlsx: handles an empty list', () => {
  assert.ok(core.buildXlsx([]).length > 500);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
