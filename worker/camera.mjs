import { spawn } from 'node:child_process';

const MAX_FRAME_BYTES = Math.floor(1.4 * 1024 * 1024);

export function buildFfmpegArgs(device) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'dshow',
    '-i', `video=${device}`,
    '-frames:v', '1',
    '-q:v', '5',
    '-f', 'mjpeg',
    'pipe:1',
  ];
}

export function cameraCapabilities(cfg) {
  return cfg?.allowCamera === true && typeof cfg.cameraDevice === 'string' && cfg.cameraDevice.trim()
    ? { camera: true }
    : {};
}

export function captureFrame(cfg, runtime = {}) {
  const spawnFn = runtime.spawn ?? spawn;
  const device = typeof cfg?.cameraDevice === 'string' ? cfg.cameraDevice.trim() : '';
  if (!device) return Promise.reject(new Error('cameraDevice is not configured'));
  const command = cfg.ffmpegCommand ?? 'ffmpeg';
  const args = buildFfmpegArgs(device);
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error('ffmpeg capture timed out after 15 seconds'));
    }, 15_000);
    timer.unref?.();
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_FRAME_BYTES) {
        child.kill('SIGTERM');
        finish(new Error('ffmpeg frame exceeds 1.4MB'));
        return;
      }
      stdout.push(bytes);
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + Buffer.from(chunk).toString('utf8')).slice(-4000);
    });
    child.once('error', (error) => finish(error));
    child.once('close', (code) => {
      if (code !== 0) {
        finish(new Error(`ffmpeg exited ${code}: ${stderr.trim() || 'no stderr'}`));
        return;
      }
      const frame = Buffer.concat(stdout);
      if (frame.length < 2 || frame[0] !== 0xff || frame[1] !== 0xd8) {
        finish(new Error('ffmpeg returned an empty or non-JPEG frame'));
        return;
      }
      finish(null, frame);
    });
  });
}

export async function handleSnapRequest(cfg, snapRequest, post, capture = captureFrame) {
  if (cameraCapabilities(cfg).camera !== true) return false;
  const requestId = typeof snapRequest?.id === 'string' ? snapRequest.id : '';
  if (!requestId) return false;
  let payload;
  try {
    const frame = await capture(cfg);
    payload = { imageBase64: frame.toString('base64') };
  } catch (error) {
    payload = { error: error instanceof Error ? error.message : String(error) };
  }
  await post(requestId, payload);
  return true;
}
