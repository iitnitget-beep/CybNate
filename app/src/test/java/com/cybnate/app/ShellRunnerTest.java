package com.cybnate.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

public class ShellRunnerTest {
    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static void write(File f, String s) throws Exception {
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), s.getBytes(StandardCharsets.UTF_8));
    }

    @Test
    public void runsCommandAndReportsFileChanges() throws Exception {
        File root = tmp.newFolder("ws"), home = tmp.newFolder("home");
        write(new File(root, "keep.txt"), "a\n");
        write(new File(root, "same.txt"), "x\n");
        write(new File(root, "old.txt"), "bye\n");
        write(new File(root, "src/deep.txt"), "1\n");
        ShellRunner.Result r = ShellRunner.run(root,
                "echo hello; echo err 1>&2; echo b >> keep.txt; rm old.txt; mkdir -p out && echo n > out/new.txt; echo 2 > src/deep.txt; cat same.txt >/dev/null; exit 3",
                20, home);
        assertEquals(3, r.code);
        assertFalse(r.timedOut);
        assertTrue(r.output, r.output.contains("hello") && r.output.contains("err"));
        java.util.Collections.sort(r.changed);
        assertEquals(java.util.Arrays.asList("keep.txt", "out/new.txt", "src/deep.txt"), r.changed);
        assertEquals(java.util.Collections.singletonList("old.txt"), r.deleted);
    }

    @Test
    public void detectsSameSizeEditAndWorkingDirectory() throws Exception {
        File root = tmp.newFolder("ws2"), home = tmp.newFolder("home2");
        write(new File(root, "a.txt"), "1111\n");
        ShellRunner.Result r = ShellRunner.run(root, "echo 2222 > a.txt; ls; echo $HOME", 20, home);
        assertEquals(0, r.code);
        assertEquals(java.util.Collections.singletonList("a.txt"), r.changed);
        assertTrue(r.output.contains("a.txt") && r.output.contains(home.getAbsolutePath()));
    }

    @Test
    public void timesOut() throws Exception {
        File root = tmp.newFolder("ws3"), home = tmp.newFolder("home3");
        long t = System.currentTimeMillis();
        ShellRunner.Result r = ShellRunner.run(root, "echo start; sleep 30", 1, home);
        assertTrue(r.timedOut);
        assertEquals(124, r.code);
        assertTrue(System.currentTimeMillis() - t < 8000);
        assertTrue(r.output.contains("start"));
    }

    @Test
    public void resolveRejectsEscapes() throws Exception {
        File root = tmp.newFolder("ws4");
        assertTrue(ShellRunner.resolve(root, "a/b.txt").getPath().endsWith("b.txt"));
        try {
            ShellRunner.resolve(root, "../outside.txt");
            fail("expected rejection");
        } catch (java.io.IOException expected) {
        }
    }

    @Test
    public void stopCancelsARunningCommand() throws Exception {
        File root = tmp.newFolder("ws5"), home = tmp.newFolder("home5");
        final java.util.concurrent.atomic.AtomicBoolean cancel = new java.util.concurrent.atomic.AtomicBoolean();
        new Thread(new Runnable() {
            @Override public void run() {
                try { Thread.sleep(300); } catch (InterruptedException ignored) { }
                cancel.set(true);
            }
        }).start();
        long t0 = System.currentTimeMillis();
        ShellRunner.Result r = ShellRunner.run(root, "sleep 20", 30, home, cancel);
        assertEquals(130, r.code);
        assertFalse(r.timedOut);
        assertTrue("stopped early", System.currentTimeMillis() - t0 < 5000);
    }
}
