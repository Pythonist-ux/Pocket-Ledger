package com.pocketledger.local;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Java port of the parser in web/core.js, so a payment can be recognised while the app is closed
 * (this is what drives the "Logged" pop-up). It is pure Java on purpose: tests/java/ParityTest.java runs
 * it against the SAME tests/vectors.tsv as the JavaScript version, so the two cannot drift apart.
 * Keep the regular expressions in sync with web/core.js.
 */
public final class MessageParser {
    private MessageParser() {}

    /** kind is "debit", "credit" or "ignore". The other fields are only filled for a debit. */
    public static final class Result {
        public String kind = "ignore";
        public double amount = 0;
        public String merchant = "";
        public String bank = "";
        public String acct = "";
        public String mode = "";
        public String refId = "";
    }

    private static final int CI = Pattern.CASE_INSENSITIVE;
    private static final String RS = "\u20B9"; // rupee sign
    private static final String NUM = "[0-9][0-9,]*(?:\\.[0-9]{1,2})?";

    private static Pattern ci(String re) { return Pattern.compile(re, CI); }

    /* ---------------- debit-only classification ---------------- */

    private static final Pattern RE_IGNORE = ci(
            "\\b(?:otp|one[- ]time password|verification code|passcode)\\b"
            + "|\\b(?:failed|declined|unsuccessful|rejected|cancell?ed|insufficient)\\b"
            + "|\\bnot\\s+(?:been\\s+)?(?:debited|processed|completed)\\b"
            + "|\\b(?:will be|to be|scheduled to be|is due|are due|due on|due by|pending)\\b"
            + "|\\b(?:payment|collect|money)\\s+request\\b"
            + "|\\brequested\\s+(?:you\\s+)?(?:rs|inr|" + RS + "|money)"
            + "|\\bthank you for\\b"
            + "|\\b(?:offer|discount|coupon|voucher|pre-?approved|apply now|get up to|win up to|flat\\s+(?:rs|" + RS + "))\\b|% off");
    private static final Pattern RE_STRONG_CREDIT = ci(
            "\\b(?:refund(?:ed)?|cashback|reversal|reversed|received|deposited|salary)\\b|\\b(?:paid|sent)\\s+you\\b|\\b(?:credit|cr)\\s+alert\\b");
    private static final Pattern RE_DEBIT = ci(
            "\\b(?:debited|spent|paid|purchased?|withdrawn|withdrawal|charged|deducted|sent)\\b|\\bpayment\\s+of\\b|\\btransferred\\s+to\\b|\\b(?:txn|transaction)\\s+of\\b|\\bdebit\\s+(?:of|by)\\b");
    private static final Pattern RE_WEAK_CREDIT = ci("\\bcredited\\b");

    static String classify(String text) {
        if (text.trim().isEmpty()) return "ignore";
        if (RE_IGNORE.matcher(text).find()) return "ignore";
        if (RE_STRONG_CREDIT.matcher(text).find()) return "credit";
        if (RE_DEBIT.matcher(text).find()) return "debit";
        if (RE_WEAK_CREDIT.matcher(text).find()) return "credit";
        return "ignore";
    }

    /* ---------------- amount ---------------- */

    private static final Pattern AMOUNT = ci("(?:\\brs\\.?|\\binr|" + RS + ")\\s*:?\\s*(" + NUM + ")");
    private static final Pattern AMOUNT_SUFFIX = ci("(" + NUM + ")\\s*(?:rs\\.?|inr|" + RS + ")");
    private static final Pattern AMOUNT_VERB = ci("\\b(?:debited|debit|paid|spent|withdrawn|sent|charged|deducted)\\s+(?:by|of|for|with)?\\s*(" + NUM + ")\\b");
    private static final Pattern BALANCE_BEFORE = ci("(?:bal(?:ance)?|avl|avail(?:able)?|limit|outstanding)[\\s:.\\-a-z/]*$");

    private static double toNumber(String s) { return Double.parseDouble(s.replace(",", "")); }

    private static double extractAmount(String text) {
        double best = 0;
        Matcher m = AMOUNT.matcher(text);
        while (m.find()) {
            String before = text.substring(Math.max(0, m.start() - 22), m.start());
            if (BALANCE_BEFORE.matcher(before).find()) continue; // skip "Avl Bal Rs 12,000"
            double n = toNumber(m.group(1));
            if (n > 0) { best = n; break; }
        }
        if (best == 0) { Matcher t = AMOUNT_SUFFIX.matcher(text); if (t.find()) best = toNumber(t.group(1)); }
        if (best == 0) { Matcher d = AMOUNT_VERB.matcher(text); if (d.find()) best = toNumber(d.group(1)); }
        return best > 0 ? best : 0;
    }

    /* ---------------- payee ---------------- */

    private static String titleCase(String s) {
        String low = s.toLowerCase();
        StringBuilder out = new StringBuilder(low.length());
        for (int i = 0; i < low.length(); i++) {
            char c = low.charAt(i);
            boolean start = i == 0 || Character.isWhitespace(low.charAt(i - 1)) || "-&.".indexOf(low.charAt(i - 1)) >= 0;
            out.append(start && c >= 'a' && c <= 'z' ? Character.toUpperCase(c) : c);
        }
        return out.toString();
    }

    private static String cleanMerchant(String raw) {
        String s = raw == null ? "" : raw.replaceAll("\\s+", " ").replaceAll("[.\\-_ ]+$", "").trim();
        s = s.replaceAll("(?i)\\s+upi$", "");
        if (s.isEmpty() || s.matches("^[0-9 ]+$")) return "";
        if (s.equals(s.toUpperCase()) || s.equals(s.toLowerCase())) s = titleCase(s);
        return s;
    }

    private static final String STOP = "(?=\\s+(?:on|using|via|from|through|ref(?:no)?|upi|vpa|a\\/c|ac|acct|account|date|dated|at|for|txn|utr|if|not|is|was|has|successful(?:ly)?|completed|done)\\b|[.;,(\\n\\/:]|$)";
    private static final String NAME = "([A-Za-z0-9][A-Za-z0-9&'._\\- ]{1,40}?)";

    private static final Pattern[] PAYEE = {
        ci("\\bUPI\\/[A-Za-z0-9]{2,4}\\/\\d{6,}\\/([^\\/\\n]{2,40}?)\\s*(?:\\/|$)"),
        ci("\\b(?:payee|beneficiary|merchant|receiver)(?:\\s+name)?\\s*[:\\-]\\s*" + NAME + STOP),
        ci("\\b(?:paid|sent|transferred)\\s+(?:" + RS + "|rs\\.?|inr)?\\s*:?\\s*" + NUM + "\\s+(?:from\\s+.*?\\s+)?to\\s+(?!vpa\\b)" + NAME + STOP),
        ci("(?:" + RS + "|\\brs\\.?|\\binr)\\s*:?\\s*" + NUM + "\\s+(?:sent|paid|transferred)\\s+to\\s+" + NAME + STOP),
        ci("\\byou\\s+paid\\s+(?!(?:" + RS + "|rs|inr)\\b)(?!\\d)" + NAME + "(?=\\s+(?:" + RS + "|rs\\.?|inr)\\s*\\d)"),
        ci("\\btowards\\s+" + NAME + STOP),
        ci("(?:^|[;,.]\\s*)" + NAME + "\\s+credited\\b"),
        ci("\\bvpa\\s+([A-Za-z0-9._\\-]+)@[A-Za-z0-9]+"),                       // index 7: handle
        ci("\\bto\\s+([A-Za-z0-9._\\-]+)@[A-Za-z][A-Za-z0-9]+"),                 // index 8: handle
        ci("\\bat\\s+(?!\\d)" + NAME + STOP),
        ci("\\bto\\s+(?!vpa\\b|a\\/c\\b|ac\\b|your\\b|you\\b|the\\b|my\\b)" + NAME + STOP),
    };
    private static final int FIRST_HANDLE = 7, LAST_HANDLE = 8;
    private static final Pattern BAD_PAYEE = ci("^(?:a\\/c|ac|acct|account|your|you|bank|upi|ref|xx+|x+\\d*|ending|card)\\b");
    private static final Pattern ATM = ci("\\batm\\b"), WITHDRAW = ci("\\bwithdraw");

    private static String extractMerchant(String text) {
        if (ATM.matcher(text).find() && WITHDRAW.matcher(text).find()) return "ATM Withdrawal";
        for (int i = 0; i < PAYEE.length; i++) {
            Matcher m = PAYEE[i].matcher(text);
            if (!m.find() || m.group(1) == null) continue;
            String c;
            if (i >= FIRST_HANDLE && i <= LAST_HANDLE) {
                String handle = m.group(1).replaceAll("[0-9._\\-]+", " ").trim();
                c = handle.length() > 1 ? titleCase(handle) : "";
            } else {
                c = cleanMerchant(m.group(1));
            }
            if (!c.isEmpty() && !BAD_PAYEE.matcher(c).find()) return c;
        }
        return "Unknown";
    }

    /* ---------------- bank, account, mode, reference ---------------- */

    private static final String[][] BANK_DEFS = {
        {"HDFC Bank", "\\bhdfc"}, {"SBI Card", "\\bsbi\\s*card|\\bsbicrd"}, {"SBI", "\\bsbi(?!\\s*life)|\\bstate bank of india"},
        {"ICICI Bank", "\\bicici"}, {"Axis Bank", "\\baxis"}, {"Kotak Bank", "\\bkotak"},
        {"PNB", "\\bpnb\\b|\\bpunjab national"}, {"Bank of Baroda", "\\bbank of baroda|\\bbob(?:sms|card|upi)?\\b|\\bbarodb"},
        {"Canara Bank", "\\bcanara|\\bcnrb"}, {"Union Bank", "\\bunion bank|\\bunionb"}, {"IDFC First Bank", "\\bidfc"},
        {"Yes Bank", "\\byes\\s*bank"}, {"IndusInd Bank", "\\bindusind"}, {"Federal Bank", "\\bfederal\\s*bank|\\bfedbnk"},
        {"RBL Bank", "\\brbl"}, {"AU Small Finance Bank", "\\bau\\s*small\\s*finance|\\bau\\s*bank"},
        {"Central Bank of India", "\\bcentral bank of india"}, {"Bank of Maharashtra", "\\bbank of maharashtra"},
        {"Bank of India", "\\bbank of india|\\bboi\\b"}, {"Indian Bank", "\\bindian bank"},
        {"Indian Overseas Bank", "\\bindian overseas|\\biob\\b"}, {"UCO Bank", "\\buco\\b"}, {"Bandhan Bank", "\\bbandhan"},
        {"South Indian Bank", "\\bsouth indian bank"}, {"Karnataka Bank", "\\bkarnataka bank"},
        {"Paytm Payments Bank", "\\bpaytm\\s*payments\\s*bank|\\bppbl"}, {"Airtel Payments Bank", "\\bairtel\\s*payments\\s*bank"},
        {"India Post Payments Bank", "\\bippb|\\bindia post"}, {"Standard Chartered", "\\bstandard chartered"},
        {"Citibank", "\\bciti\\s*bank"}, {"HSBC", "\\bhsbc"}, {"DBS Bank", "\\bdbs\\b"}, {"J&K Bank", "\\bj\\s*&\\s*k bank|\\bjk bank"},
    };
    private static final List<Pattern> BANK_RE = new ArrayList<>();
    static { for (String[] b : BANK_DEFS) BANK_RE.add(ci(b[1])); }

    private static final Pattern BANK_GENERIC = Pattern.compile("(?:^|[\\s,;(])((?:[A-Z][A-Za-z&]+\\s){1,2}Bank)\\b");
    private static final Pattern BANK_JUNK = Pattern.compile("^(?:Your|The|This|Dear|My|Our|Not|Any|Bank|UPI|Mob|Avl)\\b");

    private static String extractBank(String text) {
        // ignore the payee's UPI handle and the UPI/P2A/../NAME/BANK/ trail: they name the OTHER party's bank
        String t = text.replaceAll("[A-Za-z0-9._\\-]+@[A-Za-z0-9]+", " ").replaceAll("(?i)\\bUPI/\\S+", " ");
        for (int i = 0; i < BANK_RE.size(); i++) if (BANK_RE.get(i).matcher(t).find()) return BANK_DEFS[i][0];
        Matcher g = BANK_GENERIC.matcher(t);
        if (g.find() && !BANK_JUNK.matcher(g.group(1)).find()) return g.group(1);
        return "";
    }

    private static final Pattern ACCT = ci("\\b(?:a/c|ac|acct|account|card)\\b[\\s:.]*(?:no\\b\\.?|number)?[\\s:.]*(?:ending(?:\\s+(?:with|in))?)?[\\s:.]*[xX*\u2022]*\\s*(\\d{3,6})\\b");

    private static String extractAcct(String text) {
        Matcher m = ACCT.matcher(text);
        if (!m.find()) return "";
        String d = m.group(1);
        return d.length() > 4 ? d.substring(d.length() - 4) : d;
    }

    private static final Pattern M_CREDIT = ci("credit\\s*card|\\bcc\\b"), M_DEBIT = ci("debit\\s*card|\\batm\\b"),
            M_UPI = ci("\\bupi\\b|\\bvpa\\b|google\\s*pay|gpay|phonepe|paytm|bhim"),
            M_NET = ci("netbanking|net banking|\\bneft\\b|\\bimps\\b|\\brtgs\\b"), M_CARD = ci("\\bcard\\b");

    private static String extractMode(String text) {
        if (M_CREDIT.matcher(text).find()) return "Credit Card";
        if (M_DEBIT.matcher(text).find()) return "Debit Card";
        if (M_UPI.matcher(text).find()) return "UPI";
        if (M_NET.matcher(text).find()) return "NetBanking";
        if (M_CARD.matcher(text).find()) return "Card";
        return "Bank";
    }

    private static final Pattern REF_SLASH = ci("\\bUPI\\/[A-Za-z0-9]{2,4}\\/(\\d{6,})");
    private static final Pattern REF = ci("\\b(?:upi\\s*(?:ref(?:erence)?|txn)?\\s*(?:no\\.?|id)?|ref(?:erence)?\\s*(?:no\\.?|number|id)?|txn\\s*(?:id|no\\.?)|transaction\\s*id|utr)[\\s:.#\\-]*([A-Za-z0-9]{6,24})");
    private static final Pattern HAS_DIGIT = Pattern.compile("\\d");

    private static String extractRef(String text) {
        Matcher s = REF_SLASH.matcher(text);
        if (s.find()) return s.group(1);
        Matcher m = REF.matcher(text);
        while (m.find()) if (HAS_DIGIT.matcher(m.group(1)).find()) return m.group(1);
        return "";
    }

    /* ---------------- public API ---------------- */

    public static Result parse(String text) {
        Result r = new Result();
        String raw = text == null ? "" : text.replaceAll("\\s+", " ").trim();
        r.kind = classify(raw);
        if (!r.kind.equals("debit")) return r;
        double amount = extractAmount(raw);
        if (amount <= 0) { r.kind = "ignore"; return r; }
        r.amount = amount;
        r.merchant = extractMerchant(raw);
        r.mode = extractMode(raw);
        r.bank = extractBank(raw);
        r.acct = extractAcct(raw);
        r.refId = extractRef(raw);
        return r;
    }

    /** Identifies one notification's text (used to ignore the same alert being re-posted). */
    public static String fingerprint(String text) {
        String s = text == null ? "" : text.toLowerCase().replaceAll("\\s+", " ").trim();
        return Integer.toHexString(s.hashCode()) + ":" + s.length();
    }
}
