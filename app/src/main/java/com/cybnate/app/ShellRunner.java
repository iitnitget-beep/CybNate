package com.cybnate.app;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.CRC32;

/** Runs a shell command inside a workspace folder and reports which files it changed. Pure Java so it can be unit-tested on a JVM. */
public final class ShellRunner {
    private static final int MAX_OUTPUT = 200_000;
    private static final long HASH_LIMIT = 4L * 1024 * 1024;

    public static final class Result {
        public int code = -1;
        public String output = "";
        public boolean timedOut;
        public final List<String> changed = new ArrayList<>();
        public final List<String> deleted = new ArrayList<>();
    }

    private ShellRunner() {
    }

    public static Result run(File root, String command, int timeoutSec, File home) {
        return run(root, command, timeoutSec, home, null);
    }

    /** @param cancel set to true from another thread to stop the command early (exit code 130) */
    public static Result run(File root, String command, int timeoutSec, File home, java.util.concurrent.atomic.AtomicBoolean cancel) {
        final Result r = new Result();
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        File tmp = new File(home, "tmp");
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        Map<String, String> before = snapshot(root);
        Process proc = null;
        try {
            String sh = new File("/system/bin/sh").exists() ? "/system/bin/sh" : "sh";
            ProcessBuilder pb = new ProcessBuilder(sh, "-c", command);
            pb.directory(root);
            pb.redirectErrorStream(true);
            pb.environment().put("HOME", home.getAbsolutePath());
            pb.environment().put("TMPDIR", tmp.getAbsolutePath());
            pb.environment().put("WORKSPACE", root.getAbsolutePath());
            proc = pb.start();
            proc.getOutputStream().close();

            final StringBuilder out = new StringBuilder();
            final InputStream in = proc.getInputStream();
            Thread reader = new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        InputStreamReader rd = new InputStreamReader(in, StandardCharsets.UTF_8);
                        char[] buf = new char[4096];
                        int n;
                        while ((n = rd.read(buf)) != -1) {
                            synchronized (out) {
                                if (out.length() < MAX_OUTPUT) out.append(buf, 0, Math.min(n, MAX_OUTPUT - out.length()));
                            }
                        }
                    } catch (Exception ignored) {
                    }
                }
            });
            reader.start();

            long deadline = System.currentTimeMillis() + Math.max(1, timeoutSec) * 1000L;
            boolean finished = false, cancelled = false;
            while (System.currentTimeMillis() < deadline) {
                if (cancel != null && cancel.get()) { cancelled = true; break; }
                try {
                    r.code = proc.exitValue();
                    finished = true;
                    break;
                } catch (IllegalThreadStateException stillRunning) {
                    Thread.sleep(40);
                }
            }
            if (!finished) {
                r.timedOut = !cancelled;
                kill(proc);
                r.code = cancelled ? 130 : 124;
            }
            reader.join(finished ? 3000 : 500);
            synchronized (out) {
                r.output = out.toString();
            }
        } catch (Exception e) {
            r.output = "could not run command: " + e.getMessage();
            r.code = 127;
            if (proc != null) proc.destroy();
        }
        Map<String, String> after = snapshot(root);
        for (Map.Entry<String, String> e : after.entrySet()) {
            if (!e.getValue().equals(before.get(e.getKey()))) r.changed.add(e.getKey());
        }
        for (String k : before.keySet()) if (!after.containsKey(k)) r.deleted.add(k);
        return r;
    }

    private static void kill(Process proc) {
        proc.destroy();
        try { Process.class.getMethod("destroyForcibly").invoke(proc); } catch (Throwable olderAndroid) { /* API < 26 */ }
    }

    /** Relative path to a fingerprint (size plus CRC32 for small files, size plus mtime for large ones). */
    public static Map<String, String> snapshot(File root) {
        Map<String, String> m = new HashMap<>();
        walk(root, "", m, 0);
        return m;
    }

    private static void walk(File dir, String prefix, Map<String, String> m, int depth) {
        File[] list = dir.listFiles();
        if (list == null || depth > 24) return;
        for (File f : list) {
            String rel = prefix.isEmpty() ? f.getName() : prefix + "/" + f.getName();
            if (f.isDirectory()) walk(f, rel, m, depth + 1);
            else if (f.isFile()) m.put(rel, fingerprint(f));
            if (m.size() > 5000) return;
        }
    }

    private static String fingerprint(File f) {
        long len = f.length();
        if (len > HASH_LIMIT) return len + ":m" + f.lastModified();
        CRC32 crc = new CRC32();
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) crc.update(buf, 0, n);
        } catch (Exception e) {
            return len + ":m" + f.lastModified();
        }
        return len + ":c" + crc.getValue();
    }

    /** Resolves a workspace-relative path and refuses anything that escapes the root. */
    public static File resolve(File root, String rel) throws java.io.IOException {
        File f = new File(root, rel);
        String rootPath = root.getCanonicalPath();
        String p = f.getCanonicalPath();
        if (!p.equals(rootPath) && !p.startsWith(rootPath + File.separator)) throw new java.io.IOException("path outside workspace: " + rel);
        return f;
    }
}
