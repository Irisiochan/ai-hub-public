import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/components/JobThread.tsx'), 'utf8');
const workerPanel = fs.readFileSync(path.join(root, 'src/components/WorkerPanel.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');

assert.match(source, /useState\(false\)/, 'execution process must be hidden by default');
assert.match(source, />查看执行过程</, 'compact task row must expose the execution viewer');
assert.match(source, /delivery_summary/, 'human delivery conclusion must be the primary task status');
assert.match(source, />展开内部状态与证据</, 'raw runner and delivery evidence must stay expandable');
assert.match(source, /createPortal\(/, 'full-screen viewer must escape the clipped task card');
assert.match(source, /role="dialog"/);
assert.match(source, /aria-modal="true"/);
assert.match(source, /event\.key === 'Escape'/, 'Escape must close the full-screen viewer');
assert.match(source, /job\.status === 'blocked'/, 'manual out-of-band completion must only be offered for blocked jobs');
assert.match(source, /标记已接力完成/, 'blocked jobs must expose the manual out-of-band completion action');
assert.match(source, /title: '标记已接力完成'/, 'manual out-of-band completion must require confirmation');
assert.match(styles, /\.job-thread\s*\{[\s\S]*?flex-shrink:\s*0;/, 'task row must not collapse inside the message flex column');
assert.match(styles, /\.job-execution-overlay\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/);
assert.match(styles, /\.job-execution-scroll\s*\{[\s\S]*?overflow-y:\s*auto;/);

assert.match(workerPanel, /useState<string \| null>\(null\)/, 'WorkerPanel execution detail must be empty until a job is selected');
assert.doesNotMatch(workerPanel, /createPortal\(/, 'WorkerPanel execution detail stays in the right pane, not a portal overlay');
assert.match(workerPanel, /aria-label="PC Worker 任务执行过程"/);
assert.match(workerPanel, />查看执行过程</, 'WorkerPanel task cards must expose the execution detail');
assert.match(workerPanel, /className="job-detail"/, 'WorkerPanel must render the right-pane detail host');
assert.match(workerPanel, /className="job-detail-scroll"/, 'WorkerPanel logs must scroll inside the right pane');
assert.match(workerPanel, /setSelectedId\(null\)/, 'WorkerPanel must be able to clear the selected job');
assert.match(workerPanel, /resolveSelectedOutOfBand/, 'WorkerPanel must expose manual out-of-band completion');
assert.match(workerPanel, /selected\.status === 'blocked'/, 'WorkerPanel action must only be offered for blocked jobs');

console.log('job thread execution viewer checks passed');
