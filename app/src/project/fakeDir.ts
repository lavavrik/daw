// Test helper (not a test): an in-memory directory handle for fsFolder / session tests.
// A minimal in-memory FileSystemDirectoryHandle (the parts fsFolder uses),
// logging every completed write / move / remove in order.
export class FakeFile {
  readonly kind = 'file';
  constructor(public name: string, public parent: FakeDir, public data = new Uint8Array(0)) {}
  async getFile() {
    const d = this.data;
    return { size: d.length, arrayBuffer: async () => d.slice().buffer, text: async () => new TextDecoder().decode(d) };
  }
  async createWritable() {
    const chunks: Uint8Array[] = [];
    const root = this.parent.root();
    return {
      write: async (v: ArrayBuffer | string | Uint8Array) => {
        if (root.failOn && this.name === root.failOn) throw new Error(`disk full writing ${this.name}`);
        if (root.failOnPath && `${this.parent.path()}${this.name}` === root.failOnPath) throw new Error(`disk full writing ${root.failOnPath}`);
        root.chunks++;
        chunks.push(typeof v === 'string' ? new TextEncoder().encode(v) : new Uint8Array(v instanceof Uint8Array ? v : v));
      },
      close: async () => {
        const n = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) (out.set(c, o), (o += c.length));
        this.data = out;
        root.log.push(`write ${this.parent.path()}${this.name}`);
      },
    };
  }
  async move(dir: FakeDir, name: string) {
    if (this.parent.root().noMove) throw Object.assign(new Error('move not supported'), { name: 'NotSupportedError' });
    this.parent.files.delete(this.name);
    dir.files.set(name, this);
    this.parent.root().log.push(`move ${this.name} -> ${name}`);
    this.name = name;
    this.parent = dir;
  }
}

export class FakeDir {
  readonly kind = 'directory';
  files = new Map<string, FakeFile | FakeDir>();
  log: string[] = [];
  failOn: string | null = null;
  /** Like failOn, but only for this full path ("autosave/autosave.json"). */
  failOnPath: string | null = null;
  /** removeEntry of this name throws. */
  failRemove: string | null = null;
  /** Number of write() calls (chunked writes), not logged. */
  chunks = 0;
  noMove = false;
  constructor(public name = 'proj', public parentDir: FakeDir | null = null) {}
  root(): FakeDir {
    return this.parentDir ? this.parentDir.root() : this;
  }
  path(): string {
    return this.parentDir ? `${this.parentDir.path()}${this.name}/` : '';
  }
  async getDirectoryHandle(name: string, o: { create?: boolean } = {}) {
    let d = this.files.get(name);
    if (!d && o.create) this.files.set(name, (d = new FakeDir(name, this)));
    if (!(d instanceof FakeDir)) throw Object.assign(new Error(`no dir ${name}`), { name: 'NotFoundError' });
    return d;
  }
  async getFileHandle(name: string, o: { create?: boolean } = {}) {
    let f = this.files.get(name);
    if (!f && o.create) this.files.set(name, (f = new FakeFile(name, this)));
    if (!(f instanceof FakeFile)) throw Object.assign(new Error(`no file ${name}`), { name: 'NotFoundError' });
    return f;
  }
  async isSameEntry(o: unknown) {
    return o === this;
  }
  /** Test setup: a file with these bytes/text (no log entry). */
  put(name: string, data: string | number[]) {
    const f = new FakeFile(name, this, typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data));
    this.files.set(name, f);
    return f;
  }
  async removeEntry(name: string) {
    if (this.root().failRemove === name) throw new Error(`cannot remove ${name}`);
    this.files.delete(name);
    this.root().log.push(`remove ${this.path()}${name}`);
  }
  async *entries(): AsyncGenerator<[string, FakeFile | FakeDir]> {
    for (const e of [...this.files.entries()]) yield e;
  }
}

export const asDir = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;
export const bytes = (...v: number[]) => new Uint8Array(v).buffer;

/**
 * A minimal Web Locks manager (navigator.locks): exclusive, FIFO per name,
 * `ifAvailable` gets null when held. A lock is held until the callback's
 * promise settles. Shared by "tabs" in a test.
 */
export class FakeLocks {
  private held = new Set<string>();
  private waiting = new Map<string, (() => void)[]>();
  /** Every request, in order. */
  requests: string[] = [];
  async request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: { name: string } | null) => unknown): Promise<unknown> {
    this.requests.push(name);
    if (opts.ifAvailable && this.held.has(name)) return cb(null);
    while (this.held.has(name)) {
      await new Promise<void>((r) => {
        const q = this.waiting.get(name) ?? [];
        q.push(r);
        this.waiting.set(name, q);
      });
    }
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
      this.waiting.get(name)?.shift()?.();
    }
  }
}
