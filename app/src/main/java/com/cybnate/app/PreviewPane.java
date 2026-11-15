package com.cybnate.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * Shows workspace HTML in its own WebView. That WebView has NO JavaScript interface, no file access and a
 * different origin, so scripts in a previewed page cannot reach the app's native bridge (shell, files, HTTP).
 */
final class PreviewPane {
    static final String ORIGIN = "https://preview.cybnate.invalid/";
    private final Activity act;
    private final FrameLayout root;
    private LinearLayout pane;
    private WebView view;
    volatile String title = "";
    private final StringBuffer console = new StringBuffer();
    private int consoleCount, consoleErrors;
    private TextView consoleBtn, consoleText;
    private ScrollView consoleBox;

    String consoleText() {
        return console.toString();
    }

    private void drawConsole() {
        if (consoleBtn == null) return;
        consoleBtn.setText("Console " + consoleCount + (consoleErrors > 0 ? "  \u26A0 " + consoleErrors : ""));
        consoleBtn.setTextColor(consoleErrors > 0 ? 0xFFFF8A80 : 0xFFB9D4A8);
        if (consoleText != null && consoleBox != null && consoleBox.getVisibility() == View.VISIBLE) {
            consoleText.setText(console.length() == 0 ? "No console output yet." : console.toString());
        }
    }

    PreviewPane(Activity act, FrameLayout root) {
        this.act = act;
        this.root = root;
    }

    boolean isOpen() {
        return pane != null;
    }

    /** Must run on the UI thread. */
    void open(String name, String html) {
        close();
        title = "";
        console.setLength(0);
        consoleCount = 0;
        consoleErrors = 0;
        pane = new LinearLayout(act);
        pane.setOrientation(LinearLayout.VERTICAL);
        pane.setBackgroundColor(0xFF1C1C1C);
        pane.setFitsSystemWindows(true);
        pane.setClickable(true);

        LinearLayout bar = new LinearLayout(act);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = (int) (12 * act.getResources().getDisplayMetrics().density);
        bar.setPadding(pad, pad / 2, pad, pad / 2);
        TextView label = new TextView(act);
        label.setText("\u25B6 " + (name == null ? "Preview" : name));
        label.setTextColor(Color.WHITE);
        label.setSingleLine(true);
        bar.addView(label, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        consoleBtn = new TextView(act);
        consoleBtn.setPadding(pad, pad, pad, pad);
        consoleBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (consoleBox == null) return;
                consoleBox.setVisibility(consoleBox.getVisibility() == View.VISIBLE ? View.GONE : View.VISIBLE);
                drawConsole();
            }
        });
        bar.addView(consoleBtn);
        TextView x = new TextView(act);
        x.setText("Close \u2715");
        x.setTextColor(0xFFB9D4A8);
        x.setPadding(pad, pad, 0, pad);
        x.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { close(); }
        });
        bar.addView(x);
        pane.addView(bar);

        view = new WebView(act);
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        // localStorage for the previewed page. It lives under the preview origin, apart from the app's own storage.
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setTextZoom(100);
        // Deliberately no addJavascriptInterface here: this is the whole point of the separate view.
        view.setWebChromeClient(new WebChromeClient() {
            @Override public void onReceivedTitle(WebView v, String t) { title = t == null ? "" : t; }
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                boolean err = m.messageLevel() == ConsoleMessage.MessageLevel.ERROR;
                consoleCount++;
                if (err) consoleErrors++;
                if (console.length() < 60000) {
                    console.append(err ? "\u2717 " : m.messageLevel() == ConsoleMessage.MessageLevel.WARNING ? "! " : "\u203A ")
                            .append(m.message());
                    if (err && m.lineNumber() > 0) console.append("  (line ").append(m.lineNumber()).append(")");
                    console.append('\n');
                }
                drawConsole();
                return true;
            }
        });
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest rq) {
                String scheme = String.valueOf(rq.getUrl().getScheme());
                if (scheme.equals("http") || scheme.equals("https")) {
                    try { act.startActivity(new Intent(Intent.ACTION_VIEW, rq.getUrl())); } catch (Exception ignored) { }
                }
                return true;
            }
        });
        pane.addView(view, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        consoleText = new TextView(act);
        consoleText.setTextColor(0xFFE0E0E0);
        consoleText.setTextSize(12);
        consoleText.setTypeface(android.graphics.Typeface.MONOSPACE);
        consoleText.setTextIsSelectable(true);
        consoleText.setPadding(pad, pad / 2, pad, pad / 2);
        consoleBox = new ScrollView(act);
        consoleBox.setBackgroundColor(0xFF101010);
        consoleBox.addView(consoleText);
        consoleBox.setVisibility(View.GONE);
        pane.addView(consoleBox, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, (int) (180 * act.getResources().getDisplayMetrics().density)));
        drawConsole();
        root.addView(pane, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        view.loadDataWithBaseURL(ORIGIN, html == null ? "" : html, "text/html", "utf-8", null);
    }

    /** Must run on the UI thread. */
    void close() {
        if (pane == null) return;
        root.removeView(pane);
        if (view != null) { view.stopLoading(); view.destroy(); }
        view = null;
        pane = null;
        consoleBtn = null;
        consoleText = null;
        consoleBox = null;
    }
}
