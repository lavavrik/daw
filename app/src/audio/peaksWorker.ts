// The waveform-peaks Worker (audio/peaks.ts peaksInWorker): receives a
// sample's channel buffers (transferred), computes the peaks and transfers
// the channels back with them, so nothing is copied either way.
import { peaksWorkerReply } from './peaks';
import type { PeaksRequest } from './peaks';

const scope = self as unknown as { onmessage: ((e: MessageEvent<PeaksRequest>) => void) | null; postMessage(m: unknown, t: Transferable[]): void };
scope.onmessage = (e) => {
  const { msg, transfer } = peaksWorkerReply(e.data.channels);
  scope.postMessage(msg, transfer);
};
