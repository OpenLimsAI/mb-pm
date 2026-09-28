#!/usr/bin/env python3
"""Provision only active customer users in the NEW IAM; preserve existing accounts."""
import json
import subprocess
from datetime import datetime, timezone
from uuid import uuid4
import setup


def main():
    rows = json.loads(subprocess.run(
        ["docker", "compose", "exec", "-T", "pms-db", "psql", "-U", "mbpm", "-d", "mb_pm", "-tAc",
         "select coalesce(json_agg(u),'[]'::json) from (select username,display_name,email,role from users where is_active order by username) u"],
        check=True, capture_output=True, text=True, cwd=setup.HERE).stdout)
    allowed = {r for r, _ in setup.ROLES}
    accounts = setup.HERE / "ACCOUNTS.private.txt"
    current = {line.split("\t")[0] for line in accounts.read_text().splitlines() if line and not line.startswith("#")}
    for user in rows:
        name, role = user["username"], user["role"]
        assert role in allowed, f"Unsupported role for {name}"
        if name in current:
            continue
        existing = setup.casdoor("GET", "get-user", params={"id":f"{setup.ORG}/{name}"})["data"]
        assert existing is None, f"Existing IAM user without local credentials: {name}"
        password = setup.password(20)
        # Record generated password before provisioning for interrupted-run recovery.
        pending = setup.HERE / f"{name}.private.json"
        setup.write(pending, json.dumps({"username":name,"password":password}))
        setup.casdoor("POST", "add-user", body={
            "owner":setup.ORG,"name":name,"id":str(uuid4()),"type":"normal-user",
            "password":password,"displayName":user["display_name"],"email":user["email"],
            "isAdmin":False,"signupApplication":setup.APP,
            "createdTime":datetime.now(timezone.utc).isoformat(),
        })
        role_data = setup.casdoor("GET", "get-role", params={"id":f"{setup.ORG}/{role}"})["data"]
        member = f"{setup.ORG}/{name}"
        role_data["users"] = list(dict.fromkeys([*(role_data.get("users") or []), member]))
        setup.casdoor("POST", "update-role", params={"id":f"{setup.ORG}/{role}"}, body=role_data)
        with accounts.open("a") as handle:
            handle.write(f"{name}\t{role}\t{password}\n")
        accounts.chmod(0o600)
        pending.unlink()
        print(f"Provisioned {name}: {role}")
    print(f"Active users checked: {len(rows)}; inactive users excluded")


if __name__ == "__main__":
    main()
