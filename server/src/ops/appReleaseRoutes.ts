import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const releaseUrl = z.string().refine(
  (value) => value === '' || /^\/releases\/[a-zA-Z0-9._-]+$/.test(value),
  'release URL must point to /releases/<file>',
);

export const appReleaseManifestSchema = z.object({
  webVersion: z.string().min(1),
  nativeVersion: z.string().min(1),
  minNativeVersion: z.string().min(1),
  webBundleUrl: releaseUrl.refine(Boolean, 'web bundle URL is required'),
  webBundleSha256: hash,
  apkUrl: releaseUrl.default(''),
  apkSha256: z.union([hash, z.literal('')]).default(''),
  releaseNotes: z.string().default(''),
  publishedAt: z.string().datetime().optional(),
}).superRefine((value, ctx) => {
  if (Boolean(value.apkUrl) !== Boolean(value.apkSha256)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['apkUrl'],
      message: 'apkUrl and apkSha256 must either both be set or both be empty',
    });
  }
});

export type AppReleaseManifest = z.infer<typeof appReleaseManifestSchema>;

export function readAppReleaseManifest(releasesDir: string): AppReleaseManifest {
  const file = path.join(releasesDir, 'latest.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  return appReleaseManifestSchema.parse(raw);
}

export function appReleaseRouter(releasesDir: string): Router {
  const router = Router();

  router.get('/latest', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      res.json(readAppReleaseManifest(releasesDir));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'No app release has been published yet.' });
        return;
      }
      res.status(503).json({
        error: 'The app release manifest is invalid.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return router;
}
