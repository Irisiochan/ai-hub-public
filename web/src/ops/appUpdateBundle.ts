interface BundleFilesystem {
  mkdir: (opts: {
    path: string;
    directory: 'DATA';
    recursive?: boolean;
  }) => Promise<void>;
  writeFile: (opts: {
    path: string;
    data: string;
    directory: 'DATA';
    recursive?: boolean;
  }) => Promise<{ uri: string }>;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function assertBundlePath(name: string): void {
  if (
    !name
    || name.startsWith('/')
    || name.includes('\\')
    || name.split('/').some((part) => part === '..' || part === '')
  ) {
    throw new Error(`更新包含不安全路径：${name || '(empty)'}`);
  }
}

export async function writeWebBundle(
  files: Record<string, Uint8Array>,
  relativeRoot: string,
  filesystem: BundleFilesystem,
): Promise<void> {
  const entries = Object.entries(files);
  const directories = new Set<string>([relativeRoot]);

  for (const [name] of entries) {
    assertBundlePath(name);
    const parts = name.split('/');
    parts.pop();
    for (let length = 1; length <= parts.length; length += 1) {
      directories.add(`${relativeRoot}/${parts.slice(0, length).join('/')}`);
    }
  }

  const orderedDirectories = [...directories].sort((left, right) => {
    const depth = left.split('/').length - right.split('/').length;
    return depth || left.localeCompare(right);
  });
  for (const path of orderedDirectories) {
    await filesystem.mkdir({ path, directory: 'DATA', recursive: true });
  }

  await Promise.all(entries.map(async ([name, data]) => {
    await filesystem.writeFile({
      path: `${relativeRoot}/${name}`,
      data: toBase64(data),
      directory: 'DATA',
    });
  }));
}
