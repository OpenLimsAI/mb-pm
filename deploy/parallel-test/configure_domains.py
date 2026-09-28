#!/usr/bin/env python3
"""Configure the existing candidate IAM for the agreed production hostnames.

Run beside compose.yml, then recreate casdoor and app with the production overlay.
Does not publish DNS/routes, change accounts/roles, or touch the old deployment.
"""
import json
from datetime import datetime, timezone
import setup

PMS = "https://pm.openlims.ai"
IAM = "https://iam.openlims.ai"


def main():
    app = setup.casdoor("GET", "get-application", params={"id":"admin/mp-pm"})["data"]
    org = setup.casdoor("GET", "get-organization", params={"id":"admin/mabpharm"})["data"]
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = setup.HERE / "private-config-backups" / stamp
    backup.mkdir(parents=True, mode=0o700)
    setup.write(backup / "iam.private.json", json.dumps({"application":app,"organization":org}))
    for name in (".env", "app.conf"):
        setup.write(backup / name, (setup.HERE / name).read_text())
    app.update(homepageUrl=PMS, logo=IAM+"/files/maibo-logo.png",
               redirectUris=[PMS+"/api/v1/auth/callback", PMS+"/login"])
    setup.casdoor("POST", "update-application", params={"id":"admin/mp-pm"}, body=app)
    org.update(favicon=IAM+"/files/favicon.png", defaultAvatar=IAM+"/files/maibo-logo.png")
    setup.casdoor("POST", "update-organization", params={"id":"admin/mabpharm"}, body=org)
    env = setup.read_env(setup.HERE / ".env")
    env.update(PMS_PUBLIC_URL=PMS, CASDOOR_ENDPOINT=IAM)
    setup.write(setup.HERE / ".env", "".join(f"{k}={v}\n" for k,v in env.items()))
    conf = (setup.HERE / "app.conf").read_text().splitlines()
    setup.write(setup.HERE / "app.conf", "\n".join(
        f'origin = "{IAM}"' if line.startswith("origin =") else line for line in conf)+"\n")
    print("Configured pm.openlims.ai and iam.openlims.ai; previous settings saved on server.")


if __name__ == "__main__":
    main()
