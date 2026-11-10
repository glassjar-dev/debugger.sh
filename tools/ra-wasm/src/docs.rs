//! Rustdoc markdown -> plain markdown, the way rust-analyzer's LSP server does it:
//! untagged / rustdoc-tagged fences become ```rust, and hidden `# ` lines are dropped.

const FENCES: [&str; 2] = ["```", "~~~"];

pub fn format_docs(src: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    let mut in_code_block = false;
    let mut is_rust = false;
    for mut line in src.lines() {
        if in_code_block && is_rust && hidden_line(line) {
            continue;
        }
        if let Some(header) = FENCES.iter().find_map(|f| line.trim_start().strip_prefix(f)) {
            in_code_block ^= true;
            if in_code_block {
                is_rust = is_rust_fence(header);
                if is_rust {
                    line = "```rust";
                }
            }
        }
        if in_code_block && is_rust {
            let trimmed = line.trim_start();
            if trimmed.starts_with("##") {
                line = &trimmed[1..];
            }
        }
        out.push(line);
    }
    out.join("\n")
}

fn hidden_line(line: &str) -> bool {
    let t = line.trim();
    t == "#" || t.starts_with("# ") || t.starts_with("#\t")
}

fn is_rust_fence(header: &str) -> bool {
    let mut seen_rust = false;
    let mut seen_other = false;
    for token in header.trim().split([',', ' ', '\t']).map(str::trim).filter(|t| !t.is_empty()) {
        match token {
            "should_panic" | "no_run" | "ignore" | "allow_fail" => seen_rust = !seen_other,
            "rust" => seen_rust = true,
            "test_harness" | "compile_fail" => seen_rust = !seen_other || seen_rust,
            t if t.starts_with("edition") || t.starts_with("ignore-") || is_error_code(t) => {}
            _ => seen_other = true,
        }
    }
    !seen_other || seen_rust
}

/// Rustdoc error-code tags such as `E0308`.
fn is_error_code(t: &str) -> bool {
    t.len() > 1 && t.starts_with('E') && t[1..].bytes().all(|b| b.is_ascii_digit())
}
