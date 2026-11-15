package com.cybnate.app;

import android.app.Activity;
import android.content.Intent;

import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.Scope;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * "Sign in with Google" for one set of scopes, through Google Play services.
 * Google recognises the app by its package name and signing certificate (the Android OAuth client
 * in the Google Cloud project), so no client secret lives in the app. The answer is a short-lived
 * access token; asking again later returns a fresh one without showing a screen.
 */
final class GoogleAuth {
    static final int REQUEST = 7302;

    interface Callback {
        void result(String id, String json);
    }

    private final Activity activity;
    private final Callback callback;
    private String pending;

    GoogleAuth(Activity activity, Callback callback) {
        this.activity = activity;
        this.callback = callback;
    }

    /** Must run on the UI thread. With silent=true no consent screen is shown. */
    void start(final String id, String scopesJson, final boolean silent) {
        try {
            JSONArray arr = new JSONArray(scopesJson);
            List<Scope> scopes = new ArrayList<>();
            for (int i = 0; i < arr.length(); i++) scopes.add(new Scope(arr.getString(i)));
            AuthorizationRequest req = AuthorizationRequest.builder().setRequestedScopes(scopes).build();
            Identity.getAuthorizationClient(activity).authorize(req)
                    .addOnSuccessListener(activity, r -> {
                        if (r.hasResolution() && r.getPendingIntent() != null) {
                            if (silent) {
                                fail(id, "needs_ui", "Google wants you to sign in again.");
                                return;
                            }
                            if (pending != null) fail(pending, "cancelled", "Replaced by a newer sign-in.");
                            pending = id;
                            try {
                                activity.startIntentSenderForResult(r.getPendingIntent().getIntentSender(), REQUEST, null, 0, 0, 0);
                            } catch (Exception e) {
                                pending = null;
                                fail(id, "error", String.valueOf(e));
                            }
                        } else {
                            ok(id, r);
                        }
                    })
                    .addOnFailureListener(activity, e -> fail(id, codeOf(e), String.valueOf(e.getMessage())));
        } catch (Throwable t) {
            fail(id, "error", String.valueOf(t));
        }
    }

    void onActivityResult(int resultCode, Intent data) {
        String id = pending;
        pending = null;
        if (id == null) return;
        if (data == null) {
            fail(id, "cancelled", "Sign-in was closed.");
            return;
        }
        try {
            ok(id, Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data));
        } catch (ApiException e) {
            fail(id, resultCode == Activity.RESULT_OK ? codeOf(e) : "cancelled", String.valueOf(e.getMessage()));
        } catch (Throwable t) {
            fail(id, "error", String.valueOf(t));
        }
    }

    private static String codeOf(Exception e) {
        return e instanceof ApiException ? String.valueOf(((ApiException) e).getStatusCode()) : "error";
    }

    private void ok(String id, AuthorizationResult r) {
        try {
            String token = r.getAccessToken();
            if (token == null || token.isEmpty()) {
                fail(id, "error", "Google returned no access token.");
                return;
            }
            JSONObject o = new JSONObject();
            o.put("ok", true);
            o.put("token", token);
            JSONArray granted = new JSONArray();
            if (r.getGrantedScopes() != null) for (String s : r.getGrantedScopes()) granted.put(s);
            o.put("scopes", granted);
            callback.result(id, o.toString());
        } catch (Throwable t) {
            fail(id, "error", String.valueOf(t));
        }
    }

    private void fail(String id, String code, String message) {
        try {
            JSONObject o = new JSONObject();
            o.put("ok", false);
            o.put("code", code);
            o.put("error", message);
            callback.result(id, o.toString());
        } catch (Exception ignored) {
        }
    }
}
