//! Building the rust-analyzer "world": source roots, crate graph, cfgs.
//!
//! Mirrors what rust-analyzer does for a sysroot: `core`, `alloc` and `std`
//! live in one library source root, and the main crate depends on them with
//! `core`/`std` in the extern prelude.

use ra_ap_hir::{CfgOptions, ChangeWithProcMacros, Symbol};
use ra_ap_ide::{AnalysisHost, Edition, FileId, SourceRoot};
use ra_ap_ide_db::base_db::{
    AbsPathBuf, CrateDisplayName, CrateGraphBuilder, CrateName, CrateOrigin, CrateWorkspaceData,
    DependencyBuilder, Env, FileSet, LangCrateOrigin, VfsPath, Version,
    target::{Arch, TargetData},
};
use triomphe::Arc;

/// Virtual directory the std sources live under. Paths in the bundle are
/// relative to rust-src's `library/` directory (e.g. `core/src/lib.rs`).
const SYSROOT_DIR: &str = "/rustlib/library";
const MAIN_PATH: &str = "/main.rs";

/// `rustc -Z unstable-options --print target-spec-json --target wasm32-wasip1`
const WASM32_WASIP1_DATA_LAYOUT: &str =
    "e-m:e-p:32:32-p10:8:8-p20:8:8-i64:64-i128:128-n32:64-S128-ni:1:10:20";

const BUNDLE_MAGIC: &[u8; 4] = b"RSTD";

/// Bundle format (little endian):
///   "RSTD" u32:version(1) u32:count
///   count * { u32:path_len path_utf8 u32:text_len text_utf8 }
pub fn parse_bundle(bytes: &[u8]) -> Result<Vec<(String, String)>, String> {
    let mut cur = 0usize;
    let mut take = |n: usize| -> Result<&[u8], String> {
        let end = cur.checked_add(n).filter(|&e| e <= bytes.len()).ok_or("std bundle truncated")?;
        let s = &bytes[cur..end];
        cur = end;
        Ok(s)
    };
    if take(4)? != BUNDLE_MAGIC {
        return Err("not a rust-std bundle (bad magic); did you gunzip it?".into());
    }
    let u32_at = |b: &[u8]| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize;
    let version = u32_at(take(4)?);
    if version != 1 {
        return Err(format!("unsupported std bundle version {version}"));
    }
    let count = u32_at(take(4)?);
    let mut files = Vec::with_capacity(count);
    for _ in 0..count {
        let n = u32_at(take(4)?);
        let path = std::str::from_utf8(take(n)?).map_err(|e| e.to_string())?.to_owned();
        let n = u32_at(take(4)?);
        let text = std::str::from_utf8(take(n)?).map_err(|e| e.to_string())?.to_owned();
        files.push((path, text));
    }
    Ok(files)
}

/// `AbsPathBuf` for "/". Its constructors assert `Path::is_absolute`, which is
/// always false on wasm32-unknown-unknown (std has no path semantics there), so
/// build it from the inner `Utf8PathBuf` directly. `AbsPathBuf` is a plain
/// newtype over `Utf8PathBuf`; `transmute` checks the sizes match. The value is
/// only used as the (unused) proc-macro working directory.
fn root_abs_path() -> AbsPathBuf {
    let inner = ra_ap_paths::Utf8PathBuf::from("/");
    // SAFETY: `AbsPathBuf` is `struct AbsPathBuf(Utf8PathBuf)`, a single-field
    // newtype, so it has the same layout as its field.
    unsafe { std::mem::transmute::<ra_ap_paths::Utf8PathBuf, AbsPathBuf>(inner) }
}

fn sym(s: &str) -> Symbol {
    Symbol::intern(s)
}

/// cfgs for `wasm32-wasip1` (`rustc --print cfg --target wasm32-wasip1`).
fn target_cfg(debug_assertions: bool) -> CfgOptions {
    let mut cfg = CfgOptions::default();
    let kv = [
        ("panic", "abort"),
        ("target_abi", ""),
        ("target_arch", "wasm32"),
        ("target_endian", "little"),
        ("target_env", "p1"),
        ("target_family", "wasm"),
        ("target_os", "wasi"),
        ("target_pointer_width", "32"),
        ("target_vendor", "unknown"),
        ("target_feature", "bulk-memory"),
        ("target_feature", "crt-static"),
        ("target_feature", "multivalue"),
        ("target_feature", "mutable-globals"),
        ("target_feature", "nontrapping-fptoint"),
        ("target_feature", "reference-types"),
        ("target_feature", "sign-ext"),
        ("target_has_atomic", "8"),
        ("target_has_atomic", "16"),
        ("target_has_atomic", "32"),
        ("target_has_atomic", "64"),
        ("target_has_atomic", "ptr"),
        ("target_has_atomic_primitive_alignment", "8"),
        ("target_has_atomic_primitive_alignment", "16"),
        ("target_has_atomic_primitive_alignment", "32"),
        ("target_has_atomic_primitive_alignment", "64"),
        ("target_has_atomic_primitive_alignment", "ptr"),
    ];
    for (k, v) in kv {
        cfg.insert_key_value(sym(k), sym(v));
    }
    if debug_assertions {
        cfg.insert_atom(sym("debug_assertions"));
    }
    cfg
}

fn workspace_data() -> Arc<CrateWorkspaceData> {
    Arc::new(CrateWorkspaceData {
        target: Ok(TargetData { data_layout: WASM32_WASIP1_DATA_LAYOUT.into(), arch: Arch::Wasm32 }),
        toolchain: Some(Version::new(1, 99, 1)),
    })
}

/// Replace source roots and the crate graph, and (re)set every file's text.
/// `std_files == None` builds a world with only the main crate (no std).
pub fn apply_world(host: &mut AnalysisHost, main_text: &str, std_files: Option<Vec<(String, String)>>) {
    let proc_macro_cwd = Arc::new(root_abs_path());
    let ws = workspace_data();
    let mut change = ChangeWithProcMacros::default();

    let main_id = FileId::from_raw(0);
    let mut main_set = FileSet::default();
    main_set.insert(main_id, VfsPath::new_virtual_path(MAIN_PATH.to_owned()));
    let mut roots = vec![SourceRoot::new_local(main_set)];

    let mut graph = CrateGraphBuilder::default();
    let main_crate = graph.add_crate_root(
        main_id,
        Edition::Edition2021,
        Some(CrateDisplayName::from_canonical_name("main")),
        None,
        target_cfg(true),
        None,
        Env::default(),
        CrateOrigin::Local { repo: None, name: Some(sym("main")) },
        Vec::new(),
        false,
        proc_macro_cwd.clone(),
        ws.clone(),
    );
    change.change_file(main_id, Some(main_text.to_owned()));

    if let Some(files) = std_files {
        let mut std_set = FileSet::default();
        let root_of = |name: &str| -> Option<FileId> {
            let want = format!("{name}/src/lib.rs");
            files.iter().position(|(p, _)| *p == want).map(|i| FileId::from_raw(i as u32 + 1))
        };
        let core_root = root_of("core");
        let alloc_root = root_of("alloc");
        let std_root = root_of("std");

        for (i, (path, text)) in files.into_iter().enumerate() {
            let id = FileId::from_raw(i as u32 + 1);
            std_set.insert(id, VfsPath::new_virtual_path(format!("{SYSROOT_DIR}/{path}")));
            change.change_file(id, Some(text));
        }
        roots.push(SourceRoot::new_library(std_set));

        let mut add_lang = |root: Option<FileId>, name: &str, origin: LangCrateOrigin| {
            root.map(|root| {
                graph.add_crate_root(
                    root,
                    Edition::Edition2024,
                    Some(CrateDisplayName::from_canonical_name(name)),
                    None,
                    target_cfg(false),
                    None,
                    Env::default(),
                    CrateOrigin::Lang(origin),
                    Vec::new(),
                    false,
                    proc_macro_cwd.clone(),
                    ws.clone(),
                )
            })
        };
        let core = add_lang(core_root, "core", LangCrateOrigin::Core);
        let alloc = add_lang(alloc_root, "alloc", LangCrateOrigin::Alloc);
        let std = add_lang(std_root, "std", LangCrateOrigin::Std);

        let name = |s: &str| CrateName::new(s).expect("valid crate name");
        if let (Some(alloc), Some(core)) = (alloc, core) {
            let _ = graph.add_dep(alloc, DependencyBuilder::new(name("core"), core));
        }
        if let Some(std) = std {
            if let Some(alloc) = alloc {
                let _ = graph.add_dep(std, DependencyBuilder::new(name("alloc"), alloc));
            }
            if let Some(core) = core {
                let _ = graph.add_dep(std, DependencyBuilder::new(name("core"), core));
            }
        }
        // Same order and prelude flags as rust-analyzer's sysroot public deps.
        for (dep, krate, prelude) in [("core", core, true), ("alloc", alloc, false), ("std", std, true)] {
            if let Some(krate) = krate {
                let _ = graph.add_dep(
                    main_crate,
                    DependencyBuilder::with_prelude(name(dep), krate, prelude, true),
                );
            }
        }
    }

    change.set_roots(roots);
    change.set_crate_graph(graph);
    // Not `host.apply_change`: that calls `Instant::now()`, which panics on
    // wasm32-unknown-unknown. No snapshots are alive here, so there is nothing
    // to cancel either.
    change.apply(host.raw_database_mut());
}

pub fn set_main_text(host: &mut AnalysisHost, text: String) {
    let mut change = ChangeWithProcMacros::default();
    change.change_file(FileId::from_raw(0), Some(text));
    change.apply(host.raw_database_mut());
}
