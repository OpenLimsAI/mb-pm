"""Apply only theme fields to the two existing localhost IAM applications."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile

import httpx


LOCAL_IAM_URL = "http://localhost:8001"
APPLICATIONS = ("mp-pm", "dikw-kb-local")
THEME_FIELDS = frozenset({"themeData", "formCss", "formCssMobile"})


class LocalThemeError(RuntimeError):
    """An error that is safe to display without leaking IAM response content."""


def load_control(config_path):
    try:
        seed = json.loads(Path(config_path).read_text(encoding="utf-8"))
        if not isinstance(seed, dict) or not isinstance(seed.get("applications"), list):
            raise ValueError("Invalid application list")
        candidates = [
            app for app in seed["applications"]
            if isinstance(app, dict) and app.get("name") == "mp-pm"
            and app.get("organization") == "mabpharm"
        ]
        if len(candidates) != 1:
            raise ValueError("Ambiguous local control application")
        control = candidates[0]
        if not all(isinstance(control.get(key), str) and control[key]
                   for key in ("owner", "clientId", "clientSecret")):
            raise ValueError("Incomplete local application credentials")
        if "*" in control["clientSecret"]:
            raise ValueError("Masked secret")
        return control
    except (OSError, TypeError, KeyError, ValueError) as exc:
        raise LocalThemeError("Local IAM configuration is incomplete or invalid.") from exc


def load_patch(patch_path):
    try:
        patch = json.loads(Path(patch_path).read_text(encoding="utf-8"))
        if (not isinstance(patch, dict) or set(patch) != THEME_FIELDS
                or not isinstance(patch["themeData"], dict)
                or not isinstance(patch["formCss"], str)
                or not isinstance(patch["formCssMobile"], str)):
            raise ValueError("Unexpected theme fields")
        return patch
    except (OSError, TypeError, ValueError) as exc:
        raise LocalThemeError("Theme patch must contain only themeData, formCss and formCssMobile.") from exc


def prepare_backup_root(backup_dir):
    """Refuse public permissions or a backup path that Git could accidentally stage."""
    requested = Path(backup_dir).expanduser().absolute()
    if requested.is_symlink():
        raise LocalThemeError("The private backup directory must not be a symlink.")
    root = requested.resolve()
    for parent in (root, *root.parents):
        if (parent / ".git").exists():
            try:
                ignored = subprocess.run(
                    ["git", "check-ignore", "--quiet", "--", str(root / "probe.json")],
                    cwd=parent, capture_output=True, check=False,
                )
            except OSError as exc:
                raise LocalThemeError("Cannot verify that the private backup path is ignored by Git.") from exc
            if ignored.returncode != 0:
                raise LocalThemeError("Backups inside a repository must use a Git-ignored directory.")
            break
    missing = []
    current = root
    while not current.exists():
        missing.append(current)
        current = current.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700)
    info = root.stat()
    if (not root.is_dir() or info.st_uid != os.getuid()
            or stat.S_IMODE(info.st_mode) & 0o077):
        raise LocalThemeError("The private backup directory must be owned by you and have mode 0700.")
    return root


def write_private(path, record):
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        json.dump(record, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def apply_theme(config_path, backup_dir, *, patch_path=None, transport=None):
    """Apply a local patch and roll back attempted writes if any readback differs.

    The optional transport is an in-process test seam. CLI callers cannot change
    the server URL, application allowlist or allowed update fields.
    """
    control = load_control(config_path)
    patch = load_patch(patch_path or Path(__file__).with_name("application-theme.patch.json"))
    root = prepare_backup_root(backup_dir)
    prefix = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-")
    backup = Path(tempfile.mkdtemp(prefix=prefix, dir=root))
    originals = {}
    attempted = []
    with httpx.Client(
        base_url=LOCAL_IAM_URL,
        auth=(control["clientId"], control["clientSecret"]),
        trust_env=False,
        follow_redirects=False,
        timeout=12,
        transport=transport,
    ) as client:
        def call(method, name, record=None):
            target = control["owner"] + "/" + name
            path = "/api/get-application" if method == "GET" else "/api/update-application"
            kwargs = {"params": {"id": target}}
            if record is not None:
                kwargs["json"] = record
            try:
                response = client.request(method, path, **kwargs)
                response.raise_for_status()
                body = response.json()
                if not isinstance(body, dict) or body.get("status") != "ok":
                    raise ValueError("IAM rejected operation")
                return body.get("data")
            except (httpx.HTTPError, ValueError) as exc:
                raise LocalThemeError("Local IAM did not accept the theme operation.") from exc

        # Read and save both originals before attempting either write.
        for name in APPLICATIONS:
            previous = call("GET", name)
            if (not isinstance(previous, dict)
                    or previous.get("owner") != control["owner"]
                    or previous.get("organization") != "mabpharm"
                    or previous.get("name") != name
                    or not isinstance(previous.get("clientSecret"), str)
                    or not previous["clientSecret"] or "*" in previous["clientSecret"]
                    or not isinstance(previous.get("themeData") or {}, dict)):
                raise LocalThemeError("A local application could not be safely read.")
            if name == "mp-pm" and previous["clientSecret"] != control["clientSecret"]:
                raise LocalThemeError("The local control application secret differs from its configuration.")
            originals[name] = previous
            write_private(backup / (name + ".json"), previous)

        try:
            for name in APPLICATIONS:
                previous = originals[name]
                intended = {
                    **previous,
                    **patch,
                    "themeData": {**(previous.get("themeData") or {}), **patch["themeData"]},
                }
                attempted.append(name)
                call("POST", name, intended)
                actual = call("GET", name)
                previous_other = {key: value for key, value in previous.items() if key not in THEME_FIELDS}
                actual_other = ({key: value for key, value in actual.items() if key not in THEME_FIELDS}
                                if isinstance(actual, dict) else None)
                if (actual_other != previous_other
                        or any(actual.get(key) != intended[key] for key in THEME_FIELDS)):
                    raise LocalThemeError("Local IAM readback changed fields outside the theme patch.")
        except LocalThemeError as exc:
            rollback_verified = True
            for name in reversed(attempted):
                try:
                    call("POST", name, originals[name])
                    rollback_verified = call("GET", name) == originals[name] and rollback_verified
                except LocalThemeError:
                    rollback_verified = False
            write_private(backup / "receipt.json", {
                "local_only": True, "completed": False, "rollback_verified": rollback_verified,
            })
            if not rollback_verified:
                raise LocalThemeError("Theme update failed; rollback could not be verified. Inspect the private backup before retrying.") from exc
            raise LocalThemeError("Theme update failed; attempted changes were restored and verified.") from exc

    receipt = {
        "local_only": True,
        "completed": True,
        "applications": [{"application": name, "theme_applied": True, "other_fields_preserved": True}
                         for name in APPLICATIONS],
    }
    write_private(backup / "receipt.json", receipt)
    return receipt


def main():
    parser = argparse.ArgumentParser(description="为两个既有本地 IAM 应用应用蓝色主题")
    parser.add_argument("--config", required=True, type=Path, help="本地私有 IAM 初始化配置文件路径")
    parser.add_argument("--backup-dir", required=True, type=Path, help="0700 私密备份目录；仓库内必须被 Git 忽略")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        receipt = apply_theme(args.config, args.backup_dir)
    except Exception:
        raise SystemExit("Local IAM theme operation stopped; inspect the private backup before retrying.") from None
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
