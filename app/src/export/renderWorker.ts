// The export's dedicated Worker (docs/architecture/export.md): one render
// per Worker instance; exportSong terminates it when done or cancelled.
// All the work is in render.ts (handleRenderMessage), which the tests run
// directly.
import { handleRenderMessage } from './render';
import type { WorkerReply } from './render';

const scope = self as unknown as { onmessage: ((e: MessageEvent) => void) | null; postMessage(m: WorkerReply): void };
scope.onmessage = (e) => handleRenderMessage(e.data, (reply) => scope.postMessage(reply));
