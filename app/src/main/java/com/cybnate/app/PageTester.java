package com.cybnate.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewGroup;
import android.webkit.ValueCallback;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Loads a workspace page in a WebView the user cannot see (it sits behind the app's own view) and waits for the report its test harness leaves in
 * window.__cybResult. Like the preview, this WebView has NO JavaScript interface and its own origin, so a page
 * under test cannot reach the native bridge. Results are read from outside with evaluateJavascript.
 */
final class PageTester {
    interface Done {
        /** @param json a JavaScript string literal holding the report (or "null" when the page gave none). */
        void result(String json);
    }

    private final Activity act;
    private final FrameLayout root;
    private final Handler ui = new Handler(Looper.getMainLooper());

    PageTester(Activity act, FrameLayout root) {
        this.act = act;
        this.root = root;
    }

    /** Must run on the UI thread. */
    void run(String html, int timeoutMs, final Done done) {
        final WebView view = new WebView(act);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        // Deliberately no addJavascriptInterface.
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest rq) {
                return true; // a page under test stays where it is
            }
        });
        // Added below the app's own WebView (index 0), which covers it completely. It stays VISIBLE on purpose:
        // a hidden WebView throttles timers and skips layout, and the report needs both.
        root.addView(view, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.loadDataWithBaseURL(PreviewPane.ORIGIN, html == null ? "" : html, "text/html", "utf-8", null);

        final long deadline = System.currentTimeMillis() + Math.max(1000, Math.min(timeoutMs, 60000));
        final boolean[] finished = { false };
        final Runnable[] poll = new Runnable[1];
        poll[0] = new Runnable() {
            @Override
            public void run() {
                if (finished[0]) return;
                final boolean last = System.currentTimeMillis() >= deadline;
                view.evaluateJavascript(last
                        ? "(function(){try{return window.__cybResult||(window.__cybPartial?window.__cybPartial():'')}catch(e){return ''}})()"
                        : "(function(){try{return window.__cybResult||''}catch(e){return ''}})()", new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (finished[0]) return;
                        boolean has = value != null && value.length() > 2 && !"null".equals(value);
                        if (has || last) {
                            finished[0] = true;
                            try {
                                root.removeView(view);
                                view.stopLoading();
                                view.destroy();
                            } catch (Exception ignored) { }
                            done.result(has ? value : "null");
                        } else {
                            ui.postDelayed(poll[0], 150);
                        }
                    }
                });
            }
        };
        ui.postDelayed(poll[0], 200);
    }
}
