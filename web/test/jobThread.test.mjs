import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/components/JobThread.tsx'), 'utf8');
const workerPanel = fs.readFileSync(path.join(root, 'src/components/WorkerPanel.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

assert.match(source, /useState\(false\)/, 'execution process must be hidden by default');
assert.match(source, />查看执行过程</, 'compact task row must expose the execution viewer');
assert.match(source, /createPortal\(/, 'full-screen viewer must escape the clipped task card');
assert.match(source, /role="dialog"/);
assert.match(source, /aria-modal="true"/);
assert.match(source, /event\.key === 'Escape'/, 'Escape must close the full-screen viewer');
assert.match(styles, /\.job-thread\s*\{[\s\S]*?flex-shrink:\s*0;/, 'task row must not collapse inside the message flex column');
assert.match(styles, /\.job-execution-overlay\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/);
assert.match(styles, /\.job-execution-scroll\s*\{[\s\S]*?overflow-y:\s*auto;/);

assert.match(workerPanel, /useState<string \| null>\(null\)/, 'WorkerPanel execution viewer must be hidden by default');
assert.match(workerPanel, /createPortal\(/, 'WorkerPanel execution viewer must escape the panel layout');
assert.match(workerPanel, /aria-label="PC Worker 任务执行过程"/);
assert.match(workerPanel, />查看执行过程</, 'WorkerPanel task cards must expose the full-screen viewer');
assert.match(workerPanel, /event\.key === 'Escape'\) setSelectedId\(null\)/, 'WorkerPanel full-screen viewer must close on Escape');
assert.match(workerPanel, /className="job-execution-scroll"/, 'WorkerPanel logs must use the full-screen scroll container');

console.log('job thread execution viewer checks passed');
