# Firebase Android setup — CybNate

## Selected Firebase project

The owner supplied and confirmed the Android configuration for:

- Project name: CybNate
- Project ID: `cybnate-ced02`
- Project number: `817862544`
- Android application ID: `com.cybnate.app`
- Android Firebase App ID: `1:817862544:android:87d8da99c6e63f55f74515`

The config file is stored at `app/google-services.json`, the app module root required by the Firebase Android setup guide. The package name matches `applicationId` and `namespace` in `app/build.gradle`.

## Android SDK wiring

- Google Services Gradle plugin: `4.6.0`
- Firebase Android BoM: `35.2.0`
- SDK modules declared: Authentication, Cloud Firestore, Cloud Storage, Cloud Messaging.
- Firebase SDK versions are managed through the BoM.
- A Node regression test checks the project ID, project number, app ID, package name and Gradle wiring.

## What this does not mean yet

This change wires the Firebase Android SDKs into the build. It does not create or enable Firebase products in the Firebase Console, create Firestore rules/database, provision Storage, enable Authentication providers, or configure FCM delivery.

The existing `GoogleAuth.java` uses Google Play services AuthorizationClient for Google API scopes. That is not Firebase Authentication. The supplied JSON currently has no OAuth client entries, so Google-to-Firebase sign-in must not be assumed ready. Configure and test the intended sign-in provider in the Firebase/Google Cloud console before connecting it to Firebase Auth.

No service activation, billing change, Firebase console mutation, deployment, or production change was made. Do not add service-account private keys or other private credentials to this repository.

## Verification

- `tests/firebase-config.test.js` validates the checked-in config and dependency declarations without printing API key material.
- GitHub Actions builds the release APK and runs the Android emulator self-test. A successful APK build does not prove that Console-side products or runtime permissions are configured.
