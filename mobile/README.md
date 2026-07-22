# Android companion app

The Capacitor shell packages `web/dist` and connects to a remote AI Hub. Dependencies are locked by
`mobile/package-lock.json`; the separately invoked icon generator is pinned explicitly to
`@capacitor/assets@3.0.5` in CI.

## Repeatable signing

Unsigned configuration uses a fresh ephemeral key for every CI run, so its APK cannot upgrade an APK
from a different run. For stable upgrades, configure all four GitHub Actions secrets:

- `ANDROID_KEYSTORE_B64`: base64-encoded keystore file
- `ANDROID_KEYSTORE_PASSWORD`: keystore password
- `ANDROID_KEY_ALIAS`: alias of the signing key
- `ANDROID_KEY_PASSWORD`: password for that key (it may differ from the keystore password)

The workflow fails closed when only part of this set is configured. The keystore and passwords are not
included in the APK artifact.
