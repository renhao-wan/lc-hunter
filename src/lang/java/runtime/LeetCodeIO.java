import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Deque;
import java.util.List;

/**
 * LeetCode 风格的输入解析 / 输出序列化工具。
 * 约定：每个参数占一行（与力扣 sampleTestCase 的格式一致）。
 * 由 lc-hunter 自动生成，可随意修改。
 */
class LeetCodeIO {

    static final BufferedReader IN = new BufferedReader(new InputStreamReader(System.in));

    /** 读取下一行非空内容；到末尾返回 "" */
    static String nextLine() {
        try {
            String s;
            while ((s = IN.readLine()) != null) {
                String t = s.trim();
                if (!t.isEmpty()) return t;
            }
        } catch (IOException ignored) {
        }
        return "";
    }

    /** 一次读完所有非空行。自定义输入格式（如"第一行 n，接下来 m 行边"）时从这里起步 */
    static java.util.List<String> readAllLines() {
        java.util.List<String> out = new java.util.ArrayList<>();
        String s;
        while (!(s = nextLine()).isEmpty()) out.add(s);
        return out;
    }

    // ---------------- 基础解析 ----------------

    static String stripQuotes(String s) {
        if (s == null) return "";
        String t = s.trim();
        if (t.length() >= 2 && t.startsWith("\"") && t.endsWith("\"")) {
            return t.substring(1, t.length() - 1);
        }
        return t;
    }

    static char parseChar(String s) {
        String t = stripQuotes(s);
        return t.isEmpty() ? ' ' : t.charAt(0);
    }

    static String parseString(String s) {
        return stripQuotes(s);
    }

    /** 把 "[1,2,3]" 解析成 String[]；也兼容 "1,2,3" 与 "[]" */
    static String[] splitTokens(String s) {
        String t = s.trim();
        if (t.startsWith("[")) t = t.substring(1);
        if (t.endsWith("]")) t = t.substring(0, t.length() - 1);
        t = t.trim();
        if (t.isEmpty()) return new String[0];
        String[] parts = t.split(",");
        for (int i = 0; i < parts.length; i++) parts[i] = parts[i].trim();
        return parts;
    }

    static int[] parseIntArray(String s) {
        String[] p = splitTokens(s);
        int[] a = new int[p.length];
        for (int i = 0; i < p.length; i++) {
            String v = p[i];
            if (v.isEmpty() || v.equals("null")) { a[i] = 0; continue; }
            a[i] = Integer.parseInt(v);
        }
        return a;
    }

    static long[] parseLongArray(String s) {
        String[] p = splitTokens(s);
        long[] a = new long[p.length];
        for (int i = 0; i < p.length; i++) {
            String v = p[i];
            if (v.isEmpty() || v.equals("null")) { a[i] = 0L; continue; }
            a[i] = Long.parseLong(v);
        }
        return a;
    }

    static double[] parseDoubleArray(String s) {
        String[] p = splitTokens(s);
        double[] a = new double[p.length];
        for (int i = 0; i < p.length; i++) {
            String v = p[i];
            if (v.isEmpty() || v.equals("null")) { a[i] = 0.0; continue; }
            a[i] = Double.parseDouble(v);
        }
        return a;
    }

    static boolean[] parseBooleanArray(String s) {
        String[] p = splitTokens(s);
        boolean[] a = new boolean[p.length];
        for (int i = 0; i < p.length; i++) a[i] = Boolean.parseBoolean(p[i]);
        return a;
    }

    static String[] parseStringArray(String s) {
        String[] p = splitTokens(s);
        for (int i = 0; i < p.length; i++) p[i] = stripQuotes(p[i]);
        return p;
    }

    static char[] parseCharArray(String s) {
        String[] p = splitTokens(s);
        char[] a = new char[p.length];
        for (int i = 0; i < p.length; i++) a[i] = parseChar(p[i]);
        return a;
    }

    static Integer[] parseIntegerBoxedArray(String s) {
        String[] p = splitTokens(s);
        Integer[] a = new Integer[p.length];
        for (int i = 0; i < p.length; i++) {
            String v = p[i];
            a[i] = (v.isEmpty() || v.equals("null")) ? null : Integer.valueOf(v);
        }
        return a;
    }

    static List<Integer> parseIntList(String s) {
        return new ArrayList<>(Arrays.asList(parseIntegerBoxedArray(s)));
    }

    /** 解析二维："[[1,2],[3,4]]" */
    static List<String[]> splitGroups(String s) {
        List<String[]> out = new ArrayList<>();
        String t = s.trim();
        if (t.isEmpty() || t.equals("[]")) return out;
        if (t.startsWith("[")) t = t.substring(1);
        if (t.endsWith("]")) t = t.substring(0, t.length() - 1);
        int depth = 0;
        int start = 0;
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == '[') depth++;
            else if (c == ']') depth--;
            else if (c == ',' && depth == 0) {
                out.add(new String[] { t.substring(start, i).trim() });
                start = i + 1;
            }
        }
        String last = t.substring(start).trim();
        if (!last.isEmpty()) out.add(new String[] { last });
        return out;
    }

    static int[][] parseIntMatrix(String s) {
        List<String[]> g = splitGroups(s);
        int[][] m = new int[g.size()][];
        for (int i = 0; i < g.size(); i++) m[i] = parseIntArray(g.get(i)[0]);
        return m;
    }

    static char[][] parseCharMatrix(String s) {
        List<String[]> g = splitGroups(s);
        char[][] m = new char[g.size()][];
        for (int i = 0; i < g.size(); i++) m[i] = parseCharArray(g.get(i)[0]);
        return m;
    }

    static String[][] parseStringMatrix(String s) {
        List<String[]> g = splitGroups(s);
        String[][] m = new String[g.size()][];
        for (int i = 0; i < g.size(); i++) m[i] = parseStringArray(g.get(i)[0]);
        return m;
    }

    static List<List<Integer>> parseIntListList(String s) {
        List<String[]> g = splitGroups(s);
        List<List<Integer>> out = new ArrayList<>();
        for (String[] e : g) out.add(parseIntList(e[0]));
        return out;
    }

    // ---------------- 数据结构 ----------------

    static ListNode buildList(int[] a) {
        ListNode dummy = new ListNode(0);
        ListNode cur = dummy;
        for (int v : a) {
            cur.next = new ListNode(v);
            cur = cur.next;
        }
        return dummy.next;
    }

    static TreeNode buildTree(Integer[] a) {
        if (a == null || a.length == 0 || a[0] == null) return null;
        TreeNode root = new TreeNode(a[0]);
        Deque<TreeNode> q = new ArrayDeque<>();
        q.add(root);
        int i = 1;
        while (!q.isEmpty() && i < a.length) {
            TreeNode node = q.poll();
            if (i < a.length && a[i] != null) {
                node.left = new TreeNode(a[i]);
                q.add(node.left);
            }
            i++;
            if (i < a.length && a[i] != null) {
                node.right = new TreeNode(a[i]);
                q.add(node.right);
            }
            i++;
        }
        return root;
    }

    // ---------------- 序列化 ----------------

    static String toStr(Object o) {
        if (o == null) return "[]";
        if (o instanceof int[]) return Arrays.toString((int[]) o);
        if (o instanceof long[]) return Arrays.toString((long[]) o);
        if (o instanceof double[]) return Arrays.toString((double[]) o);
        if (o instanceof boolean[]) return Arrays.toString((boolean[]) o);
        if (o instanceof char[]) return toStr(new String((char[]) o));
        if (o instanceof Object[]) return toStr(Arrays.asList((Object[]) o));
        if (o instanceof String) return "\"" + String.valueOf(o) + "\"";
        if (o instanceof Character) return "\"" + String.valueOf(o) + "\"";
        if (o instanceof TreeNode) return Arrays.toString(treeToArray((TreeNode) o));
        if (o instanceof ListNode) return Arrays.toString(listToArray((ListNode) o));
        if (o instanceof List) {
            StringBuilder sb = new StringBuilder("[");
            List<?> l = (List<?>) o;
            for (int i = 0; i < l.size(); i++) {
                if (i > 0) sb.append(",");
                Object e = l.get(i);
                if (e instanceof String || e instanceof Character) sb.append(toStr(e));
                else sb.append(String.valueOf(e));
            }
            return sb.append("]").toString();
        }
        return String.valueOf(o);
    }

    static Integer[] treeToArray(TreeNode root) {
        if (root == null) return new Integer[0];
        List<Integer> vals = new ArrayList<>();
        Deque<TreeNode> q = new ArrayDeque<>();
        q.add(root);
        while (!q.isEmpty()) {
            TreeNode n = q.poll();
            if (n == null) {
                vals.add(null);
                continue;
            }
            vals.add(n.val);
            if (n.left == null && n.right == null) continue;
            q.add(n.left);
            q.add(n.right);
        }
        while (!vals.isEmpty() && vals.get(vals.size() - 1) == null) {
            vals.remove(vals.size() - 1);
        }
        return vals.toArray(new Integer[0]);
    }

    static Integer[] listToArray(ListNode head) {
        List<Integer> vals = new ArrayList<>();
        while (head != null) {
            vals.add(head.val);
            head = head.next;
        }
        return vals.toArray(new Integer[0]);
    }
}
