#!/usr/bin/env python3
"""Automated domain boundary & ORM isolation checker for mb-pm (CI ratchet gate).

Analyzes static imports across both:
  - Backend (`backend/app/**/*.py`) via Python AST
  - Frontend (`src/**/*.{ts,tsx}`) via ES/TS module import parsing

Enforces architectural boundaries using a baseline ratchet ("freeze legacy debt,
block every new violation"):
  1. `be-cross-orm-write`    Direct write/delete/mutation of another domain's ORM model
  2. `be-cross-orm-read`     Direct DB read (`select`/`query`/`get`) of another domain's ORM model
  3. `be-service-imports-api` Reverse layer dependency (`services/*` importing `api/*`)
  4. `be-model-imports-upper` Model layer importing `services/*` or `api/*` (strictly 0)
  5. `be-cross-domain-cycle`  Strongly connected module cycles spanning >1 business domain
  6. `be-unclassified-file`   New backend module not matched by any domain rule
  7. `fe-cross-feature`       Direct import between sibling `src/features/<A>` and `<B>`
  8. `fe-non-pm-imports-pm`   Non-PM portal/feature code importing PM/PM-AI internals

Usage:
  python3 scripts/check-domain-boundaries.py                  # CI ratchet check
  python3 scripts/check-domain-boundaries.py --strict-baseline # Also fail on stale baseline entries
  python3 scripts/check-domain-boundaries.py --strict          # Fail on ALL violations (ignore baseline)
  python3 scripts/check-domain-boundaries.py --update-baseline # Regenerate frozen baseline file
  python3 scripts/check-domain-boundaries.py --report-json out.json
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = Path(__file__).resolve().with_name("domain-boundaries.baseline.json")

# ── Backend Domain Classification Registry ────────────────────────────────────

MODEL_FILE_DOMAIN: dict[str, str] = {
    "enums": "kernel",
    "audit_log": "kernel",
    "iam": "iam_portal",
    "portal": "iam_portal",
    "user": "iam_portal",
    "project": "pm",
    "task": "pm",
    "task_collaboration": "pm",
    "template": "pm",
    "template_upgrade": "pm",
    "baseline": "pm",
    "finance": "pm",
    "planning": "pm",
    "pm_management": "pm",
    "pm_view": "pm",
    "ai": "pm_ai",
    "pm_ai": "pm_ai",
    "pm_ai_changes": "pm_ai",
    "project_ai_work": "pm_ai",
    "agent_proposal": "pm_ai",
    "agent_events": "pm_ai",
    "organization_ai": "ai_gateway",
    "solution_ai": "ai_gateway",
    "solution": "solutions",
    "assistant": "assistant",
    "information": "knowledge_sources",
    "note": "notes",
    "feedback": "feedback",
    "mdm_integration": "mdm_bridge",
}

BACKEND_EXACT_DOMAIN: dict[tuple[str, str], str] = {
    # schemas
    ("schemas", "common"): "kernel",
    ("schemas", "business_values"): "kernel",
    ("schemas", "model_network"): "kernel",
    ("schemas", "auth"): "iam_portal",
    ("schemas", "portal"): "iam_portal",
    ("schemas", "account"): "iam_portal",
    ("schemas", "accounts"): "iam_portal",
    ("schemas", "user"): "iam_portal",
    ("schemas", "project"): "pm",
    ("schemas", "task"): "pm",
    ("schemas", "structure"): "pm",
    ("schemas", "template"): "pm",
    ("schemas", "baseline"): "pm",
    ("schemas", "finance"): "pm",
    ("schemas", "ai"): "pm_ai",
    ("schemas", "agent_actions"): "pm_ai",
    ("schemas", "solution_ai"): "ai_gateway",
    ("schemas", "knowledge_ai"): "ai_gateway",
    ("schemas", "solution"): "solutions",
    ("schemas", "report_collaboration"): "solutions",
    ("schemas", "assistant"): "assistant",
    ("schemas", "mdm_integration"): "mdm_bridge",
    ("schemas", "data_backup"): "data_backup",
    # api/v1
    ("api", "auth"): "iam_portal",
    ("api", "portal"): "iam_portal",
    ("api", "portal_settings"): "iam_portal",
    ("api", "account"): "iam_portal",
    ("api", "accounts"): "iam_portal",
    ("api", "users"): "iam_portal",
    ("api", "projects"): "pm",
    ("api", "sub_projects"): "pm",
    ("api", "tasks"): "pm",
    ("api", "task_dependencies"): "pm",
    ("api", "task_collaboration"): "pm",
    ("api", "structure"): "pm",
    ("api", "templates"): "pm",
    ("api", "template_upgrade"): "pm",
    ("api", "baselines"): "pm",
    ("api", "finances"): "pm",
    ("api", "planning"): "pm",
    ("api", "progress_policy"): "pm",
    ("api", "project_exchange"): "pm",
    ("api", "pm_management"): "pm",
    ("api", "pm_views"): "pm",
    ("api", "milestones"): "pm",
    ("api", "ai"): "pm_ai",
    ("api", "project_ai_work"): "pm_ai",
    ("api", "knowledge_ai"): "ai_gateway",
    ("api", "solutions"): "solutions",
    ("api", "assistant"): "assistant",
    ("api", "knowledge_base"): "knowledge_sources",
    ("api", "information"): "knowledge_sources",
    ("api", "notes"): "notes",
    ("api", "feedback"): "feedback",
    ("api", "mdm_integration"): "mdm_bridge",
    ("api", "data_backup"): "data_backup",
    # services
    ("services", "background_workers"): "kernel",
    ("services", "accounts"): "iam_portal",
    ("services", "own_account"): "iam_portal",
    ("services", "password_policy"): "iam_portal",
    ("services", "members"): "iam_portal",
    ("services", "rollup"): "pm",
    ("services", "scope"): "pm",
    ("services", "structure"): "pm",
    ("services", "team"): "pm",
    ("services", "planning"): "pm",
    ("services", "finance"): "pm",
    ("services", "excel"): "pm",
    ("services", "project_copy"): "pm",
    ("services", "project_exchange"): "pm",
    ("services", "project_schedule_assist"): "pm",
    ("services", "template_upgrade"): "pm",
    ("services", "dependency_graph"): "pm",
    ("services", "ai"): "pm_ai",
    ("services", "organization_ai"): "ai_gateway",
    ("services", "solution_ai"): "ai_gateway",
    ("services", "shared_ai_import"): "ai_gateway",
    ("services", "knowledge_ai"): "ai_gateway",
    ("services", "answer_modes"): "ai_gateway",
    ("services", "web_search"): "ai_gateway",
    ("services", "retrieval_quality"): "ai_gateway",
    ("services", "solutions"): "solutions",
    ("services", "solution_knowledge"): "solutions",
    ("services", "solution_word"): "solutions",
    ("services", "solution_workbench"): "solutions",
    ("services", "report_collaboration"): "solutions",
    ("services", "folder_imports"): "knowledge_sources",
    ("services", "reference_download"): "knowledge_sources",
    ("services", "note_sync"): "notes",
    ("services", "feedback_workflow"): "feedback",
    ("services", "data_backup"): "data_backup",
}

# Prefix rules keep classification ergonomic when adding new modules within a domain.
BACKEND_PREFIX_RULES: tuple[tuple[str, str], ...] = (
    ("iam_", "iam_portal"),
    ("oidc_", "iam_portal"),
    ("portal_", "iam_portal"),
    ("pm_ai", "pm_ai"),
    ("project_ai_", "pm_ai"),
    ("agent_", "pm_ai"),
    ("assistant", "assistant"),
    ("knowledge_source", "knowledge_sources"),
    ("information", "knowledge_sources"),
    ("solution_", "solutions"),
    ("report_", "solutions"),
    ("note_", "notes"),
    ("feedback_", "feedback"),
    ("mdm_", "mdm_bridge"),
    ("task_", "pm"),
    ("pm_", "pm"),
    ("project_", "pm"),
    ("template_", "pm"),
    ("data_backup", "data_backup"),
)

# Shared frontend feature allowed to be consumed by other features as a common contract.
ALLOWED_SHARED_FEATURES = frozenset({"answerModes"})


@dataclass(frozen=True)
class Violation:
    rule: str
    key: str
    source: str
    target: str
    detail: str

    def to_dict(self) -> dict[str, str]:
        return {
            "rule": self.rule,
            "key": self.key,
            "source": self.source,
            "target": self.target,
            "detail": self.detail,
        }


def classify_backend_file(rel: str) -> tuple[str, str]:
    """Return `(domain, layer)` for a file path relative to `backend/app`."""
    p = rel.replace("\\", "/")
    if p in ("__init__.py", "main.py", "worker.py"):
        return ("kernel", "entry")
    parts = p.split("/")
    top = parts[0]
    stem = Path(parts[-1]).stem

    if top in ("core", "db", "middleware", "seed"):
        return ("kernel", top)
    if p in ("api/__init__.py", "api/deps.py", "api/multipart.py", "api/v1/__init__.py"):
        return ("kernel", "api")

    if top == "models":
        if stem == "__init__":
            return ("kernel", "models")
        if stem in MODEL_FILE_DOMAIN:
            return (MODEL_FILE_DOMAIN[stem], "models")
        for prefix, dom in BACKEND_PREFIX_RULES:
            if stem.startswith(prefix):
                return (dom, "models")
        return ("UNCLASSIFIED", "models")

    if top == "services" and len(parts) > 2 and parts[1] == "information":
        return ("knowledge_sources", "services")

    if stem == "__init__":
        return ("kernel", top)

    if (top, stem) in BACKEND_EXACT_DOMAIN:
        return (BACKEND_EXACT_DOMAIN[(top, stem)], top)

    for prefix, dom in BACKEND_PREFIX_RULES:
        if stem.startswith(prefix):
            return (dom, top)

    return ("UNCLASSIFIED", top)


def build_model_symbol_map(backend_dir: Path) -> dict[str, tuple[str, str]]:
    """Map ORM class name -> `(model_file_stem, owning_domain)`."""
    sym_map: dict[str, tuple[str, str]] = {}
    models_dir = backend_dir / "models"
    if not models_dir.is_dir():
        return sym_map
    for py in sorted(models_dir.glob("*.py")):
        if py.stem == "__init__":
            continue
        tree = ast.parse(py.read_text(encoding="utf-8"), str(py))
        dom, _ = classify_backend_file(f"models/{py.name}")
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                sym_map[node.name] = (py.stem, dom)
    return sym_map


def resolve_backend_module(backend_dir: Path, mod: str) -> str | None:
    if not mod.startswith("app."):
        return None
    sub = mod[4:].replace(".", "/")
    cand_file = backend_dir / f"{sub}.py"
    if cand_file.is_file():
        return f"{sub}.py"
    cand_pkg = backend_dir / sub / "__init__.py"
    if cand_pkg.is_file():
        return f"{sub}/__init__.py"
    return None


def analyze_orm_usage(
    tree: ast.AST,
    imported_models: dict[str, tuple[str, str, str]],
) -> list[dict]:
    """Detect direct ORM reads and writes for imported model aliases in a Python AST."""
    ops: dict[str, dict] = {}
    for alias, (cls_name, m_stem, m_dom) in imported_models.items():
        ops[alias] = {
            "class": cls_name,
            "model_file": f"models/{m_stem}.py",
            "model_domain": m_dom,
            "reads": [],
            "writes": [],
        }

    var_to_alias: dict[str, str] = {}
    loop_model_vars: dict[str, list[str]] = {}

    def aliases_in_expr(node: ast.AST) -> set[str]:
        found: set[str] = set()
        for n in ast.walk(node):
            if isinstance(n, ast.Name):
                if n.id in ops and ops[n.id]["model_file"] != "models/enums.py":
                    found.add(n.id)
                elif n.id in loop_model_vars:
                    found.update(loop_model_vars[n.id])
        return found

    # Pre-pass: detect `for model in (ModelA, ModelB): ...` and instance assignments
    for node in ast.walk(tree):
        if isinstance(node, ast.For) and isinstance(node.target, ast.Name):
            if isinstance(node.iter, (ast.Tuple, ast.List)):
                items = [
                    elt.id
                    for elt in node.iter.elts
                    if isinstance(elt, ast.Name)
                    and elt.id in ops
                    and ops[elt.id]["model_file"] != "models/enums.py"
                ]
                if items:
                    loop_model_vars[node.target.id] = items

        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            aliases = list(aliases_in_expr(node.value))
            if len(aliases) == 1:
                var_to_alias[node.targets[0].id] = aliases[0]
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name) and node.annotation:
            aliases = list(aliases_in_expr(node.annotation))
            if len(aliases) == 1:
                var_to_alias[node.target.id] = aliases[0]
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            for arg in node.args.args + node.args.kwonlyargs:
                if arg.annotation:
                    aliases = list(aliases_in_expr(arg.annotation))
                    if len(aliases) == 1:
                        var_to_alias[arg.arg] = aliases[0]

    # Pass 2: calls & mutations
    for node in ast.walk(tree):
        lineno = getattr(node, "lineno", 0)
        if isinstance(node, ast.Call):
            fn = node.func
            if isinstance(fn, ast.Name) and fn.id in ops:
                if ops[fn.id]["model_file"] != "models/enums.py":
                    ops[fn.id]["writes"].append(f"L{lineno}:instantiate({ops[fn.id]['class']})")
            elif isinstance(fn, ast.Name) and fn.id in ("select", "exists"):
                for a in aliases_in_expr(node):
                    ops[a]["reads"].append(f"L{lineno}:{fn.id}({ops[a]['class']})")
            elif isinstance(fn, ast.Name) and fn.id in ("insert", "update", "delete"):
                for a in aliases_in_expr(node):
                    ops[a]["writes"].append(f"L{lineno}:{fn.id}({ops[a]['class']})")
            elif isinstance(fn, ast.Attribute):
                attr = fn.attr
                if attr in ("query", "get", "scalars", "scalar"):
                    for arg in node.args:
                        for a in aliases_in_expr(arg):
                            ops[a]["reads"].append(f"L{lineno}:db.{attr}({ops[a]['class']})")
                elif attr in ("add", "add_all", "merge", "delete"):
                    if attr == "delete" and isinstance(fn.value, ast.Call):
                        # Chained query delete: db.query(Model).filter(...).delete()
                        for a in aliases_in_expr(fn.value):
                            ops[a]["writes"].append(f"L{lineno}:query.delete({ops[a]['class']})")
                    for arg in node.args:
                        if isinstance(arg, ast.Name) and arg.id in var_to_alias:
                            a = var_to_alias[arg.id]
                            ops[a]["writes"].append(f"L{lineno}:db.{attr}({arg.id}:{ops[a]['class']})")
                        else:
                            for a in aliases_in_expr(arg):
                                ops[a]["writes"].append(f"L{lineno}:db.{attr}({ops[a]['class']})")
                elif attr == "update" and isinstance(fn.value, ast.Call):
                    for a in aliases_in_expr(fn.value):
                        ops[a]["writes"].append(f"L{lineno}:query.update({ops[a]['class']})")

        elif isinstance(node, (ast.Assign, ast.AugAssign)):
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            for t in targets:
                if isinstance(t, ast.Attribute) and isinstance(t.value, ast.Name):
                    v = t.value.id
                    if v in var_to_alias:
                        a = var_to_alias[v]
                        ops[a]["writes"].append(f"L{lineno}:mutate({v}.{t.attr})")

    return list(ops.values())


def tarjan_sccs(nodes: Iterable[str], graph: dict[str, set[str]]) -> list[list[str]]:
    index_counter = 0
    stack: list[str] = []
    on_stack: set[str] = set()
    index: dict[str, int] = {}
    lowlink: dict[str, int] = {}
    result: list[list[str]] = []

    def visit(v: str) -> None:
        nonlocal index_counter
        index[v] = lowlink[v] = index_counter
        index_counter += 1
        stack.append(v)
        on_stack.add(v)
        for w in sorted(graph.get(v, ())):
            if w not in index:
                visit(w)
                lowlink[v] = min(lowlink[v], lowlink[w])
            elif w in on_stack:
                lowlink[v] = min(lowlink[v], index[w])
        if lowlink[v] == index[v]:
            comp: list[str] = []
            while True:
                w = stack.pop()
                on_stack.remove(w)
                comp.append(w)
                if w == v:
                    break
            if len(comp) > 1:
                result.append(sorted(comp))

    for n in sorted(nodes):
        if n not in index:
            visit(n)
    return result


def analyze_backend(repo_root: Path) -> tuple[list[Violation], dict]:
    backend_dir = repo_root / "backend" / "app"
    violations: list[Violation] = []
    if not backend_dir.is_dir():
        return violations, {"total_files": 0}

    sym_map = build_model_symbol_map(backend_dir)
    files = sorted(f for f in backend_dir.rglob("*.py") if "__pycache__" not in f.parts)
    file_domains: dict[str, str] = {}
    module_graph: dict[str, set[str]] = defaultdict(set)
    domain_edges: Counter[tuple[str, str]] = Counter()

    for py in files:
        rel = str(py.relative_to(backend_dir)).replace("\\", "/")
        dom, layer = classify_backend_file(rel)
        file_domains[rel] = dom
        if dom == "UNCLASSIFIED":
            violations.append(
                Violation(
                    rule="be-unclassified-file",
                    key=f"be-unclassified-file|{rel}",
                    source=rel,
                    target="",
                    detail=f"Unclassified backend file `{rel}`; register it in scripts/check-domain-boundaries.py",
                )
            )

        tree = ast.parse(py.read_text(encoding="utf-8"), str(py))
        imported_models: dict[str, tuple[str, str, str]] = {}

        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom) and node.module and node.module.startswith("app."):
                mod = node.module
                if mod == "app.models":
                    for alias in node.names:
                        cls = alias.name
                        local = alias.asname or cls
                        if cls in sym_map:
                            m_stem, m_dom = sym_map[cls]
                            target_rel = f"models/{m_stem}.py"
                            module_graph[rel].add(target_rel)
                            imported_models[local] = (cls, m_stem, m_dom)
                            if dom != "kernel" and m_dom != "kernel" and dom != m_dom:
                                domain_edges[(dom, m_dom)] += 1
                        else:
                            trel = resolve_backend_module(backend_dir, f"app.models.{cls}")
                            if trel:
                                tdom, _ = classify_backend_file(trel)
                                module_graph[rel].add(trel)
                                if dom != "kernel" and tdom != "kernel" and dom != tdom:
                                    domain_edges[(dom, tdom)] += 1
                    continue

                if mod.startswith("app.models."):
                    m_stem = mod.split(".")[2]
                    m_dom, _ = classify_backend_file(f"models/{m_stem}.py")
                    target_rel = f"models/{m_stem}.py"
                    module_graph[rel].add(target_rel)
                    for alias in node.names:
                        cls = alias.name
                        local = alias.asname or cls
                        if cls in sym_map:
                            imported_models[local] = (cls, m_stem, m_dom)
                        if dom != "kernel" and m_dom != "kernel" and dom != m_dom:
                            domain_edges[(dom, m_dom)] += 1
                    continue

                trel = resolve_backend_module(backend_dir, mod)
                resolved_targets: list[tuple[str, str]] = []
                is_pkg_dir = (backend_dir / mod[4:].replace(".", "/")).is_dir()
                if (trel and trel.endswith("/__init__.py")) or (trel is None and is_pkg_dir):
                    for alias in node.names:
                        sub_rel = resolve_backend_module(backend_dir, f"{mod}.{alias.name}")
                        if sub_rel:
                            resolved_targets.append((sub_rel, alias.name))
                        elif trel:
                            resolved_targets.append((trel, alias.name))
                elif trel:
                    resolved_targets.append((trel, ",".join(a.name for a in node.names)))

                for eff_rel, sym_desc in resolved_targets:
                    tdom, tlayer = classify_backend_file(eff_rel)
                    module_graph[rel].add(eff_rel)
                    if dom != "kernel" and tdom != "kernel" and dom != tdom:
                        domain_edges[(dom, tdom)] += 1
                    if layer == "services" and tlayer == "api":
                        violations.append(
                            Violation(
                                rule="be-service-imports-api",
                                key=f"be-service-imports-api|{rel}->{eff_rel}",
                                source=rel,
                                target=eff_rel,
                                detail=f"L{node.lineno}: service `{rel}` imports api `{eff_rel}` ({sym_desc})",
                            )
                        )
                    if layer == "models" and tlayer in ("services", "api"):
                        violations.append(
                            Violation(
                                rule="be-model-imports-upper",
                                key=f"be-model-imports-upper|{rel}->{eff_rel}",
                                source=rel,
                                target=eff_rel,
                                detail=f"L{node.lineno}: model `{rel}` imports {tlayer} `{eff_rel}` ({sym_desc})",
                            )
                        )

            elif isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name.startswith("app."):
                        trel = resolve_backend_module(backend_dir, alias.name)
                        if trel:
                            tdom, tlayer = classify_backend_file(trel)
                            module_graph[rel].add(trel)
                            if dom != "kernel" and tdom != "kernel" and dom != tdom:
                                domain_edges[(dom, tdom)] += 1
                            if layer == "services" and tlayer == "api":
                                violations.append(
                                    Violation(
                                        rule="be-service-imports-api",
                                        key=f"be-service-imports-api|{rel}->{trel}",
                                        source=rel,
                                        target=trel,
                                        detail=f"L{node.lineno}: service `{rel}` imports api `{trel}`",
                                    )
                                )
                            if layer == "models" and tlayer in ("services", "api"):
                                violations.append(
                                    Violation(
                                        rule="be-model-imports-upper",
                                        key=f"be-model-imports-upper|{rel}->{trel}",
                                        source=rel,
                                        target=trel,
                                        detail=f"L{node.lineno}: model `{rel}` imports {tlayer} `{trel}`",
                                    )
                                )

        # Check direct cross-domain ORM reads and writes
        if imported_models and layer != "models" and dom not in ("kernel", "UNCLASSIFIED"):
            for u in analyze_orm_usage(tree, imported_models):
                m_dom = u["model_domain"]
                if u["model_file"] == "models/enums.py" or m_dom in ("kernel", dom, "UNCLASSIFIED"):
                    continue
                if u["writes"]:
                    violations.append(
                        Violation(
                            rule="be-cross-orm-write",
                            key=f"be-cross-orm-write|{rel}|{dom}->{m_dom}|{u['class']}",
                            source=rel,
                            target=f"{u['model_file']}:{u['class']}",
                            detail=f"{dom} `{rel}` directly writes {m_dom} model `{u['class']}` ({', '.join(u['writes'][:3])})",
                        )
                    )
                elif u["reads"]:
                    violations.append(
                        Violation(
                            rule="be-cross-orm-read",
                            key=f"be-cross-orm-read|{rel}|{dom}->{m_dom}|{u['class']}",
                            source=rel,
                            target=f"{u['model_file']}:{u['class']}",
                            detail=f"{dom} `{rel}` directly reads {m_dom} model `{u['class']}` ({', '.join(u['reads'][:3])})",
                        )
                    )

    # Check cross-domain module cycles (Tarjan SCC)
    all_sccs = tarjan_sccs(file_domains.keys(), module_graph)
    cross_domain_sccs = []
    for comp in all_sccs:
        doms = sorted({file_domains[m] for m in comp if file_domains[m] != "kernel"})
        if len(doms) > 1:
            cross_domain_sccs.append(comp)
            violations.append(
                Violation(
                    rule="be-cross-domain-cycle",
                    key=f"be-cross-domain-cycle|{'+'.join(doms)}|{','.join(comp)}",
                    source=",".join(comp),
                    target="+".join(doms),
                    detail=f"Cross-domain module cycle across {doms}: {comp}",
                )
            )

    stats = {
        "total_files": len(files),
        "domain_counts": dict(sorted(Counter(file_domains.values()).items())),
        "all_sccs": all_sccs,
        "cross_domain_sccs": cross_domain_sccs,
        "top_domain_edges": {f"{a}->{b}": c for (a, b), c in domain_edges.most_common(25)},
    }
    return violations, stats


# ── Frontend Static Import Analysis ───────────────────────────────────────────

IMPORT_RE = re.compile(
    r"""(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)""",
    re.MULTILINE,
)


def classify_frontend_file(rel: str) -> str:
    p = rel.replace("\\", "/")
    parts = p.split("/")
    top = parts[0]

    if top == "features" and len(parts) >= 2:
        return "ai_gateway" if parts[1] == "answerModes" else parts[1]

    if top == "pages":
        stem = Path(parts[-1]).stem.split(".")[0]
        if stem in (
            "Home", "Projects", "ProjectDetail", "ProjectCreate", "Tasks", "Gantt", "GanttPage",
            "Workload", "Finance", "Templates", "TemplateDetail", "TemplateEditor", "TemplatePreview",
        ):
            return "pm"
        if stem in ("ProjectAssistant", "ProjectAssistantNavigation"):
            return "pm_ai"
        if stem in ("AISettings", "PortalAISettings"):
            return "ai_gateway"
        if stem in ("Login", "Workspace", "PortalAccounts", "PortalSettings", "PortalLaunch", "PortalHelp", "ReleaseNotes"):
            return "iam_portal"
        page_map = {
            "Solutions": "solutions",
            "Assistant": "assistant",
            "Notes": "notes",
            "Feedback": "feedback",
            "FeedbackDiscussion": "feedback",
            "FeedbackV2": "feedback",
            "DataBackup": "data-backup",
            "KnowledgeSources": "knowledge-sources",
            "Information": "information",
        }
        return page_map.get(stem, "kernel")

    if top == "components":
        if len(parts) == 2:
            return "kernel"
        sub = parts[1]
        if p == "components/auth/ProjectReadyGate.tsx":
            return "pm"
        if sub in ("ui", "layout", "application"):
            return "kernel"
        if sub in ("auth", "account", "accounts", "portal", "settings"):
            return "iam_portal"
        if sub == "ai":
            return "pm_ai"
        return "pm"

    if top == "api":
        stem = Path(parts[-1]).stem.split(".")[0]
        if stem in ("client", "index", "types"):
            return "kernel"
        if stem in ("auth", "iamLogin", "portal", "accounts", "users"):
            return "iam_portal"
        if stem in ("ai", "pmAI", "projectAIWork"):
            return "pm_ai"
        return "pm"

    if top == "store":
        stem = Path(parts[-1]).stem.split(".")[0]
        if stem in ("auth", "portal", "sessionContinuity"):
            return "iam_portal"
        return "pm"

    if top == "lib":
        stem = Path(parts[-1]).stem.split(".")[0]
        if stem in ("cn", "permissions", "site", "useColumnWidth"):
            return "kernel"
        if stem in ("account", "accountAdmin"):
            return "iam_portal"
        if stem in ("modelPricing", "modelPricingData"):
            return "ai_gateway"
        if stem in ("projectAnalysisText", "projectAssistantNavigation"):
            return "pm_ai"
        return "pm"

    if top in ("data", "mock"):
        return "pm"

    return "kernel"


def resolve_ts_import(frontend_dir: Path, src_file: Path, spec: str) -> str | None:
    if not (spec.startswith(".") or spec.startswith("@/")):
        return None
    base = (frontend_dir / spec[2:]) if spec.startswith("@/") else (src_file.parent / spec)
    candidates = [
        base,
        base.with_suffix(".ts"),
        base.with_suffix(".tsx"),
        base.with_suffix(".js"),
        base.with_suffix(".mjs"),
        base / "index.ts",
        base / "index.tsx",
        base / "index.js",
    ]
    for cand in candidates:
        if cand.is_file():
            try:
                return str(cand.resolve().relative_to(frontend_dir.resolve())).replace("\\", "/")
            except ValueError:
                return None
    return None


def analyze_frontend(repo_root: Path) -> tuple[list[Violation], dict]:
    frontend_dir = repo_root / "src"
    violations: list[Violation] = []
    if not frontend_dir.is_dir():
        return violations, {"total_files": 0}

    files: list[Path] = []
    for ext in ("*.ts", "*.tsx"):
        for f in sorted(frontend_dir.rglob(ext)):
            rel = str(f.relative_to(frontend_dir)).replace("\\", "/")
            if rel.startswith("test/") or ".test." in rel or ".spec." in rel or rel.endswith(".d.ts"):
                continue
            files.append(f)

    domain_counts: Counter[str] = Counter()
    domain_edges: Counter[tuple[str, str]] = Counter()

    for f in files:
        rel = str(f.relative_to(frontend_dir)).replace("\\", "/")
        dom = classify_frontend_file(rel)
        domain_counts[dom] += 1
        txt = f.read_text(encoding="utf-8", errors="ignore")

        for m in IMPORT_RE.finditer(txt):
            spec = m.group(1) or m.group(2)
            trel = resolve_ts_import(frontend_dir, f, spec)
            if not trel or trel.endswith(".css"):
                continue
            tdom = classify_frontend_file(trel)
            if dom != "kernel" and tdom != "kernel" and dom != tdom:
                domain_edges[(dom, tdom)] += 1

            # Rule 7: Sibling feature-to-feature direct imports (excluding shared answerModes)
            if rel.startswith("features/") and trel.startswith("features/"):
                src_feat = rel.split("/")[1]
                dst_feat = trel.split("/")[1]
                if src_feat != dst_feat and dst_feat not in ALLOWED_SHARED_FEATURES:
                    violations.append(
                        Violation(
                            rule="fe-cross-feature",
                            key=f"fe-cross-feature|{rel}->{trel}",
                            source=rel,
                            target=trel,
                            detail=f"Feature `{src_feat}` (`{rel}`) directly imports sibling feature `{dst_feat}` (`{trel}`)",
                        )
                    )

            # Rule 8: Non-PM modules importing PM/PM-AI internals
            if dom not in ("pm", "pm_ai", "kernel") and tdom in ("pm", "pm_ai"):
                violations.append(
                    Violation(
                        rule="fe-non-pm-imports-pm",
                        key=f"fe-non-pm-imports-pm|{rel}->{trel}",
                        source=rel,
                        target=trel,
                        detail=f"Non-PM domain `{dom}` (`{rel}`) directly imports `{tdom}` module (`{trel}`)",
                    )
                )

    stats = {
        "total_files": len(files),
        "domain_counts": dict(sorted(domain_counts.items())),
        "top_domain_edges": {f"{a}->{b}": c for (a, b), c in domain_edges.most_common(25)},
    }
    return violations, stats


# ── Deduplication & Ratchet Comparison ────────────────────────────────────────

def collect_all(repo_root: Path) -> tuple[dict[str, Violation], dict]:
    be_v, be_stats = analyze_backend(repo_root)
    fe_v, fe_stats = analyze_frontend(repo_root)
    unique: dict[str, Violation] = {}
    for v in be_v + fe_v:
        unique.setdefault(v.key, v)
    return unique, {"backend": be_stats, "frontend": fe_stats}


def load_baseline(path: Path) -> set[str]:
    if not path.is_file():
        return set()
    data = json.loads(path.read_text(encoding="utf-8"))
    return set(data.get("allowed_violations", []))


def save_baseline(path: Path, violations: dict[str, Violation]) -> None:
    by_rule = Counter(v.rule for v in violations.values())
    payload = {
        "schema_version": 1,
        "policy": "ratchet",
        "description": "Frozen legacy boundary debt for mb-pm. CI blocks any new violation not listed here; prune entries as modules are decoupled.",
        "summary_by_rule": dict(sorted(by_rule.items())),
        "allowed_violations": sorted(violations.keys()),
    }
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Check mb-pm backend & frontend domain boundaries.")
    parser.add_argument("--repo-root", type=Path, default=REPO_ROOT, help="Repository root path")
    parser.add_argument("--baseline", type=Path, default=DEFAULT_BASELINE, help="Baseline JSON path")
    parser.add_argument("--strict", action="store_true", help="Ignore baseline and fail on any violation")
    parser.add_argument("--strict-baseline", action="store_true", help="Also fail if baseline contains stale fixed entries")
    parser.add_argument("--update-baseline", action="store_true", help="Write current violations to baseline file and exit 0")
    parser.add_argument("--report-json", type=Path, default=None, help="Write full structured report JSON")
    args = parser.parse_args(argv)

    violations, stats = collect_all(args.repo_root.resolve())

    if args.update_baseline:
        save_baseline(args.baseline, violations)
        print(f"Updated baseline {args.baseline} with {len(violations)} frozen entries.")
        return 0

    baseline_keys = set() if args.strict else load_baseline(args.baseline)
    current_keys = set(violations.keys())
    new_keys = sorted(current_keys - baseline_keys)
    stale_keys = sorted(baseline_keys - current_keys)

    by_rule = Counter(v.rule for v in violations.values())
    report = {
        "mode": "strict" if args.strict else "ratchet",
        "total_violations": len(violations),
        "baseline_count": len(baseline_keys),
        "new_violations_count": len(new_keys),
        "stale_baseline_count": len(stale_keys),
        "summary_by_rule": dict(sorted(by_rule.items())),
        "new_violations": [violations[k].to_dict() for k in new_keys],
        "stale_baseline": stale_keys,
        "stats": stats,
    }
    if args.report_json:
        args.report_json.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print("=== mb-pm Domain Boundary Check ===")
    print(
        f"Backend files: {stats['backend']['total_files']} | "
        f"Frontend non-test files: {stats['frontend']['total_files']}"
    )
    print(f"Violation summary by rule: {json.dumps(dict(sorted(by_rule.items())), ensure_ascii=False)}")
    print(
        f"Mode: {report['mode']} | Total: {len(violations)} | "
        f"Baseline: {len(baseline_keys)} | New: {len(new_keys)} | Stale: {len(stale_keys)}"
    )

    if new_keys:
        print("\n[FAIL] New domain boundary violations detected:")
        for k in new_keys:
            v = violations[k]
            print(f"  - [{v.rule}] {v.detail}")
            print(f"      key: {v.key}")

    if stale_keys:
        tag = "[FAIL]" if args.strict_baseline else "[INFO]"
        print(f"\n{tag} {len(stale_keys)} baseline entries have been resolved and can be pruned:")
        for k in stale_keys[:20]:
            print(f"  - {k}")
        if len(stale_keys) > 20:
            print(f"  ... and {len(stale_keys) - 20} more")

    if new_keys:
        return 1
    if args.strict_baseline and stale_keys:
        return 1

    print("\n[PASS] No new domain boundary violations.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
