import com.pocketledger.local.MessageParser;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.List;

/** Runs the Java parser against the same tests/vectors.tsv the JavaScript tests use. */
public class ParityTest {
    public static void main(String[] args) throws Exception {
        List<String> lines = Files.readAllLines(Paths.get(args[0]), StandardCharsets.UTF_8);
        int pass = 0, fail = 0;
        for (String line : lines) {
            if (line.trim().isEmpty() || line.startsWith("#")) continue;
            String[] c = line.split("\t", -1);
            String kind = c[0], msg = c[1];
            MessageParser.Result r = MessageParser.parse(msg);
            StringBuilder err = new StringBuilder();
            if (!kind.equals("debit")) {
                if (r.kind.equals("debit")) err.append("must not be tracked but was a debit; ");
            } else {
                if (!r.kind.equals("debit")) err.append("expected debit, got ").append(r.kind).append("; ");
                else {
                    if (!c[2].isEmpty() && Math.abs(r.amount - Double.parseDouble(c[2])) > 0.001) err.append("amount ").append(r.amount).append("; ");
                    check(err, "payee", c[3], r.merchant); check(err, "bank", c[4], r.bank); check(err, "acct", c[5], r.acct);
                    check(err, "mode", c[6], r.mode); check(err, "ref", c[7], r.refId);
                }
            }
            if (err.length() == 0) pass++;
            else { fail++; System.out.println("FAIL " + kind + ": " + msg + "\n      " + err); }
        }
        System.out.println(pass + " passed" + (fail > 0 ? ", " + fail + " FAILED" : ""));
        System.exit(fail > 0 ? 1 : 0);
    }

    private static void check(StringBuilder err, String name, String want, String got) {
        if (want.isEmpty()) return;
        String expected = want.equals("-") ? "" : want;
        if (!expected.equals(got)) err.append(name).append(": got '").append(got).append("' want '").append(expected).append("'; ");
    }
}
