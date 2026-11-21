#!/usr/bin/env python3
"""Unit tests for scripts/check-domain-boundaries.py."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = Path(__file__).resolve().with_name("check-domain-boundaries.py")
REPO_ROOT = SCRIPT_PATH.parents[1]
BASELINE_PATH = Path(__file__).resolve().with_name("domain-boundaries.baseline.json")


def load_checker():
    spec = importlib.util.spec_from_file_location("check_domain_boundaries", SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


checker = load_checker()


def write_tree(root: Path, files: dict[str, str]) -> None:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


class DomainBoundaryLiveRepoTest(unittest.TestCase):
    def test_live_repo_passes_ratchet_with_zero_unclassified_and_zero_stale(self) -> None:
        violations, stats = checker.collect_all(REPO_ROOT)
        self.assertGreater(stats["backend"]["total_files"], 150)
        self.assertGreater(stats["frontend"]["total_files"], 250)
        unclassified = [v for v in violations.values() if v.rule == "be-unclassified-file"]
        self.assertEqual(unclassified, [], f"Found unclassified backend files: {unclassified}")
        model_up = [v for v in violations.values() if v.rule == "be-model-imports-upper"]
        self.assertEqual(model_up, [], f"Models must never import services/api: {model_up}")

        exit_code = checker.main(
            [
                "--repo-root",
                str(REPO_ROOT),
                "--baseline",
                str(BASELINE_PATH),
                "--strict-baseline",
            ]
        )
        self.assertEqual(exit_code, 0)


class DomainBoundarySyntheticRulesTest(unittest.TestCase):
    def _base_files(self) -> dict[str, str]:
        return {
            "backend/app/__init__.py": "",
            "backend/app/models/__init__.py": (
                "from app.models.task import Task\n"
                "from app.models.note import PersonalNote\n"
                "from app.models.ai import ProjectAIAnalysis\n"
            ),
            "backend/app/models/task.py": "class Task:\n    pass\n",
            "backend/app/models/note.py": "class PersonalNote:\n    pass\n",
            "backend/app/models/ai.py": "class ProjectAIAnalysis:\n    pass\n",
            "backend/app/api/v1/tasks.py": "def create_task():\n    return None\n",
            "backend/app/services/solutions.py": "def ok():\n    return True\n",
            "src/features/notes/client.ts": "export const fetchNotes = () => [];\n",
            "src/features/solutions/SolutionsApp.tsx": "export const App = () => null;\n",
            "src/features/answerModes/types.ts": "export type Mode = 'auto';\n",
            "src/store/data.ts": "export const useDataStore = () => ({});\n",
            "src/pages/PortalSettings.tsx": "export const PortalSettings = () => null;\n",
        }

    def test_detects_direct_and_loop_cross_domain_orm_writes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self._base_files()
            files["backend/app/services/note_sync.py"] = (
                "from app.models import Task\n"
                "def bad(db):\n"
                "    t = Task()\n"
                "    db.add(t)\n"
            )
            files["backend/app/api/v1/projects.py"] = (
                "from app.models import ProjectAIAnalysis\n"
                "def cleanup(db, pid):\n"
                "    for model in (ProjectAIAnalysis,):\n"
                "        db.query(model).filter_by(project_id=pid).delete()\n"
            )
            write_tree(root, files)

            violations, _ = checker.collect_all(root)
            self.assertIn("be-cross-orm-write|services/note_sync.py|notes->pm|Task", violations)
            self.assertIn(
                "be-cross-orm-write|api/v1/projects.py|pm->pm_ai|ProjectAIAnalysis",
                violations,
            )

    def test_detects_cross_domain_orm_read(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self._base_files()
            files["backend/app/services/assistant_projects.py"] = (
                "from sqlalchemy import select\n"
                "from app.models import Task\n"
                "def list_tasks(db):\n"
                "    return db.scalars(select(Task)).all()\n"
            )
            write_tree(root, files)

            violations, _ = checker.collect_all(root)
            self.assertIn(
                "be-cross-orm-read|services/assistant_projects.py|assistant->pm|Task",
                violations,
            )

    def test_detects_layer_inversions_and_cross_domain_cycles(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self._base_files()
            files["backend/app/services/pm_ai_changes.py"] = (
                "from app.api.v1 import tasks\n"
                "from app.services import organization_ai\n"
            )
            files["backend/app/services/organization_ai.py"] = (
                "from app.services import pm_ai_changes\n"
            )
            files["backend/app/models/note.py"] = (
                "from app.services import solutions\n"
                "class PersonalNote:\n"
                "    pass\n"
            )
            write_tree(root, files)

            violations, _ = checker.collect_all(root)
            self.assertIn(
                "be-service-imports-api|services/pm_ai_changes.py->api/v1/tasks.py",
                violations,
            )
            self.assertIn(
                "be-model-imports-upper|models/note.py->services/solutions.py",
                violations,
            )
            cycle_keys = [k for k in violations if k.startswith("be-cross-domain-cycle|")]
            self.assertEqual(len(cycle_keys), 1)
            self.assertIn("ai_gateway+pm_ai", cycle_keys[0])

    def test_detects_unclassified_backend_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self._base_files()
            files["backend/app/services/mystery_module.py"] = "VALUE = 1\n"
            write_tree(root, files)

            violations, _ = checker.collect_all(root)
            self.assertIn("be-unclassified-file|services/mystery_module.py", violations)

    def test_frontend_cross_feature_and_non_pm_leak_rules(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            files = self._base_files()
            # Allowed shared feature import (`answerModes`) should NOT trigger
            files["src/features/solutions/SolutionsApp.tsx"] = (
                "import type { Mode } from '../answerModes/types'\n"
                "import { fetchNotes } from '../notes/client'\n"
                "export const App = () => [fetchNotes, '' as Mode]\n"
            )
            # Non-PM portal page importing PM store MUST trigger
            files["src/pages/PortalSettings.tsx"] = (
                "import { useDataStore } from '../store/data'\n"
                "export const PortalSettings = () => useDataStore()\n"
            )
            write_tree(root, files)

            violations, _ = checker.collect_all(root)
            self.assertIn(
                "fe-cross-feature|features/solutions/SolutionsApp.tsx->features/notes/client.ts",
                violations,
            )
            self.assertNotIn(
                "fe-cross-feature|features/solutions/SolutionsApp.tsx->features/answerModes/types.ts",
                violations,
            )
            self.assertIn(
                "fe-non-pm-imports-pm|pages/PortalSettings.tsx->store/data.ts",
                violations,
            )

    def test_ratchet_blocks_new_violation_and_flags_stale_baseline(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            baseline = root / "baseline.json"
            files = self._base_files()
            write_tree(root, files)

            # Empty baseline passes on clean synthetic repo
            baseline.write_text(json.dumps({"allowed_violations": []}), encoding="utf-8")
            self.assertEqual(
                checker.main(["--repo-root", str(root), "--baseline", str(baseline)]),
                0,
            )

            # Add new violation -> ratchet must fail
            (root / "src/pages/PortalSettings.tsx").write_text(
                "import { useDataStore } from '../store/data'\nexport const x = useDataStore;\n",
                encoding="utf-8",
            )
            self.assertEqual(
                checker.main(["--repo-root", str(root), "--baseline", str(baseline)]),
                1,
            )

            # Freeze violation in baseline -> ratchet passes
            self.assertEqual(
                checker.main(
                    ["--repo-root", str(root), "--baseline", str(baseline), "--update-baseline"]
                ),
                0,
            )
            self.assertEqual(
                checker.main(["--repo-root", str(root), "--baseline", str(baseline)]),
                0,
            )

            # Fix violation -> normal ratchet passes, --strict-baseline flags stale entry
            (root / "src/pages/PortalSettings.tsx").write_text(
                "export const PortalSettings = () => null;\n",
                encoding="utf-8",
            )
            self.assertEqual(
                checker.main(["--repo-root", str(root), "--baseline", str(baseline)]),
                0,
            )
            self.assertEqual(
                checker.main(
                    ["--repo-root", str(root), "--baseline", str(baseline), "--strict-baseline"]
                ),
                1,
            )


if __name__ == "__main__":
    unittest.main()
