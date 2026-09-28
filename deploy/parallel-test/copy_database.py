#!/usr/bin/env python3
"""Copy the live database into an EMPTY isolated candidate database.

Run on the server beside compose.yml. Never overwrites an existing candidate.
The source is read only; the dump remains available as a timestamped backup.
"""
import hashlib
import json
import subprocess
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def run(args, **kw):
    return subprocess.run(args, check=True, **kw)


def main():
    target = run(
        ["docker", "compose", "ps", "-q", "pms-db"], cwd=HERE,
        capture_output=True, text=True,
    ).stdout.strip()
    assert target, "Candidate database is not running"
    count = run(
        ["docker", "exec", target, "psql", "-U", "mbpm", "-d", "mb_pm", "-tAc",
         "select count(*) from information_schema.tables where table_schema='public'"],
        capture_output=True, text=True,
    ).stdout.strip()
    assert count == "0", "Candidate database is not empty; refusing to overwrite"
    env = dict(line.split("=", 1) for line in Path("/home/prometheus/mb-pm/.env").read_text().splitlines()
               if "=" in line and not line.startswith("#"))
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = HERE / "seed" / f"mb_pm-{stamp}.dump"
    dest.parent.mkdir(mode=0o700, exist_ok=True)
    # Password travels through stdin, never command-line arguments or logs.
    with dest.open("xb") as output:
        dest.chmod(0o600)
        run(["docker", "exec", "-i", "dikw-postgres", "sh", "-c",
             'PGPASSWORD="$(cat)" exec pg_dump -h 127.0.0.1 -U mbpm -d mb_pm -Fc --no-owner --no-acl'],
            input=env["PW_DB"].encode(), stdout=output)
    with dest.open("rb") as source:
        run(["docker", "exec", "-i", target, "pg_restore", "-U", "mbpm", "-d", "mb_pm",
             "--no-owner", "--no-acl", "--exit-on-error", "--single-transaction"], stdin=source)
    sql = """SELECT json_object_agg(t, n) FROM (
        SELECT 'projects' t, count(*) n FROM projects UNION ALL
        SELECT 'tasks', count(*) FROM tasks UNION ALL
        SELECT 'users', count(*) FROM users UNION ALL
        SELECT 'task_dependencies', count(*) FROM task_dependencies UNION ALL
        SELECT 'sub_projects', count(*) FROM sub_projects UNION ALL
        SELECT 'templates', count(*) FROM templates) q"""
    counts = json.loads(run(["docker", "exec", target, "psql", "-U", "mbpm", "-d", "mb_pm", "-tAc", sql],
                           capture_output=True, text=True).stdout)
    result = {"dump": str(dest), "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(), "restored_counts": counts}
    dest.with_suffix(".json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
