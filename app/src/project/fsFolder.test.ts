import { describe, expect, it } from 'vitest';
import { readProject, writeProject } from './fsFolder';

// A minimal in-memory FileSystemDirectoryHandle (the parts fsFolder uses),
// logging every completed write / move / remove in order.
class FakeFile {
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

class FakeDir {
  readonly kind = 'directory';
  files = new Map<string, FakeFile | FakeDir>();
  log: string[] = [];
  failOn: string | null = null;
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
  async removeEntry(name: string) {
    this.files.delete(name);
    this.root().log.push(`remove ${this.path()}${name}`);
  }
  async *entries(): AsyncGenerator<[string, FakeFile | FakeDir]> {
    for (const e of [...this.files.entries()]) yield e;
  }
}

const asDir = (d: FakeDir) => d as unknown as FileSystemDirectoryHandle;
const bytes = (...v: number[]) => new Uint8Array(v).buffer;
const json1 = { schemaVersion: 1, name: 'A', samples: [{ id: 0, file: 'samples/0-kick.wav' }] };

describe('fsFolder', () => {
  it('writeProject writes samples, then project.json.tmp, then project.json', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1, 2, 3)]]));
    expect(dir.log).toEqual(['write samples/0-kick.wav', 'write project.json.tmp', 'move project.json.tmp -> project.json']);
    const back = await readProject(asDir(dir));
    expect(back.json).toEqual(json1);
    expect([...back.files.keys()]).toEqual(['samples/0-kick.wav']);
    expect(new Uint8Array(back.files.get('samples/0-kick.wav')!)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('copies when the handle cannot move, and removes stale samples last', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1)]]));
    dir.log = [];
    dir.noMove = true;
    const json2 = { schemaVersion: 1, name: 'B', samples: [{ id: 0, file: 'samples/0-snare.wav' }] };
    const noMove = new Map([['samples/0-snare.wav', bytes(2)]]);
    await writeProject(asDir(dir), json2, noMove);
    expect(dir.log).toEqual([
      'write samples/0-snare.wav', 'write project.json.tmp', 'write project.json', 'remove project.json.tmp',
      'remove samples/0-kick.wav',
    ]);
    expect((await readProject(asDir(dir))).json).toEqual(json2);
  });

  it('an interrupted write leaves the previous project readable', async () => {
    const dir = new FakeDir();
    await writeProject(asDir(dir), json1, new Map([['samples/0-kick.wav', bytes(1)]]));
    dir.failOn = '1-hat.wav';
    const json2 = { schemaVersion: 1, name: 'B', samples: [{ id: 1, file: 'samples/1-hat.wav' }] };
    await expect(writeProject(asDir(dir), json2, new Map([['samples/1-hat.wav', bytes(9)]]))).rejects.toThrow(/disk full/);
    const back = await readProject(asDir(dir));
    expect(back.json).toEqual(json1);
    expect(back.files.has('samples/0-kick.wav')).toBe(true);
  });

  it('readProject explains a folder without a project', async () => {
    await expect(readProject(asDir(new FakeDir()))).rejects.toThrow(/project\.json/);
    const dir = new FakeDir();
    const f = await dir.getFileHandle('project.json', { create: true });
    const w = await f.createWritable();
    await w.write('{nope');
    await w.close();
    await expect(readProject(asDir(dir))).rejects.toThrow(/not valid JSON/);
  });
});
