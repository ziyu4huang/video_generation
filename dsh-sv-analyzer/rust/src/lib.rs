//! dsh-sv-analyzer core: tree-sitter based Verilog / SystemVerilog analysis.
//!
//! Pure computation over `tree-sitter` parse trees, compiled to `wasm32-wasip1`
//! for embedding in a DeepSeek Harness host plugin. The crate has no I/O of
//! its own: the caller feeds source text via JSON and receives JSON back.
//!
//! Two grammars are linked: `tree-sitter-systemverilog` (IEEE 1800-2023) and
//! `tree-sitter-verilog` (classic Verilog). `Dialect::Auto` parses with
//! SystemVerilog first and falls back to Verilog when the parse has errors.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use tree_sitter::{Language, Node, Parser, Tree};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

// ---------------------------------------------------------------------------
// Dialect selection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Dialect {
    Auto,
    SystemVerilog,
    Verilog,
}

impl Dialect {
    pub fn parse(s: &str) -> Dialect {
        match s.trim().to_ascii_lowercase().as_str() {
            "systemverilog" | "sv" => Dialect::SystemVerilog,
            "verilog" | "v" => Dialect::Verilog,
            _ => Dialect::Auto,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Dialect::Auto => "auto",
            Dialect::SystemVerilog => "systemverilog",
            Dialect::Verilog => "verilog",
        }
    }
}

fn grammar(dialect: Dialect) -> Language {
    match dialect {
        Dialect::Verilog => tree_sitter_verilog::LANGUAGE.into(),
        _ => tree_sitter_systemverilog::LANGUAGE.into(),
    }
}

fn parse_with(dialect: Dialect, code: &str) -> (Tree, usize) {
    let mut parser = Parser::new();
    parser.set_language(&grammar(dialect)).expect("grammar is valid");
    let tree = parser.parse(code, None).expect("parse is infallible");
    let errors = count_errors(&tree.root_node());
    (tree, errors)
}

/// Parse `code`, honoring the requested dialect. In Auto mode both grammars
/// run and the one with fewer error nodes wins.
fn parse(code: &str, dialect: Dialect) -> (Tree, Dialect) {
    match dialect {
        Dialect::Auto => {
            let (sv_tree, sv_errors) = parse_with(Dialect::SystemVerilog, code);
            let (v_tree, v_errors) = parse_with(Dialect::Verilog, code);
            if v_errors < sv_errors {
                (v_tree, Dialect::Verilog)
            } else {
                (sv_tree, Dialect::SystemVerilog)
            }
        }
        other => {
            let (tree, _) = parse_with(other, code);
            (tree, other)
        }
    }
}

// ---------------------------------------------------------------------------
// Wire models
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct PointJson {
    pub row: usize,
    pub column: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParseIssue {
    /// "error" for ERROR nodes, "missing" for MISSING tokens.
    pub kind: String,
    pub node_type: String,
    pub start: PointJson,
    pub end: PointJson,
    /// A short source snippet around the issue.
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct PortDecl {
    pub name: String,
    /// input | output | inout | "" (unknown).
    pub direction: String,
    /// e.g. "wire", "logic" — residual type text, "" when none.
    pub port_type: String,
    /// e.g. "[7:0]", "" when scalar.
    pub width: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ParamDecl {
    pub name: String,
    pub default: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstanceDecl {
    /// Instantiated module / interface / program name.
    pub module: String,
    pub name: String,
    pub start_line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SignalDecl {
    pub name: String,
    /// net/data kind: "wire", "reg", "logic", "parameter", ...
    pub kind: String,
    pub width: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct AlwaysBlock {
    /// always | always_ff | always_comb | always_latch
    pub kind: String,
    /// e.g. "@(posedge clk or negedge rst_n)", "" for combinational.
    pub trigger: String,
    pub start_line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct AssignDecl {
    pub lhs: String,
    pub rhs: String,
    pub start_line: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct DesignUnit {
    /// module | interface | program | package
    pub kind: String,
    pub name: String,
    pub start_line: usize,
    pub parameters: Vec<ParamDecl>,
    pub ports: Vec<PortDecl>,
    pub instances: Vec<InstanceDecl>,
    pub signals: Vec<SignalDecl>,
    pub always_blocks: Vec<AlwaysBlock>,
    pub continuous_assigns: Vec<AssignDecl>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct Stats {
    pub modules: usize,
    pub interfaces: usize,
    pub programs: usize,
    pub packages: usize,
    pub ports: usize,
    pub instances: usize,
    pub signals: usize,
    pub always_blocks: usize,
}

impl Stats {
    fn add(&mut self, unit: &DesignUnit) {
        match unit.kind.as_str() {
            "module" => self.modules += 1,
            "interface" => self.interfaces += 1,
            "program" => self.programs += 1,
            "package" => self.packages += 1,
            _ => {}
        }
        self.ports += unit.ports.len();
        self.instances += unit.instances.len();
        self.signals += unit.signals.len();
        self.always_blocks += unit.always_blocks.len();
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct AnalyzeResult {
    /// Dialect actually used to produce this result.
    pub dialect: String,
    pub parse_ok: bool,
    pub error_count: usize,
    pub issues: Vec<ParseIssue>,
    pub design_units: Vec<DesignUnit>,
    pub ast: Option<JsonValue>,
    pub stats: Stats,
}

#[derive(Debug, Clone, Serialize)]
pub struct AstNode {
    pub r#type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub field: Option<String>,
    pub error: bool,
    pub missing: bool,
    pub start: PointJson,
    pub end: PointJson,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AstNode>,
}

// ---------------------------------------------------------------------------
// Node helpers (kind-independent, works for both grammars)
// ---------------------------------------------------------------------------

fn text_of(node: &Node, code: &str) -> String {
    node.utf8_text(code.as_bytes()).unwrap_or("").trim().to_string()
}

fn is_identifier(kind: &str) -> bool {
    matches!(
        kind,
        "simple_identifier"
            | "escaped_identifier"
            | "identifier"
            | "port_identifier"
            | "package_identifier"
            | "interface_identifier"
            | "program_identifier"
            | "module_identifier"
            | "parameter_identifier"
            | "instance_identifier"
            | "variable_identifier"
            | "net_identifier"
            | "function_identifier"
            | "class_identifier"
            | "formal_port_identifier"
    )
}

/// Iterator over all children with their 0-based child index.
fn children<'t>(node: &Node<'t>) -> impl Iterator<Item = Node<'t>> {
    let n = *node; // Node<'t> is Copy
    (0..n.child_count()).filter_map(move |i| n.child(i as u32))
}

/// Iterator over named children.
fn named_children<'t>(node: &Node<'t>) -> impl Iterator<Item = Node<'t>> {
    let n = *node; // Node<'t> is Copy
    (0..n.named_child_count()).filter_map(move |i| n.named_child(i as u32))
}

/// First identifier-kind node found via DFS.
fn first_identifier<'t>(node: &Node<'t>) -> Option<Node<'t>> {
    for child in named_children(node) {
        if is_identifier(child.kind()) {
            return Some(child);
        }
        if let Some(found) = first_identifier(&child) {
            return Some(found);
        }
    }
    None
}

/// Collect identifier names while refusing to descend into expression /
/// statement / dimension subtrees (heuristic, but reliable for declarations).
fn collect_identifiers(node: &Node, code: &str, out: &mut Vec<String>) {
    for child in named_children(node) {
        let kind = child.kind();
        if is_identifier(kind) {
            let name = text_of(&child, code);
            if !name.is_empty() && !out.contains(&name) {
                out.push(name);
            }
        } else if is_declaration_container(kind) {
            collect_identifiers(&child, code, out);
        }
    }
}

/// Kinds we keep descending into while hunting declaration identifiers.
fn is_declaration_container(kind: &str) -> bool {
    matches!(
        kind,
        "list_of_net_decl_assignments"
            | "list_of_variable_decl_assignments"
            | "list_of_param_assignments"
            | "list_of_net_assignments"
            | "list_of_variable_assignments"
            | "list_of_port_identifiers"
            | "list_of_identifier"
            | "net_decl_assignment"
            | "variable_decl_assignment"
            | "param_assignment"
            | "net_lvalue"
            | "variable_lvalue"
            | "lvalue"
            | "declaration"
            | "block_item_declaration"
            | "package_item_declaration"
    )
}

fn first_named_child_of<'t>(node: &Node<'t>, kinds: &[&str]) -> Option<Node<'t>> {
    named_children(node).find(|c| kinds.contains(&c.kind()))
}

fn find_descendant_of<'t>(node: &Node<'t>, kinds: &[&str]) -> Option<Node<'t>> {
    for child in named_children(node) {
        if kinds.contains(&child.kind()) {
            return Some(child);
        }
        if let Some(found) = find_descendant_of(&child, kinds) {
            return Some(found);
        }
    }
    None
}

/// The packed width text of the first dimension node, e.g. "[7:0]".
fn dimension_text(node: &Node, code: &str) -> String {
    find_descendant_of(
        node,
        &["packed_dimension", "unpacked_dimension", "associative_dimension", "queue_dimension", "unsized_dimension"],
    )
    .map(|d| text_of(&d, code))
    .unwrap_or_default()
}

/// Best-effort port type: the type child of a port header (skipping the
/// direction). E.g. "wire", "logic".
fn port_type_of(node: &Node, code: &str) -> String {
    if let Some(header) = first_named_child_of(
        node,
        &["net_port_header", "variable_port_header", "interface_port_header", "net_port_header1", "variable_port_header1"],
    ) {
        for child in named_children(&header) {
            if child.kind() != "port_direction" && child.kind() != "tf_port_direction" {
                return text_of(&child, code);
            }
        }
        return text_of(&header, code);
    }
    String::new()
}

fn direction_of(node: &Node, code: &str) -> String {
    find_descendant_of(node, &["port_direction", "tf_port_direction"])
        .map(|d| text_of(&d, code))
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Error collection
// ---------------------------------------------------------------------------

fn count_errors(node: &Node) -> usize {
    let mut n = usize::from(node.is_error() || node.is_missing());
    for child in children(node) {
        n += count_errors(&child);
    }
    n
}

fn collect_issues(node: &Node, code: &str, cap: usize, out: &mut Vec<ParseIssue>) {
    if out.len() >= cap {
        return;
    }
    if node.is_error() || node.is_missing() {
        let kind = if node.is_missing() { "missing" } else { "error" };
        out.push(ParseIssue {
            kind: kind.to_string(),
            node_type: node.kind().to_string(),
            start: point(node.start_position()),
            end: point(node.end_position()),
            snippet: snippet_around(node, code),
        });
    }
    for child in children(node) {
        if out.len() >= cap {
            return;
        }
        collect_issues(&child, code, cap, out);
    }
}

fn snippet_around(node: &Node, code: &str) -> String {
    let text = text_of(node, code);
    if !text.is_empty() {
        let mut t = text.chars().take(60).collect::<String>();
        if t != text {
            t.push_str("...");
        }
        return t;
    }
    // Missing tokens have zero width: grab a little surrounding source.
    let bytes = code.as_bytes();
    let start = node.start_byte().saturating_sub(16);
    let end = (node.end_byte() + 16).min(bytes.len());
    let t = String::from_utf8_lossy(&bytes[start..end]).trim().to_string();
    let mut t2 = t.chars().take(60).collect::<String>();
    if t2 != t {
        t2.push_str("...");
    }
    t2
}

fn point(p: tree_sitter::Point) -> PointJson {
    PointJson { row: p.row, column: p.column }
}

// ---------------------------------------------------------------------------
// Design unit extraction
// ---------------------------------------------------------------------------

const UNIT_KINDS: &[&str] = &[
    "module_declaration",
    "interface_declaration",
    "program_declaration",
    "package_declaration",
];

fn is_design_unit(kind: &str) -> bool {
    UNIT_KINDS.contains(&kind)
}

fn unit_kind(kind: &str) -> &'static str {
    match kind {
        "interface_declaration" => "interface",
        "program_declaration" => "program",
        "package_declaration" => "package",
        _ => "module",
    }
}

fn unit_name(node: &Node, code: &str) -> String {
    // SystemVerilog grammar puts the name in a field.
    if let Some(n) = node.child_by_field_name("name") {
        return text_of(&n, code);
    }
    // Verilog grammar: header nodes carry a simple_identifier.
    for child in named_children(node) {
        if matches!(
            child.kind(),
            "module_header"
                | "module_ansi_header"
                | "module_nonansi_header"
                | "interface_ansi_header"
                | "interface_nonansi_header"
                | "program_ansi_header"
                | "program_nonansi_header"
        ) {
            if let Some(n) = child.child_by_field_name("name") {
                return text_of(&n, code);
            }
            if let Some(id) = first_identifier(&child) {
                return text_of(&id, code);
            }
        }
    }
    if let Some(id) = first_identifier(node) {
        return text_of(&id, code);
    }
    "?".to_string()
}

fn build_unit(node: &Node, code: &str) -> DesignUnit {
    let mut unit = DesignUnit {
        kind: unit_kind(node.kind()).to_string(),
        name: unit_name(node, code),
        start_line: node.start_position().row + 1,
        parameters: Vec::new(),
        ports: Vec::new(),
        instances: Vec::new(),
        signals: Vec::new(),
        always_blocks: Vec::new(),
        continuous_assigns: Vec::new(),
    };
    walk_unit(node, code, &mut unit);
    unit
}

fn walk_unit(node: &Node, code: &str, unit: &mut DesignUnit) {
    for child in named_children(node) {
        let kind = child.kind();
        match kind {
            "ansi_port_declaration" | "port_declaration" | "port" | "interface_port_declaration" => {
                collect_ports(&child, code, unit)
            }
            "parameter_declaration" | "local_parameter_declaration" | "parameter_port_declaration" => {
                collect_parameters(&child, code, unit)
            }
            "module_instantiation" | "interface_instantiation" | "program_instantiation" => {
                collect_instances(&child, code, unit)
            }
            "net_declaration" | "data_declaration" | "variable_declaration" => {
                collect_signals(&child, code, unit)
            }
            "always_construct" => collect_always(&child, code, unit),
            "continuous_assign" => collect_assigns(&child, code, unit),
            _ => {
                // Recurse through container nodes, but never into nested
                // design units (generate / ifdef bodies declare their own).
                if !is_design_unit(kind) && child.named_child_count() > 0 {
                    walk_unit(&child, code, unit);
                }
            }
        }
    }
}

fn collect_ports(node: &Node, code: &str, unit: &mut DesignUnit) {
    match node.kind() {
        "ansi_port_declaration" => {
            let name = node
                .child_by_field_name("port_name")
                .map(|n| text_of(&n, code))
                .or_else(|| first_identifier(node).map(|n| text_of(&n, code)))
                .unwrap_or_default();
            if name.is_empty() {
                return;
            }
            unit.ports.push(PortDecl {
                name,
                direction: direction_of(node, code),
                port_type: port_type_of(node, code),
                width: dimension_text(node, code),
            });
        }
        "port_declaration" | "interface_port_declaration" => {
            let direction = direction_of(node, code);
            let port_type = port_type_of(node, code);
            let width = dimension_text(node, code);
            let mut names = Vec::new();
            collect_identifiers(node, code, &mut names);
            for name in names {
                unit.ports.push(PortDecl {
                    name,
                    direction: direction.clone(),
                    port_type: port_type.clone(),
                    width: width.clone(),
                });
            }
        }
        // Non-ANSI `module foo(a, b);` — no direction known here.
        "port" => {
            let name = first_identifier(node).map(|n| text_of(&n, code)).unwrap_or_else(|| text_of(node, code));
            if !name.is_empty() {
                unit.ports.push(PortDecl { name, direction: String::new(), port_type: String::new(), width: String::new() });
            }
        }
        _ => {}
    }
}

fn collect_parameters(node: &Node, code: &str, unit: &mut DesignUnit) {
    // Name = parameter_identifier; default = text after the first '='.
    let mut push_from = |node: &Node| {
        let text = text_of(node, code);
        let (name, default) = match text.split_once('=') {
            Some((l, r)) => (l.trim().to_string(), r.trim().to_string()),
            None => (text, String::new()),
        };
        let name = name.split_whitespace().last().unwrap_or(&name).trim_matches(',').to_string();
        if !name.is_empty() {
            unit.parameters.push(ParamDecl { name, default });
        }
    };
    if node.kind() == "parameter_port_declaration" {
        push_from(node);
        return;
    }
    // Hunt param_assignment leaves.
    let mut found = false;
    collect_param_assignments(node, &mut push_from, &mut found);
    if !found {
        // Fallback: whole declaration text, split on commas then '='.
        for segment in text_of(node, code).split(',') {
            if let Some((l, r)) = segment.split_once('=') {
                let name = l.split_whitespace().last().unwrap_or("").trim().to_string();
                if !name.is_empty() {
                    unit.parameters.push(ParamDecl { name, default: r.trim().to_string() });
                }
            }
        }
    }
}

fn collect_param_assignments<F: FnMut(&Node)>(node: &Node, push: &mut F, found: &mut bool) {
    if node.kind() == "param_assignment" {
        *found = true;
        push(node);
        return;
    }
    for child in named_children(node) {
        if matches!(
            child.kind(),
            "expression" | "constant_expression" | "unary_expression" | "binary_expression" | "primary_expression"
        ) {
            continue;
        }
        collect_param_assignments(&child, push, found);
    }
}

fn collect_instances(node: &Node, code: &str, unit: &mut DesignUnit) {
    let module = node
        .child_by_field_name("instance_type")
        .map(|n| text_of(&n, code))
        .or_else(|| first_identifier(node).map(|n| text_of(&n, code)))
        .unwrap_or_default();
    if module.is_empty() {
        return;
    }
    for child in named_children(node) {
        if child.kind() == "hierarchical_instance" {
            let name = hierarchical_instance_name(&child, code);
            unit.instances.push(InstanceDecl {
                module: module.clone(),
                name,
                start_line: child.start_position().row + 1,
            });
        }
    }
}

fn hierarchical_instance_name(node: &Node, code: &str) -> String {
    // SystemVerilog grammar: hierarchical_instance -> name_of_instance(instance_name).
    if let Some(noi) = node.child_by_field_name("name_of_instance") {
        if let Some(n) = noi.child_by_field_name("instance_name") {
            return text_of(&n, code);
        }
        if let Some(id) = first_identifier(&noi) {
            return text_of(&id, code);
        }
    }
    for child in named_children(node) {
        if child.kind() == "name_of_instance" {
            if let Some(n) = child.child_by_field_name("instance_name") {
                return text_of(&n, code);
            }
            if let Some(id) = first_identifier(&child) {
                return text_of(&id, code);
            }
        }
    }
    "?".to_string()
}

fn collect_signals(node: &Node, code: &str, unit: &mut DesignUnit) {
    // typedef / nettype declarations are not signals.
    if find_descendant_of(node, &["type_declaration", "nettype_declaration"]).is_some() {
        return;
    }
    let kind = signal_kind(node, code);
    let width = dimension_text(node, code);
    let mut names = Vec::new();
    collect_identifiers(node, code, &mut names);
    for name in names {
        unit.signals.push(SignalDecl { name, kind: kind.clone(), width: width.clone() });
    }
}

fn signal_kind(node: &Node, code: &str) -> String {
    if let Some(net_type) = first_named_child_of(
        node,
        &["net_type", "integer_atom_type", "integer_vector_type", "non_integer_type"],
    ) {
        return text_of(&net_type, code);
    }
    if let Some(dt) = first_named_child_of(
        node,
        &["data_type_or_implicit", "data_type_or_implicit1", "implicit_data_type", "implicit_data_type1"],
    ) {
        if let Some(first) = dt.named_child(0) {
            return text_of(&first, code);
        }
        return text_of(&dt, code);
    }
    if node.kind().contains("parameter") {
        return "parameter".to_string();
    }
    String::new()
}

fn collect_always(node: &Node, code: &str, unit: &mut DesignUnit) {
    let mut kind = "always".to_string();
    let mut keyword_end = 0usize;
    let mut statement: Option<Node> = None;
    for child in named_children(node) {
        let k = child.kind();
        if k == "statement" {
            statement = Some(child);
        } else if k.contains("always") {
            kind = text_of(&child, code);
            keyword_end = child.end_byte();
        }
    }
    // SystemVerilog grammar: the trigger is an event_control inside the
    // statement. Verilog grammar: text between keyword and statement.
    let trigger = if let Some(stmt) = statement {
        if let Some(ev) = find_descendant_of(&stmt, &["event_control"]) {
            text_of(&ev, code)
        } else if keyword_end < stmt.start_byte() {
            code[keyword_end..stmt.start_byte()].trim().to_string()
        } else {
            String::new()
        }
    } else {
        String::new()
    };
    unit.always_blocks.push(AlwaysBlock { kind, trigger, start_line: node.start_position().row + 1 });
}

fn collect_assigns(node: &Node, code: &str, unit: &mut DesignUnit) {
    for child in named_children(node) {
        collect_assignment(&child, code, unit);
    }
}

fn collect_assignment(node: &Node, code: &str, unit: &mut DesignUnit) {
    if matches!(node.kind(), "net_assignment" | "variable_assignment") {
        let text = text_of(node, code);
        if let Some((lhs, rhs)) = text.split_once('=') {
            unit.continuous_assigns.push(AssignDecl {
                lhs: lhs.trim().to_string(),
                rhs: rhs.trim().to_string(),
                start_line: node.start_position().row + 1,
            });
        }
        return;
    }
    for child in named_children(node) {
        collect_assignment(&child, code, unit);
    }
}

// ---------------------------------------------------------------------------
// AST dump
// ---------------------------------------------------------------------------

const AST_MAX_DEPTH: usize = 64;
const AST_MAX_NODES: usize = 20_000;

fn dump_ast_rec(node: &Node, depth: usize, budget: &mut usize) -> Option<AstNode> {
    if *budget == 0 {
        return None;
    }
    *budget -= 1;
    let mut children = Vec::new();
    if depth < AST_MAX_DEPTH {
        for i in 0..node.child_count() {
            if *budget == 0 {
                break;
            }
            if let Some(child) = node.child(i as u32) {
                if !child.is_named() {
                    continue;
                }
                let field = node.field_name_for_child(i as u32);
                if let Some(mut ast_child) = dump_ast_rec(&child, depth + 1, budget) {
                    if field.is_some() {
                        ast_child.field = field.map(|s| s.to_string());
                    }
                    children.push(ast_child);
                }
            }
        }
    }
    Some(AstNode {
        r#type: node.kind().to_string(),
        field: None,
        error: node.is_error(),
        missing: node.is_missing(),
        start: point(node.start_position()),
        end: point(node.end_position()),
        children,
    })
}

pub fn dump_ast(root: &Node) -> JsonValue {
    let mut budget = AST_MAX_NODES;
    match dump_ast_rec(root, 0, &mut budget) {
        Some(node) => serde_json::to_value(node).unwrap_or(JsonValue::Null),
        None => JsonValue::Null,
    }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct AnalyzeRequest {
    pub code: String,
    #[serde(default = "default_dialect")]
    pub dialect: Dialect,
    #[serde(default)]
    pub include_ast: bool,
    #[serde(default = "default_max_errors")]
    pub max_errors: usize,
}

fn default_dialect() -> Dialect {
    Dialect::Auto
}

fn default_max_errors() -> usize {
    50
}

pub fn analyze(req: &AnalyzeRequest) -> Result<AnalyzeResult, String> {
    if req.code.is_empty() {
        return Err("empty source code".to_string());
    }
    let (tree, used) = parse(&req.code, req.dialect);
    let root = tree.root_node();

    let mut issues = Vec::new();
    collect_issues(&root, &req.code, req.max_errors.max(1), &mut issues);

    let mut units = Vec::new();
    let mut stats = Stats::default();
    for child in named_children(&root) {
        if is_design_unit(child.kind()) {
            let unit = build_unit(&child, &req.code);
            stats.add(&unit);
            units.push(unit);
        }
    }

    let ast = if req.include_ast { Some(dump_ast(&root)) } else { None };

    Ok(AnalyzeResult {
        dialect: used.as_str().to_string(),
        parse_ok: !root.has_error(),
        error_count: issues.len(),
        issues,
        design_units: units,
        ast,
        stats,
    })
}

pub fn version_info() -> JsonValue {
    json!({
        "plugin": VERSION,
        "tree_sitter_language_version": tree_sitter::LANGUAGE_VERSION,
        "grammars": [
            { "name": "tree-sitter-systemverilog", "version": "0.4.0", "scope": "SystemVerilog 1800-2023" },
            { "name": "tree-sitter-verilog", "version": "1.0.3", "scope": "Verilog / SystemVerilog" },
        ],
    })
}

// ---------------------------------------------------------------------------
// Native unit tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const COUNTER: &str = r#"
module counter #(
    parameter int WIDTH = 8
) (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        en,
    output logic [WIDTH-1:0] count,
    output logic       overflow
);
    logic [WIDTH-1:0] next_count;

    always_ff @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            count <= '0;
        end else if (en) begin
            count <= next_count;
        end
    end

    assign next_count = count + 1'b1;
    assign overflow = &count;

    reg_sync sync_inst (
        .clk(clk),
        .d(count),
        .q(count)
    );
endmodule

module reg_sync (
    input  wire clk,
    input  wire [WIDTH-1:0] d,
    output logic [WIDTH-1:0] q
);
    always_ff @(posedge clk) begin
        q <= d;
    end
endmodule
"#;

    fn analyze_counter(dialect: Dialect) -> AnalyzeResult {
        let req = AnalyzeRequest { code: COUNTER.to_string(), dialect, include_ast: false, max_errors: 50 };
        analyze(&req).expect("analyze ok")
    }

    #[test]
    fn parses_clean() {
        for dialect in [Dialect::Auto, Dialect::SystemVerilog, Dialect::Verilog] {
            let res = analyze_counter(dialect);
            assert!(res.parse_ok, "{dialect:?}: {:#?}", res.issues);
            assert_eq!(res.error_count, 0);
        }
    }

    #[test]
    fn finds_modules_and_names() {
        let res = analyze_counter(Dialect::SystemVerilog);
        let names: Vec<&str> = res.design_units.iter().map(|u| u.name.as_str()).collect();
        assert!(names.contains(&"counter"), "got {names:?}");
        assert!(names.contains(&"reg_sync"), "got {names:?}");
    }

    #[test]
    fn extracts_ports() {
        let res = analyze_counter(Dialect::SystemVerilog);
        let counter = res.design_units.iter().find(|u| u.name == "counter").unwrap();
        let ports: Vec<(&str, &str, &str)> = counter
            .ports
            .iter()
            .map(|p| (p.name.as_str(), p.direction.as_str(), p.width.as_str()))
            .collect();
        assert!(ports.contains(&("clk", "input", "")), "{ports:?}");
        assert!(ports.contains(&("rst_n", "input", "")), "{ports:?}");
        assert!(ports.contains(&("en", "input", "")), "{ports:?}");
        assert!(ports.contains(&("count", "output", "[WIDTH-1:0]")), "{ports:?}");
        assert!(ports.contains(&("overflow", "output", "")), "{ports:?}");
    }

    #[test]
    fn extracts_parameters() {
        let res = analyze_counter(Dialect::SystemVerilog);
        let counter = res.design_units.iter().find(|u| u.name == "counter").unwrap();
        assert!(
            counter.parameters.iter().any(|p| p.name == "WIDTH" && p.default == "8"),
            "{:?}",
            counter.parameters
        );
    }

    #[test]
    fn extracts_instances() {
        let res = analyze_counter(Dialect::SystemVerilog);
        let counter = res.design_units.iter().find(|u| u.name == "counter").unwrap();
        assert!(
            counter.instances.iter().any(|i| i.module == "reg_sync" && i.name == "sync_inst"),
            "{:?}",
            counter.instances
        );
    }

    #[test]
    fn extracts_signals_and_always() {
        let res = analyze_counter(Dialect::SystemVerilog);
        let counter = res.design_units.iter().find(|u| u.name == "counter").unwrap();
        assert!(counter.signals.iter().any(|s| s.name == "next_count"), "{:?}", counter.signals);
        assert!(
            counter.always_blocks.iter().any(|a| a.kind == "always_ff" && a.trigger.contains("posedge clk")),
            "{:?}",
            counter.always_blocks
        );
    }

    #[test]
    fn extracts_assigns() {
        let res = analyze_counter(Dialect::SystemVerilog);
        let counter = res.design_units.iter().find(|u| u.name == "counter").unwrap();
        assert!(counter.continuous_assigns.iter().any(|a| a.lhs == "next_count"), "{:?}", counter.continuous_assigns);
        assert!(counter.continuous_assigns.iter().any(|a| a.lhs == "overflow"), "{:?}", counter.continuous_assigns);
    }

    #[test]
    fn reports_syntax_errors() {
        let req = AnalyzeRequest {
            code: "module broken(input a; output b); endmodule".to_string(),
            dialect: Dialect::SystemVerilog,
            include_ast: false,
            max_errors: 20,
        };
        let res = analyze(&req).unwrap();
        assert!(!res.parse_ok);
        assert!(res.error_count >= 1);
    }

    #[test]
    fn ast_dump_shapes() {
        let req = AnalyzeRequest { code: "module m; endmodule".to_string(), dialect: Dialect::Auto, include_ast: true, max_errors: 10 };
        let res = analyze(&req).unwrap();
        let ast = res.ast.expect("ast present");
        assert_eq!(ast["type"], "source_file");
    }

    #[test]
    fn verilog_grammar_also_extracts() {
        let code = "module top(a, b);\ninput a;\noutput b;\nwire w;\nassign b = a & w;\nendmodule\n";
        let res = analyze(&AnalyzeRequest { code: code.to_string(), dialect: Dialect::Verilog, include_ast: false, max_errors: 10 }).unwrap();
        let top = res.design_units.iter().find(|u| u.name == "top").expect("top found");
        assert!(top.ports.iter().any(|p| p.name == "a"), "{:?}", top.ports);
        assert!(top.ports.iter().any(|p| p.name == "b"), "{:?}", top.ports);
        assert!(top.signals.iter().any(|s| s.name == "w" && s.kind == "wire"), "{:?}", top.signals);
    }
}
