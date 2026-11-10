//! rust-analyzer for a single `main.rs`, exposed to JavaScript via wasm-bindgen.
//!
//! The worker owns one `RustAnalyzer`. It loads the std sources bundle once
//! (`load_std`), then calls `set_text` on every edit and the query methods on
//! demand. All positions are LSP-style: 0-based line, 0-based UTF-16 column.
//! Every query returns a JSON string.

mod docs;
mod pos;
mod setup;

use ra_ap_ide::{
    AdjustmentHints, AdjustmentHintsMode, AnalysisHost, AssistResolveStrategy, CallableSnippets,
    ClosureReturnTypeHints, CompletionConfig, CompletionFieldsToResolve, CompletionItem,
    CompletionItemKind, DiagnosticsConfig, DiscriminantHints, FileId, FilePosition, FileRange,
    GenericParameterHints, GotoDefinitionConfig, HoverConfig, HoverDocFormat, InlayFieldsToResolve,
    InlayHintPosition, InlayHintsConfig, InlayKind, LifetimeElisionHints, MemoryLayoutHoverConfig,
    MemoryLayoutHoverRenderKind, Severity, SubstTyLen, SymbolKind, TextRange, TextSize,
    TypeHintsPlacement,
};
use ra_ap_ide_completion::AutoImportExclusionType;
use ra_ap_ide_db::{
    SnippetCap,
    imports::insert_use::{ImportGranularity, InsertUseConfig},
    ra_fixture::RaFixtureConfig,
    text_edit::TextEdit,
};
use serde::Serialize;
use serde_json::{Value, json};
use wasm_bindgen::prelude::*;

use crate::pos::{Range, TextPos};

#[wasm_bindgen]
pub struct RustAnalyzer {
    host: AnalysisHost,
    /// Current main.rs text (CRLF normalized to LF).
    text: String,
    text_pos: TextPos,
    /// Std file paths (relative to rust-src `library/`), indexed by `FileId - 1`.
    std_paths: Vec<String>,
}

const MAIN_FILE: FileId = FileId::from_raw(0);

#[wasm_bindgen]
impl RustAnalyzer {
    #[wasm_bindgen(constructor)]
    pub fn new() -> RustAnalyzer {
        console_error_panic_hook::set_once();
        let mut ra = RustAnalyzer {
            host: AnalysisHost::new(None),
            text: String::new(),
            text_pos: TextPos::new(""),
            std_paths: Vec::new(),
        };
        setup::apply_world(&mut ra.host, &ra.text, None);
        ra
    }

    /// `bundle` is the decompressed `rust-std.bin` produced by `pack-std.mjs`.
    pub fn load_std(&mut self, bundle: &[u8]) -> Result<(), JsError> {
        let files = setup::parse_bundle(bundle).map_err(|e| JsError::new(&e))?;
        self.std_paths = files.iter().map(|(p, _)| p.clone()).collect();
        setup::apply_world(&mut self.host, &self.text, Some(files));
        Ok(())
    }

    pub fn set_text(&mut self, text: String) {
        let text = if text.contains('\r') { text.replace("\r\n", "\n") } else { text };
        if text == self.text {
            return;
        }
        self.text_pos = TextPos::new(&text);
        self.text = text.clone();
        setup::set_main_text(&mut self.host, text);
    }

    pub fn completions(&self, line: u32, character: u32) -> String {
        let offset = self.text_pos.offset(line, character);
        let position = FilePosition { file_id: MAIN_FILE, offset };
        let config = completion_config();
        let analysis = self.host.analysis();
        let items = analysis.completions(&config, position, None).ok().flatten().unwrap_or_default();
        let items: Vec<Value> = items
            .into_iter()
            .map(|item| {
                let import_edits = if item.import_to_add.is_empty() {
                    Vec::new()
                } else {
                    analysis
                        .resolve_completion_edits(&config, position, item.import_to_add.to_vec())
                        .unwrap_or_default()
                };
                self.completion_json(item, import_edits)
            })
            .collect();
        json!({ "items": items }).to_string()
    }

    pub fn hover(&self, line: u32, character: u32) -> String {
        let offset = self.text_pos.offset(line, character);
        let analysis = self.host.analysis();
        let range = FileRange { file_id: MAIN_FILE, range: TextRange::empty(offset) };
        match analysis.hover(&hover_config(), range) {
            Ok(Some(info)) => json!({
                "markdown": docs::format_docs(info.info.markup.as_str()),
                "range": self.text_pos.range(info.range),
            })
            .to_string(),
            _ => "null".to_owned(),
        }
    }

    pub fn signature_help(&self, line: u32, character: u32) -> String {
        let offset = self.text_pos.offset(line, character);
        let analysis = self.host.analysis();
        let help = match analysis.signature_help(FilePosition { file_id: MAIN_FILE, offset }) {
            Ok(Some(help)) => help,
            _ => return "null".to_owned(),
        };
        let label = help.signature.clone();
        let utf16_at = |byte: TextSize| -> u32 {
            label[..usize::from(byte)].encode_utf16().count() as u32
        };
        let parameters: Vec<[u32; 2]> = help
            .parameter_ranges()
            .iter()
            .map(|r| [utf16_at(r.start()), utf16_at(r.end())])
            .collect();
        let mut out = json!({
            "label": label,
            "parameters": parameters,
            "active_parameter": help.active_parameter,
        });
        if let Some(doc) = &help.doc {
            out["documentation"] = Value::String(docs::format_docs(doc.as_str()));
        }
        out.to_string()
    }

    pub fn goto_definition(&self, line: u32, character: u32) -> String {
        let offset = self.text_pos.offset(line, character);
        let analysis = self.host.analysis();
        let config = GotoDefinitionConfig { ra_fixture: ra_fixture_config() };
        let navs = match analysis.goto_definition(FilePosition { file_id: MAIN_FILE, offset }, &config) {
            Ok(Some(info)) => info.info,
            _ => return "[]".to_owned(),
        };
        let mut out = Vec::new();
        for nav in navs {
            let target = nav.focus_range.unwrap_or(nav.full_range);
            let mut entry = json!({
                "name": nav.name.as_str(),
                "kind": nav.kind.map(symbol_kind_str),
            });
            if nav.file_id == MAIN_FILE {
                entry["in_main"] = Value::Bool(true);
                entry["range"] = json!(self.text_pos.range(target));
                entry["full_range"] = json!(self.text_pos.range(nav.full_range));
            } else {
                entry["in_main"] = Value::Bool(false);
                let Some(path) = self.std_path(nav.file_id) else { continue };
                let Ok(text) = analysis.file_text(nav.file_id) else { continue };
                let tp = TextPos::new(&text);
                let range = tp.range(target);
                let line = range.start.line;
                let (snippet, snippet_start_line) = snippet_around(&text, line, 3, 12);
                entry["path"] = json!(path);
                entry["line"] = json!(line);
                entry["range"] = json!(range);
                entry["snippet"] = json!(snippet);
                entry["snippet_start_line"] = json!(snippet_start_line);
            }
            out.push(entry);
        }
        Value::Array(out).to_string()
    }

    pub fn diagnostics(&self) -> String {
        let analysis = self.host.analysis();
        let mut config = DiagnosticsConfig::test_sample();
        config.disable_experimental = true;
        config.style_lints = false;
        config.proc_macros_enabled = false;
        config.proc_attr_macros_enabled = false;
        let diags = analysis
            .full_diagnostics(&config, AssistResolveStrategy::None, MAIN_FILE)
            .unwrap_or_default();
        let out: Vec<Value> = diags
            .into_iter()
            .filter(|d| d.range.file_id == MAIN_FILE && d.severity != Severity::Allow)
            .map(|d| {
                let severity = match d.severity {
                    Severity::Error => "error",
                    Severity::Warning => "warning",
                    Severity::WeakWarning => "hint",
                    Severity::Allow => "hint",
                };
                let mut v = json!({
                    "range": self.text_pos.range(d.range.range),
                    "severity": severity,
                    "message": d.message,
                    "code": d.code.as_str(),
                });
                if d.unused {
                    v["unused"] = Value::Bool(true);
                }
                v
            })
            .collect();
        Value::Array(out).to_string()
    }

    pub fn inlay_hints(&self) -> String {
        let analysis = self.host.analysis();
        let hints = analysis.inlay_hints(&inlay_config(), MAIN_FILE, None).unwrap_or_default();
        let out: Vec<Value> = hints
            .into_iter()
            .map(|h| {
                let offset = match h.position {
                    InlayHintPosition::Before => h.range.start(),
                    InlayHintPosition::After => h.range.end(),
                };
                let label: String = h.label.parts.iter().map(|p| p.text.as_str()).collect();
                let kind = match h.kind {
                    InlayKind::Type | InlayKind::Chaining => "type",
                    InlayKind::Parameter => "parameter",
                    _ => "other",
                };
                let mut v = json!({
                    "position": self.text_pos.pos(offset),
                    "label": label,
                    "kind": kind,
                });
                if h.pad_left {
                    v["padding_left"] = Value::Bool(true);
                }
                if h.pad_right {
                    v["padding_right"] = Value::Bool(true);
                }
                v
            })
            .collect();
        Value::Array(out).to_string()
    }
}

impl Default for RustAnalyzer {
    fn default() -> Self {
        Self::new()
    }
}

impl RustAnalyzer {
    fn std_path(&self, file_id: FileId) -> Option<&str> {
        let idx = file_id.index().checked_sub(1)? as usize;
        self.std_paths.get(idx).map(|s| s.as_str())
    }

    fn completion_json(&self, item: CompletionItem, import_edits: Vec<TextEdit>) -> Value {
        #[derive(Serialize)]
        struct Edit {
            range: Range,
            new_text: String,
        }

        // Same split the rust-analyzer LSP server does: the indel that covers
        // `source_range` is the primary edit, anything else is additional.
        let source_range = item.source_range;
        let mut primary: Option<(TextRange, String)> = None;
        let mut additional: Vec<Edit> = Vec::new();
        for indel in item.text_edit.iter() {
            if primary.is_none() && indel.delete.contains_range(source_range) {
                if indel.delete == source_range || indel.delete.end() != source_range.end() {
                    primary = Some((indel.delete, indel.insert.clone()));
                } else {
                    // Postfix completions replace `receiver.prefix`; keep the
                    // primary edit on the typed prefix so client-side filtering works.
                    additional.push(Edit {
                        range: self.text_pos.range(TextRange::new(indel.delete.start(), source_range.start())),
                        new_text: String::new(),
                    });
                    primary = Some((source_range, indel.insert.clone()));
                }
            } else {
                additional.push(Edit {
                    range: self.text_pos.range(indel.delete),
                    new_text: indel.insert.clone(),
                });
            }
        }
        for edit in import_edits {
            for indel in edit.iter() {
                additional.push(Edit {
                    range: self.text_pos.range(indel.delete),
                    new_text: indel.insert.clone(),
                });
            }
        }
        let (edit_range, insert_text) =
            primary.unwrap_or((source_range, item.label.primary.to_string()));

        let score = item.relevance.score();
        let mut v = json!({
            "label": item.label.primary.as_str(),
            "kind": completion_kind_str(item.kind),
            "insert_text": insert_text,
            "is_snippet": item.is_snippet,
            "filter_text": item.lookup.as_str(),
            "sort_text": format!("{:08x}", score ^ 0xFFFF_FFFF),
            "relevance": score,
            "edit_range": self.text_pos.range(edit_range),
        });
        if let Some(d) = item.label.detail_left {
            v["label_detail"] = json!(d);
        }
        if let Some(d) = item.label.detail_right {
            v["label_description"] = json!(d);
        }
        if let Some(d) = item.detail {
            v["detail"] = json!(d);
        }
        if let Some(doc) = item.documentation {
            v["documentation"] = json!(docs::format_docs(doc.as_str()));
        }
        if item.deprecated {
            v["deprecated"] = Value::Bool(true);
        }
        if item.trigger_call_info {
            v["trigger_signature_help"] = Value::Bool(true);
        }
        if !additional.is_empty() {
            v["additional_edits"] = json!(additional);
        }
        v
    }
}

fn snippet_around(text: &str, line: u32, before: u32, total: u32) -> (String, u32) {
    let start = line.saturating_sub(before);
    let snippet: Vec<&str> =
        text.lines().skip(start as usize).take(total as usize).collect();
    (snippet.join("\n"), start)
}

fn ra_fixture_config() -> RaFixtureConfig<'static> {
    RaFixtureConfig { disable_ra_fixture: true, ..RaFixtureConfig::default() }
}

fn completion_config() -> CompletionConfig<'static> {
    CompletionConfig {
        enable_postfix_completions: true,
        enable_imports_on_the_fly: true,
        enable_self_on_the_fly: true,
        enable_auto_iter: true,
        enable_auto_await: true,
        enable_private_editable: false,
        enable_term_search: false,
        enable_turbofish: true,
        term_search_fuel: 1000,
        full_function_signatures: false,
        callable: Some(CallableSnippets::FillArguments),
        add_colons_to_module: true,
        add_semicolon_to_unit: true,
        snippet_cap: SnippetCap::new(true),
        insert_use: InsertUseConfig {
            granularity: ImportGranularity::Crate,
            enforce_granularity: false,
            prefix_kind: ra_ap_hir::PrefixKind::Plain,
            group: true,
            skip_glob_imports: true,
        },
        prefer_no_std: false,
        prefer_prelude: true,
        prefer_absolute: false,
        snippets: Vec::new(),
        limit: None,
        fields_to_resolve: CompletionFieldsToResolve::empty(),
        // rust-analyzer's defaults.
        exclude_flyimport: vec![
            ("core::borrow::Borrow".to_owned(), AutoImportExclusionType::Methods),
            ("core::borrow::BorrowMut".to_owned(), AutoImportExclusionType::Methods),
        ],
        exclude_traits: &[],
        ra_fixture: ra_fixture_config(),
    }
}

fn hover_config() -> HoverConfig<'static> {
    HoverConfig {
        links_in_hover: true,
        memory_layout: Some(MemoryLayoutHoverConfig {
            size: Some(MemoryLayoutHoverRenderKind::Both),
            offset: Some(MemoryLayoutHoverRenderKind::Hexadecimal),
            alignment: Some(MemoryLayoutHoverRenderKind::Both),
            padding: None,
            niches: false,
        }),
        documentation: true,
        keywords: true,
        format: HoverDocFormat::Markdown,
        max_trait_assoc_items_count: None,
        max_fields_count: Some(5),
        max_enum_variants_count: Some(5),
        max_subst_ty_len: SubstTyLen::LimitTo(20),
        show_drop_glue: true,
        ra_fixture: ra_fixture_config(),
    }
}

fn inlay_config() -> InlayHintsConfig<'static> {
    InlayHintsConfig {
        render_colons: true,
        type_hints: true,
        type_hints_placement: TypeHintsPlacement::Inline,
        sized_bound: false,
        discriminant_hints: DiscriminantHints::Never,
        parameter_hints: true,
        parameter_hints_for_missing_arguments: false,
        generic_parameter_hints: GenericParameterHints {
            type_hints: false,
            lifetime_hints: false,
            const_hints: true,
        },
        chaining_hints: true,
        adjustment_hints: AdjustmentHints::Never,
        adjustment_hints_disable_reborrows: true,
        adjustment_hints_mode: AdjustmentHintsMode::Prefix,
        adjustment_hints_hide_outside_unsafe: false,
        closure_return_type_hints: ClosureReturnTypeHints::Never,
        closure_capture_hints: false,
        binding_mode_hints: false,
        implicit_drop_hints: false,
        implied_dyn_trait_hints: true,
        lifetime_elision_hints: LifetimeElisionHints::Never,
        param_names_for_lifetime_elision_hints: false,
        hide_inferred_type_hints: false,
        hide_named_constructor_hints: false,
        hide_closure_initialization_hints: false,
        hide_closure_parameter_hints: false,
        range_exclusive_hints: false,
        closure_style: ra_ap_hir::ClosureStyle::ImplFn,
        max_length: Some(25),
        closing_brace_hints_min_lines: Some(25),
        fields_to_resolve: InlayFieldsToResolve::empty(),
        ra_fixture: ra_fixture_config(),
    }
}

fn symbol_kind_str(kind: SymbolKind) -> &'static str {
    match kind {
        SymbolKind::Attribute | SymbolKind::BuiltinAttr | SymbolKind::DeriveHelper => "attribute",
        SymbolKind::Const | SymbolKind::ConstParam | SymbolKind::Static => "constant",
        SymbolKind::CrateRoot | SymbolKind::Module | SymbolKind::ToolModule => "module",
        SymbolKind::Derive | SymbolKind::Macro | SymbolKind::ProcMacro => "macro",
        SymbolKind::Enum => "enum",
        SymbolKind::Field => "field",
        SymbolKind::Function => "function",
        SymbolKind::Method => "method",
        SymbolKind::Impl => "impl",
        SymbolKind::InlineAsmRegOrRegClass => "other",
        SymbolKind::Label => "label",
        SymbolKind::LifetimeParam => "lifetime",
        SymbolKind::Local | SymbolKind::ValueParam | SymbolKind::SelfParam => "variable",
        SymbolKind::SelfType | SymbolKind::Struct => "struct",
        SymbolKind::Union => "union",
        SymbolKind::Trait => "trait",
        SymbolKind::TypeAlias => "type_alias",
        SymbolKind::TypeParam => "type_param",
        SymbolKind::Variant => "enum_variant",
    }
}

fn completion_kind_str(kind: CompletionItemKind) -> &'static str {
    match kind {
        CompletionItemKind::SymbolKind(k) => symbol_kind_str(k),
        CompletionItemKind::Binding => "variable",
        CompletionItemKind::BuiltinType => "builtin_type",
        CompletionItemKind::InferredType => "type_param",
        CompletionItemKind::Keyword => "keyword",
        CompletionItemKind::Snippet => "snippet",
        CompletionItemKind::UnresolvedReference => "other",
        CompletionItemKind::Expression => "snippet",
    }
}
