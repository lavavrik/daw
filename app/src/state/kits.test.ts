// The built-in kits' data (state/kits.ts) and their generated files
// (scripts/make-kits.mjs): every kit has all eight roles, the files exist and
// are bundled, the generator is deterministic (its output hashes are pinned
// here, and the files on disk are its output), and the files fit the budget.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_KIT } from './defaultKit';
import { KITS, KIT_ROLES, STARTER_KIT_ID, kitById, rowHasRole } from './kits';
import { KIT_FILE_URLS, kitFileName, kitFileUrl, kitSample } from '../library/kitFiles';

const ROOT = join(__dirname, '..', '..', '..');
const KITS_DIR = join(ROOT, 'samples', 'kits');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** scripts/make-kits.mjs output (sha256 per "<kit>/<file>"). Regenerate with `node scripts/make-kits.mjs --hashes` when a recipe changes on purpose. */
const HASHES: Record<string, string> = {
  'drum-machine/kick.wav': 'd766f14522ab7ccf9aecd35778d5adbade0d01c48b6bca35e8e98509c5571208',
  'drum-machine/clap.wav': 'fc2221e7b191399210f5a8f9ac75d1123c28b31664d15502251d16c00fbb4f8e',
  'drum-machine/closed-hat.wav': '8516333099be43eda1b4e682c49a2c22e23bcc935de194986044c789a602bb70',
  'drum-machine/open-hat.wav': 'ecbc47e10c95d36afccdaa148f1bfd59e70d54697ebdbccc0b63184de6b413f2',
  'drum-machine/snare.wav': '46986fd84ec31a2e47fafe7a8e87cc47a5bba40a887807906085e873f87a6ab0',
  'drum-machine/rim.wav': '0b7d9f84d2611029e1ba99927a4f62aaef421e1a39639ec326e697ca2939bafd',
  'drum-machine/shaker.wav': 'cea487613ad324cd8a53247fd932c708987f68fcdcf8c5cbf9171f2a5d444374',
  'drum-machine/perc.wav': '9bb379574975dff4fe1518d5be52eecd3a35433db6f1b70bd3401eed3cb7351b',
  'deep/kick.wav': '8631898cfc55e433f7404cbd985bbd3124d1ad8a035239120ad0af28a0432eb3',
  'deep/clap.wav': 'cbc231a0993bce27c7db34ee42d220a0d6a0c2fa63f8c00d210dc684755b0752',
  'deep/closed-hat.wav': '46e3f2ed615110144d69e2feab9312d93d2dc2157a46fd6e921ebcd5813e2308',
  'deep/open-hat.wav': '5d9d406898b7f0d64d78cd43841583c21fe8b4a3aaa762c22b600809540b4440',
  'deep/snare.wav': '0801e21eb83390c6b5b75c07e83c0df60f68b1f4495443b2240764a97f0d3401',
  'deep/rim.wav': '8d4836cee91c75403a70872ddb64638345b54065e0429276656215e79a54ef39',
  'deep/shaker.wav': 'b85abb0cc4725a67a23a52ef964f2c3c776100056cd6546cf0691af772484ddb',
  'deep/perc.wav': '358778e9c94e0a44648ed3dafd470012d4ff97c5bbb55a8f3d2f439067d43c17',
  'garage/kick.wav': 'a06ee3fa3dba3ab1755480e0181767002f66ae81cafd821c72757aa95cc2ac15',
  'garage/clap.wav': 'b7a2b077d4751e1d60f81a531f1fef004989a5df682b9f8e287feb33f5eaa2bf',
  'garage/closed-hat.wav': 'ec5f53dbd7c6f9db7de3b5af764ba8265ec8a7c4aff420247c11adb0f89b8a02',
  'garage/open-hat.wav': '650ed2bfddd68680a1fdb377f5a17018287f6d9b7debf4ccb6ea533de46a7c08',
  'garage/snare.wav': '725c0ae34bc0b6e2bd147821ff442f110a65a76005b5de930331af7eb6b26273',
  'garage/rim.wav': 'f804ec7e3c6d24a3450054f1cf67c189795016fd23a33adc9f980a79ad16928f',
  'garage/shaker.wav': '76a60da1788204c90d09f602cf84dad2ba3af47e63a73a5f865711380cc384ab',
  'garage/perc.wav': '45e66c4f2ff2849b7b7db726c92421accae1863c57a1ab53e5635e75015f4825',
  'dusty/kick.wav': 'bd56bc0605e1f41b94448c8abeb322db79f2583fd7d822a0b5590acfed96efbe',
  'dusty/clap.wav': 'b9d1007aa9e209cfeac0ce978e0a7c59d5b6102b666c5d88abcb36ee38b978c7',
  'dusty/closed-hat.wav': '94bb28cf4e3960634d79aa8132b7c47c04058b34f6301682ad745766e3c6a32d',
  'dusty/open-hat.wav': 'd07d3a025300ba3880d3c81a4d1b33736fa42f780ac660c79572a90a7ddfefb6',
  'dusty/snare.wav': '3e83c5b6b823c6d6fad6dd07d2e0f08d18569edff342732437a32bf53daf7ff1',
  'dusty/rim.wav': '66c46e75bca116ba5a4068f547568e5a0555790436421e4bbbc14599e1edfe5a',
  'dusty/shaker.wav': 'cb54690fa1fbc0d6b505b4bcc652bf50183264fe9dac3860525bf45f3edb0df4',
  'dusty/perc.wav': 'cc53f41fb736c05e93cc58cb8cb8bec4ebe5bad8606ce7852ba0c7bbc86b3322',
};

describe('KITS', () => {
  it('the starter kit first, then the four generated kits', () => {
    expect(KITS.map((k) => k.id)).toEqual([STARTER_KIT_ID, 'drum-machine', 'deep', 'garage', 'dusty']);
    expect(KITS.map((k) => k.name)).toEqual(['Starter kit', 'Drum Machine', 'Deep', 'Garage', 'Dusty']);
    expect(kitById('garage')?.name).toBe('Garage');
    expect(kitById('nope')).toBeUndefined();
  });

  it('every kit has all eight roles, in order, with a name and a file each', () => {
    for (const k of KITS) {
      expect(k.rows.map((r) => r.role)).toEqual([...KIT_ROLES]);
      for (const r of k.rows) expect([r.name.length > 0, r.file.endsWith('.wav')]).toEqual([true, true]);
    }
  });

  it('the roles are the default drum track rows: DEFAULT_KIT is the starter kit by role', () => {
    expect(KIT_ROLES).toEqual(['Kick', 'Clap', 'Closed hat', 'Open hat', 'Snare', 'Rim', 'Shaker', 'Perc']);
    expect(DEFAULT_KIT).toEqual(KITS[0].rows.map((r) => ({ name: r.role, file: r.file })));
  });

  it('rowHasRole ignores case and surrounding spaces, nothing else', () => {
    expect(rowHasRole(' closed HAT ', 'Closed hat')).toBe(true);
    expect(rowHasRole('Kick 2', 'Kick')).toBe(false);
  });

  it('every kit file is bundled (library/kitFiles.ts) and on disk', () => {
    for (const k of KITS) {
      for (const r of k.rows) {
        expect(kitFileUrl(k.id, r.file), `${k.id}/${r.file}`).toBeTruthy();
        const dir = k.id === STARTER_KIT_ID ? join(ROOT, 'samples', 'starter') : join(KITS_DIR, k.id);
        expect(statSync(join(dir, r.file)).size).toBeGreaterThan(1000);
      }
    }
    expect(Object.keys(KIT_FILE_URLS).sort()).toEqual(KITS.slice(1).flatMap((k) => k.rows.map((r) => `${k.id}/${r.file}`)).sort());
  });
});

describe('kit files (library/kitFiles.ts)', () => {
  const table = { 'garage/kick.wav': '/k/garage-kick' };
  const fetch = async (url: string) => (url === '/k/garage-kick' ? new Uint8Array([7, 7]).buffer : Promise.reject(new Error('HTTP 404')));

  it('a generated kit file comes as "<kit>-<file>"; a starter file keeps its name', async () => {
    const f = await kitSample('garage', 'kick.wav', table, fetch);
    expect([f.name, f.type]).toEqual(['garage-kick.wav', 'audio/wav']);
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(new Uint8Array([7, 7]));
    expect(kitFileName(STARTER_KIT_ID, 'clap.wav')).toBe('clap.wav');
  });

  it('a file not in the kit rejects with a message naming it', async () => {
    await expect(kitSample('garage', 'nope.wav', table, fetch)).rejects.toThrow('"nope.wav" is not in the "garage" kit');
  });
});

describe('scripts/make-kits.mjs', () => {
  // Run once, inside the tests (not at collection: a failing script then
  // fails these two tests instead of dropping the whole file). The pinned
  // hashes rely on V8's bit-exact Math.sin / exp / tanh; after a Node upgrade
  // that changes one, regenerate (`node scripts/make-kits.mjs`, then
  // `--hashes` into HASHES) and listen to the kits.
  let generated: Record<string, string> | null = null;
  const generate = () =>
    (generated ??= JSON.parse(execFileSync('node', [join(ROOT, 'scripts', 'make-kits.mjs'), '--hashes'], { encoding: 'utf8' })) as Record<string, string>);

  it('is deterministic: its output matches the pinned hashes', () => {
    expect(generate()).toEqual(HASHES);
  });

  it('the files on disk are its output (re-run it after changing a recipe)', () => {
    for (const [path, hash] of Object.entries(generate())) expect(sha(readFileSync(join(KITS_DIR, path))), path).toBe(hash);
  });

  it('48 kHz 16-bit mono WAVs, all kits together under 3 MB, with a CC0 licence', () => {
    let total = 0;
    for (const kit of readdirSync(KITS_DIR).filter((d) => statSync(join(KITS_DIR, d)).isDirectory())) {
      for (const f of readdirSync(join(KITS_DIR, kit))) {
        const b = readFileSync(join(KITS_DIR, kit, f));
        expect([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)], `${kit}/${f}`).toEqual([1, 1, 48000, 16]);
        total += b.length;
      }
    }
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(3 * 1024 * 1024);
    expect(readFileSync(join(KITS_DIR, 'LICENSE.txt'), 'utf8')).toContain('CC0');
  });
});
