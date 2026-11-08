//! C ABI: the AudioWorklet's only interface to the engine (no wasm-bindgen).
//!
//! The opaque handle is a `*mut Host`: the `Engine` plus the two output
//! buffers, heap-allocated once so the buffer pointers handed to JS stay valid
//! and stable for the whole instance lifetime.
//!
//! SAFETY contract (applies to every export): the worklet is single-threaded
//! and calls these functions sequentially, never re-entrantly, with either null
//! or a pointer previously returned by `engine_new` (never freed; the instance
//! lives as long as the worklet). Null is tolerated everywhere: exports return
//! null / `ERR_BAD_INDEX` / do nothing. No export panics.

use crate::protocol::ERR_BAD_INDEX;
use crate::{Engine, MAX_BLOCK};

pub struct Host {
    engine: Engine,
    left: [f32; MAX_BLOCK],
    right: [f32; MAX_BLOCK],
}

#[no_mangle]
pub extern "C" fn engine_new(sample_rate: f32) -> *mut Host {
    Box::into_raw(Box::new(Host {
        engine: Engine::new(sample_rate),
        left: [0.0; MAX_BLOCK],
        right: [0.0; MAX_BLOCK],
    }))
}

/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_out_left(e: *mut Host) -> *mut f32 {
    // SAFETY: see module contract; `as_mut` maps null to None.
    match unsafe { e.as_mut() } {
        Some(h) => h.left.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_out_right(e: *mut Host) -> *mut f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.right.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

/// Renders `min(frames, MAX_BLOCK)` frames into the out buffers.
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_process(e: *mut Host, frames: u32) {
    // SAFETY: see module contract.
    if let Some(h) = unsafe { e.as_mut() } {
        let n = (frames as usize).min(MAX_BLOCK);
        let Host { engine, left, right } = h;
        engine.process(&mut left[..n], &mut right[..n]);
    }
}

/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_command(e: *mut Host, op: u32, a: f64, b: f64, c: f64, d: f64) -> i32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.engine.command(op, a, b, c, d),
        None => ERR_BAD_INDEX,
    }
}

/// Null on error; the code is recorded in `TELEMETRY_LAST_ERROR` by the engine.
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_sample_alloc(e: *mut Host, id: u32, frames: u32, channels: u32) -> *mut f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.engine.sample_alloc(id, frames, channels).unwrap_or(core::ptr::null_mut()),
        None => core::ptr::null_mut(),
    }
}

/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_sample_ready(e: *mut Host, id: u32) -> i32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.engine.sample_ready(id),
        None => ERR_BAD_INDEX,
    }
}

/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_telemetry(e: *mut Host) -> *const f64 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.telemetry().as_ptr(),
        None => core::ptr::null(),
    }
}

/// `[MIX_CHANNELS × (peakL, peakR, gr_db)]` f32s, refreshed by every
/// `engine_process` (track/return peaks post-fader, the master's the final
/// output, gr = compressor / limiter gain reduction in dB). The pointer is
/// stable for the instance lifetime.
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_meters(e: *mut Host) -> *const f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.meters().as_ptr(),
        None => core::ptr::null(),
    }
}

/// The visual block (`vis::VisBlock`, `VIS_BLOCK_LEN` f32): the strip tap
/// (`tap_l`, `tap_r`: the tapped strip's post-fader output, first `frames`
/// of the last `engine_process`), `tap_ch` (−1 = off) and voice activity.
/// Refreshed by every `engine_process`; the pointer is stable for the
/// instance lifetime (offsets: `vis::VIS_*`, mirrored in visLayout.ts).
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_vis(e: *mut Host) -> *const f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.vis().as_ptr(),
        None => core::ptr::null(),
    }
}

/// The scope bank's rings (`VIS_SCOPES × VIS_SCOPE_RING × 4` f32: A min,
/// A max, B min, B max per entry; slot `s` at `s × VIS_SCOPE_RING × 4`,
/// entry `h` at `h mod VIS_SCOPE_RING`). Written by the Scope modules as
/// their racks render; the pointer is stable for the instance lifetime.
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_scopes(e: *mut Host) -> *const f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.scope_rings().as_ptr(),
        None => core::ptr::null(),
    }
}

/// The scope headers (`VIS_SCOPES × VIS_SCOPE_HDR` i32; fields
/// `rack::modules::scope::HDR_*`: owner track (−1 free), owner module,
/// head, decim, epoch, grid prev, grid last, flags). Stable pointer.
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_scope_hdr(e: *mut Host) -> *const i32 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.scope_hdrs().as_ptr(),
        None => core::ptr::null(),
    }
}

/// Output latency in frames (the master limiter's lookahead: 72 at 48 kHz);
/// constant for the instance. The worklet adds it to `TELEMETRY_FRAME` so
/// heard time matches what leaves the engine. 0 for a null handle.
///
/// # Safety
/// `e` must be null or a live pointer from `engine_new` (module contract above),
/// with no other access to `*e` for the call's duration.
#[no_mangle]
pub unsafe extern "C" fn engine_latency(e: *mut Host) -> u32 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.latency() as u32,
        None => 0,
    }
}

#[cfg(test)]
mod tests {
    // The exports are `unsafe fn`; each test body is one unsafe block (the
    // handle is valid or null by construction, used single-threaded).
    use super::*;
    use crate::protocol::{OP_ADD_SYNTH_TRACK, OP_RACK_ADD_MODULE, OP_RACK_CONNECT};
    use crate::{MIX_CHANNELS, MIX_MASTER, MIX_METER_STRIDE};

    #[test]
    fn ffi_roundtrip() {
      unsafe {
        let e = engine_new(48000.0);
        // Synth track 0: LFO (kind 6) at module 0 -> Out (kind 8) at module 1.
        assert_eq!(engine_command(e, OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_ADD_MODULE, 0.0, 0.0, 6.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_ADD_MODULE, 0.0, 1.0, 8.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_CONNECT, 0.0, 0.0, 16.0, 0.0), 0);
        engine_process(e, 128);
        let left = core::slice::from_raw_parts(engine_out_left(e), 128);
        assert!(left.iter().any(|&s| s != 0.0));
        let meters = engine_meters(e);
        let m = core::slice::from_raw_parts(meters, MIX_CHANNELS * MIX_METER_STRIDE);
        assert!(m[0] > 0.0, "track 0 peak L");
        let master = MIX_MASTER * MIX_METER_STRIDE;
        assert_eq!(m[master], left.iter().fold(0.0f32, |p, x| p.max(x.abs())), "master = output peak");
        let t = core::slice::from_raw_parts(engine_telemetry(e), 8);
        assert_eq!(t[0], 1.0);
        engine_process(e, 100_000); // clamped, must not panic
        assert_eq!(engine_meters(e), meters, "stable pointer");
        assert_eq!(engine_latency(e), 72, "1.5 ms lookahead at 48 kHz");
        // The visual block: stable, the tap channel -1 (off) at start.
        let vis = engine_vis(e);
        assert!(!vis.is_null());
        assert_eq!(*vis.add(crate::vis::VIS_TAP_CH), -1.0);
        engine_process(e, 128);
        assert_eq!(engine_vis(e), vis, "stable pointer");
        // The scope bank: a Scope (kind 18) at module 2 of track 0, fed by
        // the LFO, stamps its slot and writes entries.
        let (rings, hdr) = (engine_scopes(e), engine_scope_hdr(e));
        assert!(!rings.is_null() && !hdr.is_null());
        let h = || core::slice::from_raw_parts(engine_scope_hdr(e), crate::VIS_SCOPES * crate::VIS_SCOPE_HDR);
        assert_eq!(h()[0], -1, "free");
        assert_eq!(engine_command(e, OP_RACK_ADD_MODULE, 0.0, 2.0, 18.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_CONNECT, 0.0, 0.0, 32.0, 0.0), 0);
        assert_eq!((h()[0], h()[1]), (0, 2), "owner track 0, module 2");
        engine_process(e, 128);
        assert!(h()[2] > 0, "head moved");
        let ring = core::slice::from_raw_parts(rings, crate::VIS_SCOPES * crate::VIS_SCOPE_RING * 4);
        assert!(ring[..h()[2] as usize * 4].iter().any(|&x| x != 0.0), "entries written");
        assert_eq!((engine_scopes(e), engine_scope_hdr(e)), (rings, hdr), "stable pointers");
        // Each rack knows its track slot: a Scope on track 3 says so.
        assert_eq!(engine_command(e, OP_ADD_SYNTH_TRACK, 3.0, 0.0, 0.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_ADD_MODULE, 3.0, 5.0, 18.0, 0.0), 0);
        let hd = crate::VIS_SCOPE_HDR;
        assert_eq!((h()[hd], h()[hd + 1]), (3, 5), "slot 1: track 3, module 5");
        assert!(engine_sample_alloc(e, 9999, 1, 1).is_null());
        let t = core::slice::from_raw_parts(engine_telemetry(e), 8);
        assert_eq!(t[7], ERR_BAD_INDEX as f64);
        drop(Box::from_raw(e));
      }
    }

    #[test]
    fn null_handle_is_tolerated() {
      unsafe {
        let n = core::ptr::null_mut();
        assert!(engine_out_left(n).is_null() && engine_out_right(n).is_null());
        engine_process(n, 128);
        assert_eq!(engine_command(n, 1, 0.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
        assert!(engine_sample_alloc(n, 0, 1, 1).is_null());
        assert_eq!(engine_sample_ready(n, 0), ERR_BAD_INDEX);
        assert!(engine_telemetry(n).is_null());
        assert!(engine_meters(n).is_null());
        assert_eq!(engine_latency(n), 0);
        assert!(engine_vis(n).is_null());
        assert!(engine_scopes(n).is_null() && engine_scope_hdr(n).is_null());
      }
    }
}
