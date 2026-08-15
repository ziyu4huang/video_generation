//! Native CLI used by the build script for quick self-tests and by humans
//! for debugging the analyzer without the WASM round-trip.
//!
//! Usage: dsh-sv-cli <file> [--dialect auto|systemverilog|verilog] [--ast]

use dsh_sv_analyzer::{analyze, AnalyzeRequest, Dialect};
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut file: Option<&str> = None;
    let mut dialect = Dialect::Auto;
    let mut include_ast = false;

    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--dialect" => {
                i += 1;
                dialect = args.get(i).map(|s| Dialect::parse(s)).unwrap_or(Dialect::Auto);
            }
            "--ast" => include_ast = true,
            "--help" | "-h" => {
                println!("Usage: dsh-sv-cli <file> [--dialect auto|systemverilog|verilog] [--ast]");
                return ExitCode::SUCCESS;
            }
            other if other.starts_with('-') => {
                eprintln!("unknown option: {other}");
                return ExitCode::FAILURE;
            }
            other => file = Some(other),
        }
        i += 1;
    }

    let Some(path) = file else {
        eprintln!("missing <file> argument (use --help)");
        return ExitCode::FAILURE;
    };

    let code = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("cannot read {path}: {e}");
            return ExitCode::FAILURE;
        }
    };

    let req = AnalyzeRequest { code, dialect, include_ast, max_errors: 50 };
    match analyze(&req) {
        Ok(result) => {
            println!("{}", serde_json::to_string_pretty(&result).unwrap_or_default());
            ExitCode::SUCCESS
        }
        Err(e) => {
            eprintln!("analysis failed: {e}");
            ExitCode::FAILURE
        }
    }
}
