// The export's dedicated Worker (docs/architecture/export.md): one render
// per Worker instance; exportSong terminates it when done or cancelled.
// All the work is in render.ts (renderService: the render request, then the
// page's acks for the streamed parts), which the tests run directly.
import { renderService } from './render';
import type { WorkerReply } from './render';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(m: WorkerReply, transfer?: Transferable[]): void;
};
const service = renderService((reply, transfer) => scope.postMessage(reply, transfer ?? []));
scope.onmessage = (e) => service(e.data);
