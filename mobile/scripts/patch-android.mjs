// `cap add android` 生成的原生工程不进 git，每次 CI 现生成后由本脚本打补丁：
// - manifest：允许 http 内网、通知、APK 安装、FileProvider、键盘 adjustResize
// - app/build.gradle：versionName/versionCode 对齐 package.json、注入 release 签名
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
const gradlePath = path.join(root, 'android/app/build.gradle');
const pathsXmlPath = path.join(root, 'android/app/src/main/res/xml/file_paths.xml');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let manifest = fs.readFileSync(manifestPath, 'utf8');

if (!manifest.includes('android:usesCleartextTraffic')) {
  manifest = manifest.replace('<application', '<application\n        android:usesCleartextTraffic="true"');
}
if (!manifest.includes('android.permission.POST_NOTIFICATIONS')) {
  manifest = manifest.replace(
    '</manifest>',
    '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />\n</manifest>'
  );
}
if (!manifest.includes('android.permission.REQUEST_INSTALL_PACKAGES')) {
  manifest = manifest.replace(
    '</manifest>',
    '    <uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />\n</manifest>'
  );
}
if (!manifest.includes('androidx.core.content.FileProvider')) {
  manifest = manifest.replace(
    '</application>',
    `        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
    </application>`
  );
}
if (!manifest.includes('android:windowSoftInputMode')) {
  manifest = manifest.replace(
    /<activity\b/,
    '<activity\n            android:windowSoftInputMode="adjustResize"'
  );
}
fs.writeFileSync(manifestPath, manifest);
console.log('patched AndroidManifest.xml');

fs.mkdirSync(path.dirname(pathsXmlPath), { recursive: true });
fs.writeFileSync(pathsXmlPath, `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <files-path name="private-files" path="." />
</paths>
`);
console.log('wrote res/xml/file_paths.xml');

let gradle = fs.readFileSync(gradlePath, 'utf8');

const [major = 0, minor = 0, patch = 0] = pkg.version.split('.').map((part) => Number.parseInt(part, 10) || 0);
const versionCode = major * 1_000_000 + minor * 1_000 + patch;
if (versionCode < 1 || versionCode > 2_100_000_000) {
  throw new Error(`package.json version cannot produce a valid Android versionCode: ${pkg.version}`);
}

gradle = gradle.replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
gradle = gradle.replace(/versionCode \d+/, `versionCode ${versionCode}`);

if (!gradle.includes('signingConfigs')) {
  // 顺序要紧：先给 buildTypes.release 挂 signingConfig（此时全文件唯一的
  // `release {` 就是它），再往前面插 signingConfigs 块。
  gradle = gradle.replace(
    /release \{/,
    `release {
            if (System.getenv("ANDROID_KEYSTORE_FILE")) signingConfig signingConfigs.release`
  );
  gradle = gradle.replace(
    /(\n\s*)buildTypes \{/,
    `$1signingConfigs {
        release {
            if (System.getenv("ANDROID_KEYSTORE_FILE")) {
                storeFile file(System.getenv("ANDROID_KEYSTORE_FILE"))
                storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")
                keyAlias System.getenv("ANDROID_KEY_ALIAS")
                keyPassword System.getenv("ANDROID_KEY_PASSWORD")
            }
        }
    }$1buildTypes {`
  );
}
fs.writeFileSync(gradlePath, gradle);
console.log(`patched app/build.gradle (versionName ${pkg.version}, versionCode ${versionCode})`);
