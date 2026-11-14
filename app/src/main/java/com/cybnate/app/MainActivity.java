package com.cybnate.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.concurrent.ConcurrentHashMap;

public class MainActivity extends Activity {
    private static final String HOME = "https://appassets.androidplatform.net/assets/www/index.html";
    private static final int REQ_FILE = 41;

    private WebView web;
    private ValueCallback<Uri[]> fileCallback;
    private final ConcurrentHashMap<String, HttpURLConnection> requests = new ConcurrentHashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        web = new WebView(this);
        web.setBackgroundColor(0xFF0B0F0E);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if ("appassets.androidplatform.net".equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(i, "Choose files"), REQ_FILE);
                } catch (Exception e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "Native");

        if (savedInstanceState != null) web.restoreState(savedInstanceState);
        else web.loadUrl(HOME);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int i = 0; i < n; i++) result[i] = data.getClipData().getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("(window.onNativeBack && window.onNativeBack()) ? '1' : '0'", new ValueCallback<String>() {
            @Override
            public void onReceiveValue(String v) {
                if (v == null || !v.contains("1")) moveTaskToBack(true);
            }
        });
    }

    private void js(final String code) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                web.evaluateJavascript(code, null);
            }
        });
    }

    private void emit(String id, String kind, String data) {
        js("window.__nh && window.__nh(" + JSONObject.quote(id) + "," + JSONObject.quote(kind) + ","
                + JSONObject.quote(data == null ? "" : data) + ")");
    }

    private class Bridge {
        /** Streaming HTTP that is not subject to browser CORS rules. */
        @JavascriptInterface
        public void http(final String id, final String url, final String method, final String headersJson, final String body) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    HttpURLConnection c = null;
                    try {
                        c = (HttpURLConnection) new URL(url).openConnection();
                        requests.put(id, c);
                        c.setRequestMethod(method == null ? "GET" : method);
                        c.setConnectTimeout(30000);
                        c.setReadTimeout(180000);
                        if (headersJson != null && headersJson.length() > 0) {
                            JSONObject h = new JSONObject(headersJson);
                            Iterator<String> it = h.keys();
                            while (it.hasNext()) {
                                String k = it.next();
                                c.setRequestProperty(k, h.getString(k));
                            }
                        }
                        if (body != null && body.length() > 0) {
                            c.setDoOutput(true);
                            OutputStream os = c.getOutputStream();
                            os.write(body.getBytes(StandardCharsets.UTF_8));
                            os.close();
                        }
                        int status = c.getResponseCode();
                        String ct = c.getContentType();
                        emit(id, "h", status + "|" + (ct == null ? "" : ct));
                        InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                        if (in != null) {
                            InputStreamReader r = new InputStreamReader(in, StandardCharsets.UTF_8);
                            char[] buf = new char[4096];
                            int n;
                            while ((n = r.read(buf)) != -1) {
                                if (n > 0) emit(id, "d", new String(buf, 0, n));
                            }
                            r.close();
                        }
                        emit(id, "x", "");
                    } catch (Exception e) {
                        emit(id, "e", String.valueOf(e.getMessage() == null ? e.toString() : e.getMessage()));
                    } finally {
                        requests.remove(id);
                        if (c != null) c.disconnect();
                    }
                }
            }).start();
        }

        @JavascriptInterface
        public void httpAbort(String id) {
            final HttpURLConnection c = requests.remove(id);
            if (c != null) new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        c.disconnect();
                    } catch (Exception ignored) {
                    }
                }
            }).start();
        }

        /** Saves a file into the public Downloads folder. Returns a human readable location or "ERR:..." */
        @JavascriptInterface
        public String saveFile(String name, String base64, String mime) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                if (mime == null || mime.length() == 0) mime = "application/octet-stream";
                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues v = new ContentValues();
                    v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                    v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/CybNate");
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                    if (uri == null) return "ERR:could not create file";
                    OutputStream os = getContentResolver().openOutputStream(uri);
                    if (os == null) return "ERR:could not open file";
                    os.write(data);
                    os.close();
                    return "Downloads/CybNate/" + name;
                } else {
                    File dir = new File(getExternalFilesDir(null), "exports");
                    //noinspection ResultOfMethodCallIgnored
                    dir.mkdirs();
                    File f = new File(dir, name);
                    FileOutputStream os = new FileOutputStream(f);
                    os.write(data);
                    os.close();
                    return f.getAbsolutePath();
                }
            } catch (Exception e) {
                return "ERR:" + e.getMessage();
            }
        }

        @JavascriptInterface
        public void share(final String text) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Intent i = new Intent(Intent.ACTION_SEND);
                    i.setType("text/plain");
                    i.putExtra(Intent.EXTRA_TEXT, text);
                    try {
                        startActivity(Intent.createChooser(i, "Share"));
                    } catch (Exception ignored) {
                    }
                }
            });
        }

        @JavascriptInterface
        public void toast(final String msg) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public String version() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "?";
            }
        }
    }
}
