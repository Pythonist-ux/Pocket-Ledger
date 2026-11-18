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

/* ---------------- DEBITS must be tracked ---------------- */
const DEBITS = [
  ['Rs. 540.00 debited from A/c XX4821 on 16-11-26 to VPA zomato@hdfcbank (UPI Ref 632189445512).',
    { amount: 540, merchant: 'Zomato', category: 'Food & Dining', mode: 'UPI', refId: '632189445512' }],
  ['Paid ₹165.00 to RAPIDO BIKE TAXI using Google Pay on 16-11-2026. UPI Ref: 632110982341.',
    { amount: 165, merchant: 'Rapido Bike Taxi', category: 'Commute & Fuel', mode: 'UPI', refId: '632110982341' }],
  ['INR 850.00 spent on HDFC Bank Credit Card XX9012 at TSG SPORTS ARENA on 16-Nov-2026.',
    { amount: 850, merchant: 'Tsg Sports Arena', category: 'Sports & Recreation', mode: 'Credit Card' }],
  ['Rs 1,499.00 debited from A/c XX4821 towards AMAZON PAY INDIA; UPI Ref 632199887711.',
    { amount: 1499, merchant: 'Amazon Pay India', category: 'Shopping & E-Commerce', refId: '632199887711' }],
  ['Your A/c XXXXX9012 is debited by Rs 650.00 towards INDIKARTING; Ref No 4123987123',
    { amount: 650, merchant: 'Indikarting', category: 'Sports & Recreation', refId: '4123987123' }],
  ['INR 1,250.00 spent on HDFC Bank Card XX9012 at SHELL PETROL PUMP on 16-Nov-2026 (Ref 88392011).',
    { amount: 1250, merchant: 'Shell Petrol Pump', category: 'Commute & Fuel', refId: '88392011' }],
  ['Rs.2,00,000.00 debited from A/c XX1111 to VPA builder@ybl', { amount: 200000 }],
  ['Rs 500 debited from your A/c XX1234 and credited to VPA ravi@oksbi (UPI Ref 123456789012)',
    { amount: 500, merchant: 'Ravi', refId: '123456789012' }],
  ['Rs 450.00 debited from A/c XX1234 at SWIGGY. Avl Bal Rs 12,000.00', { amount: 450, merchant: 'Swiggy' }],
  ['Avl Bal INR 12,000. Rs 450 debited at SWIGGY on 16-11', { amount: 450 }],
  ['Sent Rs.250.00 From HDFC Bank A/c *1234 To RAHUL KUMAR On 16/11/26 Ref 632012345678',
    { amount: 250, merchant: 'Rahul Kumar', refId: '632012345678' }],
  ['₹ 99 paid to NETFLIX via UPI', { amount: 99, merchant: 'Netflix', category: 'Bills & Subscriptions', mode: 'UPI' }],
  ['Paid Rs 60 to Service Station via UPI', { amount: 60, merchant: 'Service Station' }]
];
DEBITS.forEach(([msg, want]) => test('debit tracked: ' + msg.slice(0, 55), () => {
  const p = core.parseMessage(msg);
  assert.strictEqual(p.kind, 'debit', 'expected debit, got ' + p.kind);
  Object.keys(want).forEach(k => assert.strictEqual(p[k], want[k], k + ': got ' + JSON.stringify(p[k])));
}));

/* ---------------- CREDITS must NOT be tracked ---------------- */
const CREDITS = [
  'Rs. 5,000.00 credited to your A/c XX4821 on 16-11-26 by UPI Ref 632100000001',
  'You have received Rs 250 from RAHUL via UPI',
  'Refund of Rs 799 for your Amazon order has been initiated',
  'Cashback of Rs 10 credited to your account',
  'RAHUL paid you ₹300.00',
  'Salary of INR 50,000 credited to A/c XX1234',
  'Payment of Rs 5000 received towards your credit card XX1234',
  'Rs 1,200 has been credited to your account',
  'Reversal: Rs 450 credited back to your A/c after failed UPI transaction'
];
CREDITS.forEach(msg => test('credit ignored: ' + msg.slice(0, 55), () => {
  assert.notStrictEqual(core.parseMessage(msg).kind, 'debit');
}));

/* ---------------- Noise must NOT be tracked ---------------- */
const NOISE = [
  'Your OTP for transaction of Rs 500 is 123456. Do not share.',
  'Transaction of Rs 500 failed. Amount will not be debited.',
  'Get flat Rs 100 cashback on your first recharge',
  'Your credit card bill of Rs 5,000 is due on 20-Nov',
  'Rs 500 will be debited on 20-Nov for your SIP',
  'RAHUL has requested Rs 500 from you',
  'Thank you for your payment of Rs 2000',
  'Mega sale! Pay Rs 99 only',
  'Hello, how are you?',
  ''
];
NOISE.forEach(msg => test('noise ignored: ' + (msg.slice(0, 55) || '(empty)'), () => {
  assert.notStrictEqual(core.parseMessage(msg).kind, 'debit');
}));

/* ---------------- Categories ---------------- */
test('category uses whole words (service != Vi, chocolate != Ola)', () => {
  assert.strictEqual(core.inferCategory('Service Station'), 'Other');
  assert.strictEqual(core.inferCategory('Chocolate Room'), 'Other');
  assert.strictEqual(core.inferCategory('Ola Cabs'), 'Commute & Fuel');
});

/* ---------------- Duplicates ---------------- */
test('duplicate detection', () => {
  const p = core.parseMessage('Rs. 540.00 debited from A/c XX4821 to VPA zomato@hdfcbank (UPI Ref 632189445512).');
  const saved = { amount: 540, merchant: 'Zomato', refId: '632189445512', date: p.date, source: 'Auto', rawNotification: p.raw };
  assert.ok(core.isDuplicate([saved], p), 'same ref id');
  const other = core.parseMessage('Rs. 540.00 debited from A/c XX4821 to VPA zomato@hdfcbank (UPI Ref 999999999999).');
  assert.ok(!core.isDuplicate([saved], other), 'different ref id = different payment');
  const noRef = core.parseMessage('Paid Rs 60 to Chai Point via UPI');
  const e2 = { amount: 60, merchant: 'Chai Point', refId: '', date: noRef.date, source: 'Auto', rawNotification: noRef.raw };
  assert.ok(core.isDuplicate([e2], noRef), 'same text within minutes');
  assert.ok(!core.isDuplicate([], noRef));
});

/* ---------------- Exports ---------------- */
const SAMPLE = [
  { id: '1', date: '2026-11-16T09:30', merchant: 'Rapido', category: 'Commute & Fuel', amount: 145, mode: 'UPI', source: 'Auto', refId: '632109481201', comment: 'Office, "quoted" & <tag>' },
  { id: '2', date: '2026-11-15T20:15', merchant: '=HYPERLINK("x")', category: 'Sports & Recreation', amount: 600.5, mode: 'UPI', source: 'Manual', refId: '', comment: '' },
  { id: '3', date: '2026-10-30T13:10', merchant: 'Swiggy ₹ é 日本', category: 'Food & Dining', amount: 320, mode: 'Credit Card', source: 'Manual', refId: '', comment: 'lunch' }
];

test('csv: BOM, quoting, formula-injection guard', () => {
  const csv = core.buildCsv(SAMPLE);
  assert.ok(csv.startsWith('﻿"Date & Time"'));
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
  const out = process.env.XLSX_OUT;
  if (out) fs.writeFileSync(out, Buffer.from(bytes));
});

test('xlsx: handles an empty list', () => {
  assert.ok(core.buildXlsx([]).length > 500);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
