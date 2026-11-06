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

#[no_mangle]
pub extern "C" fn engine_out_left(e: *mut Host) -> *mut f32 {
    // SAFETY: see module contract; `as_mut` maps null to None.
    match unsafe { e.as_mut() } {
        Some(h) => h.left.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn engine_out_right(e: *mut Host) -> *mut f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.right.as_mut_ptr(),
        None => core::ptr::null_mut(),
    }
}

/// Renders `min(frames, MAX_BLOCK)` frames into the out buffers.
#[no_mangle]
pub extern "C" fn engine_process(e: *mut Host, frames: u32) {
    // SAFETY: see module contract.
    if let Some(h) = unsafe { e.as_mut() } {
        let n = (frames as usize).min(MAX_BLOCK);
        let Host { engine, left, right } = h;
        engine.process(&mut left[..n], &mut right[..n]);
    }
}

#[no_mangle]
pub extern "C" fn engine_command(e: *mut Host, op: u32, a: f64, b: f64, c: f64, d: f64) -> i32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.engine.command(op, a, b, c, d),
        None => ERR_BAD_INDEX,
    }
}

/// Null on error; the code is recorded in `TELEMETRY_LAST_ERROR` by the engine.
#[no_mangle]
pub extern "C" fn engine_sample_alloc(e: *mut Host, id: u32, frames: u32, channels: u32) -> *mut f32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.engine.sample_alloc(id, frames, channels).unwrap_or(core::ptr::null_mut()),
        None => core::ptr::null_mut(),
    }
}

#[no_mangle]
pub extern "C" fn engine_sample_ready(e: *mut Host, id: u32) -> i32 {
    // SAFETY: see module contract.
    match unsafe { e.as_mut() } {
        Some(h) => h.engine.sample_ready(id),
        None => ERR_BAD_INDEX,
    }
}

#[no_mangle]
pub extern "C" fn engine_telemetry(e: *mut Host) -> *const f64 {
    // SAFETY: see module contract.
    match unsafe { e.as_ref() } {
        Some(h) => h.engine.telemetry().as_ptr(),
        None => core::ptr::null(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{OP_ADD_SYNTH_TRACK, OP_RACK_ADD_MODULE, OP_RACK_CONNECT};

    #[test]
    fn ffi_roundtrip() {
        let e = engine_new(48000.0);
        // Synth track 0: LFO (kind 6) at module 0 -> Out (kind 8) at module 1.
        assert_eq!(engine_command(e, OP_ADD_SYNTH_TRACK, 0.0, 0.0, 0.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_ADD_MODULE, 0.0, 0.0, 6.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_ADD_MODULE, 0.0, 1.0, 8.0, 0.0), 0);
        assert_eq!(engine_command(e, OP_RACK_CONNECT, 0.0, 0.0, 16.0, 0.0), 0);
        engine_process(e, 128);
        let left = unsafe { core::slice::from_raw_parts(engine_out_left(e), 128) };
        assert!(left.iter().any(|&s| s != 0.0));
        let t = unsafe { core::slice::from_raw_parts(engine_telemetry(e), 8) };
        assert_eq!(t[0], 1.0);
        engine_process(e, 100_000); // clamped, must not panic
        assert!(engine_sample_alloc(e, 9999, 1, 1).is_null());
        let t = unsafe { core::slice::from_raw_parts(engine_telemetry(e), 8) };
        assert_eq!(t[7], ERR_BAD_INDEX as f64);
        drop(unsafe { Box::from_raw(e) });
    }

    #[test]
    fn null_handle_is_tolerated() {
        let n = core::ptr::null_mut();
        assert!(engine_out_left(n).is_null() && engine_out_right(n).is_null());
        engine_process(n, 128);
        assert_eq!(engine_command(n, 1, 0.0, 0.0, 0.0, 0.0), ERR_BAD_INDEX);
        assert!(engine_sample_alloc(n, 0, 1, 1).is_null());
        assert_eq!(engine_sample_ready(n, 0), ERR_BAD_INDEX);
        assert!(engine_telemetry(n).is_null());
    }
}
