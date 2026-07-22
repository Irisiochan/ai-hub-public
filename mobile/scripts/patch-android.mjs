// `cap add android` 生成的原生工程不进 git，每次 CI 现生成后由本脚本打补丁：
// - manifest：允许 http 明文访问 Tailscale 内网网关、通知权限、键盘 adjustResize
// - app/build.gradle：versionName 对齐 package.json、注入环境变量驱动的 release 签名
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
const gradlePath = path.join(root, 'android/app/build.gradle');
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
if (!manifest.includes('android:windowSoftInputMode')) {
  manifest = manifest.replace(
    /<activity\b/,
    '<activity\n            android:windowSoftInputMode="adjustResize"'
  );
}
fs.writeFileSync(manifestPath, manifest);
console.log('patched AndroidManifest.xml');

let gradle = fs.readFileSync(gradlePath, 'utf8');

gradle = gradle.replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);

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
console.log(`patched app/build.gradle (versionName ${pkg.version})`);
