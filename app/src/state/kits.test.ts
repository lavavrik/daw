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
  'drum-machine/kick.wav': '673b11b76187859b9fb8f276f1608b51c97a5880a28fc950cc70bbdaa6e74f67',
  'drum-machine/clap.wav': '781b1e0616afcba3f2432658e8b40223fa5d931f46d91f378d8067e5614a4ef7',
  'drum-machine/closed-hat.wav': 'b2061a4edbe83a4c30238787f1e8dbbfcf229374477c90b069533cdd673273cf',
  'drum-machine/open-hat.wav': 'b73d062e64a56ccf63ae4af394c3713da2280d9248bc9f057fbbdecab07a41af',
  'drum-machine/snare.wav': '17354627d4115ce73a99ceebc309d1edffd96fb4fe4618b5228b58bbd872cd62',
  'drum-machine/rim.wav': '9a8f566e4e6f9aa764102be98823c24c56afed3f60b3e81988952c7ce0e8f7de',
  'drum-machine/shaker.wav': '4b46382651ec33f207b26c999dc239179bccf1c7134efc136b7cc4058d3664ae',
  'drum-machine/perc.wav': '0f46ab4aeeba6ca280646bb55f1687b37ded5655b3dfa2d6a41836492d672bf2',
  'deep/kick.wav': 'b8511d071e3a43bbd6ae695b87cd408dac0e4c2efbefbaa8f85c7c2e69571ce3',
  'deep/clap.wav': 'c08ed1d9844754c1be1a5f21140b8007dcd8a53e0f239617a2f68e2ae2f35fcf',
  'deep/closed-hat.wav': '3034bb25c26d479d736b1238c2c39dce61eb29c7af7ab3f8937d3c535469aca1',
  'deep/open-hat.wav': 'b8d836df1053209526d013ae7d3f3ed8bed51b3c5f0ff64dd8bdfa17caf2d7b5',
  'deep/snare.wav': 'f3bcc4b28aec1a24166c2b0b9dd571f1570190814f38c9d58e0ccd8dd97c9a58',
  'deep/rim.wav': 'f0bd437a31796f04ca625abd1193e9b48d0f303518f80f9738a15a0fac34ea35',
  'deep/shaker.wav': '040571bed583c5869130e01e874fb808d3dec7c9176759441566ca640a60de1f',
  'deep/perc.wav': '3acb26adc0d7fff730ca288ec51f4696d36aa554624a2f42bc1ba294192f9494',
  'garage/kick.wav': '364319a9bf6e239e123eb2e2a0bce1838935689b05dec7fa2f7660c68dc2e530',
  'garage/clap.wav': '6c10ddda884ec64c7e74327cc5ca38fdd6e302132dff7fdb54783550e036397a',
  'garage/closed-hat.wav': '94d4162751a33047e2559e75a79d0407842cadf100bbacae16b72e28489573ea',
  'garage/open-hat.wav': '4b61ebb307e717e75cbc9b47d017d0b6ac2207ecd438aa5791b085c2ef5a9651',
  'garage/snare.wav': '6f5ca27a7bb9e8800746f60e01c35323a4c30015f5c7747b614e9579e635137f',
  'garage/rim.wav': '377b7b28b45045663f189de59491c45ab48d850ff2cd68dc4ea1db916a8981fc',
  'garage/shaker.wav': 'b9b98e11badb155609f96c9dc80af543a7cf17b08da19370cf7e49d1c6360bc7',
  'garage/perc.wav': '8b1a5239c2c6c049fdffaf34cf4f519a78a2e14698e10220e5f56ab562b0dd70',
  'dusty/kick.wav': 'a2c0bf4453ed515125d3689ee8252081daf5ed6f6f65e7fbdf9c34b9f53426a3',
  'dusty/clap.wav': '23f30f41f1b55466668986218187c7319f1e6859a9bd921bf930eeb0482d0660',
  'dusty/closed-hat.wav': '4673c3e255702d531fd3fe535be7fe21bb107fdba680e4e17ba25c89ba325618',
  'dusty/open-hat.wav': '129c6cc64e069684eb5501126e7b951869636e3f53d3a63af8bf0f2257671380',
  'dusty/snare.wav': '1f7328fe8af819af5ace3688e91cba636fb2da858e8c96015dac4e1ed2dd6ba7',
  'dusty/rim.wav': 'dc6c68791e67992da8155eaca8015a328c7df38091d1ca5cfba093968e174bd3',
  'dusty/shaker.wav': '4b563b25eabc39d1198ba9d4c51c72cc96a1be62153182a5bff6ad2ea5767f5d',
  'dusty/perc.wav': '981a2f169ad1a4e6186da5d322bf5a5c64634c83a962af72bfb882d4bd73f447',
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
  const generated = JSON.parse(execFileSync('node', [join(ROOT, 'scripts', 'make-kits.mjs'), '--hashes'], { encoding: 'utf8' })) as Record<string, string>;

  it('is deterministic: its output matches the pinned hashes', () => {
    expect(generated).toEqual(HASHES);
  });

  it('the files on disk are its output (re-run it after changing a recipe)', () => {
    for (const [path, hash] of Object.entries(generated)) expect(sha(readFileSync(join(KITS_DIR, path))), path).toBe(hash);
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
