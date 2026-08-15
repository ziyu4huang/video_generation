//! WASM (wasm32-wasip1) entry point for the DSH sv-analyzer.
//!
//! The module is fully self-contained: the tree-sitter C library and both
//! grammar parsers are linked in at build time (see rust/.cargo/config.toml),
//! so the only imports are the WASI std surface — no `env` module, no
//! sibling provider module.
//!
//! ABI (all exports, no stdio): the host calls
//!   `alloc(len) -> ptr`        allocate a request buffer,
//!   `run(ptr, len) -> ptr`     dispatch one JSON request, keep response,
//!   `response_len() -> usize`  length of the current response,
//!   `free_response()`          release the current response,
//!   `dealloc(ptr, len)`        release a request buffer.
//!
//! Request:  `{ "op": "analyze" | "ast" | "version", "code": "...", ... }`
//! Response: `{ "ok": true, "data": ... } | { "ok": false, "error": "..." }`
//!
//! The `ast` op returns a slim payload (parse status + the tree + truncation
//! flags only): tree dumps are already large, so the design summary that
//! `analyze` also computes is dropped on the floor for this op.

#![allow(static_mut_refs)] // single-threaded wasm; RESPONSE is never aliased

use dsh_sv_analyzer::{analyze, version_info, AnalyzeRequest, Dialect};
use serde::Deserialize;
use serde_json::json;

static mut RESPONSE: Option<Vec<u8>> = None;

#[derive(Debug, Deserialize)]
struct Request {
    op: String,
    code: Option<String>,
    dialect: Option<String>,
    include_ast: Option<bool>,
    max_errors: Option<usize>,
}

fn dispatch(req_bytes: &[u8]) -> Vec<u8> {
    let response = match serde_json::from_slice::<Request>(req_bytes) {
        Ok(req) => match req.op.as_str() {
            "analyze" => {
                let ar = AnalyzeRequest {
                    code: req.code.unwrap_or_default(),
                    dialect: req.dialect.as_deref().map(Dialect::parse).unwrap_or(Dialect::Auto),
                    include_ast: req.include_ast.unwrap_or(false),
                    max_errors: req.max_errors.unwrap_or(50),
                };
                match analyze(&ar) {
                    Ok(result) => json!({ "ok": true, "data": result }),
                    Err(e) => json!({ "ok": false, "error": e }),
                }
            }
            "ast" => {
                let ar = AnalyzeRequest {
                    code: req.code.unwrap_or_default(),
                    dialect: req.dialect.as_deref().map(Dialect::parse).unwrap_or(Dialect::Auto),
                    include_ast: true,
                    max_errors: req.max_errors.unwrap_or(50),
                };
                match analyze(&ar) {
                    Ok(result) => json!({
                        "ok": true,
                        "data": {
                            "dialect": result.dialect,
                            "parse_ok": result.parse_ok,
                            "error_count": result.error_count,
                            "issues_truncated": result.issues_truncated,
                            "ast_truncated": result.ast_truncated,
                            "ast": result.ast,
                        }
                    }),
                    Err(e) => json!({ "ok": false, "error": e }),
                }
            }
            "version" => json!({ "ok": true, "data": version_info() }),
            other => json!({ "ok": false, "error": format!("unknown op: {other}") }),
        },
        Err(e) => json!({ "ok": false, "error": format!("bad request: {e}") }),
    };
    serde_json::to_vec(&response).unwrap_or_default()
}

/// Allocate `len` bytes and return a pointer into linear memory. The caller
/// must release it with `dealloc(ptr, len)`.
#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::with_capacity(len.max(1));
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

/// Release a buffer previously returned by `alloc`.
#[no_mangle]
pub unsafe extern "C" fn dealloc(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        let _ = Vec::from_raw_parts(ptr, 0, len.max(1));
    }
}

/// Dispatch one request and stash the JSON response. Returns a pointer valid
/// until the next `run` or `free_response`.
#[no_mangle]
pub unsafe extern "C" fn run(req_ptr: *const u8, req_len: usize) -> *const u8 {
    let req_bytes = std::slice::from_raw_parts(req_ptr, req_len);
    RESPONSE = Some(dispatch(req_bytes));
    RESPONSE.as_ref().unwrap().as_ptr()
}

/// Length of the current response (0 when none).
#[no_mangle]
pub extern "C" fn response_len() -> usize {
    unsafe { RESPONSE.as_ref().map_or(0, Vec::len) }
}

/// Release the current response buffer.
#[no_mangle]
pub unsafe extern "C" fn free_response() {
    RESPONSE = None;
}

fn main() {}
