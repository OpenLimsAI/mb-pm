"""前端托管的缓存策略：页面与非哈希文件每次确认新版本，带哈希的 /assets 长期缓存；路径穿越仍被拦截。"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.main import mount_spa


def test_spa_cache_headers(tmp_path):
    (tmp_path / "index.html").write_text("<html>app</html>")
    (tmp_path / "release-notes.html").write_text("<html>notes</html>")
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1)")
    app = FastAPI()
    mount_spa(app, tmp_path.resolve())
    client = TestClient(app)

    # 发版后浏览器必须重新确认：页面、前端路由回退、独立版本说明（含带版本参数的嵌入地址）
    for path in ("/release-notes.html", "/release-notes.html?v=20261014", "/projects/p1"):
        res = client.get(path)
        assert res.status_code == 200 and res.headers["cache-control"] == "no-cache", path
    assert "notes" in client.get("/release-notes.html?v=1").text
    assert "app" in client.get("/projects/p1").text

    res = client.get("/assets/index-abc123.js")
    assert res.status_code == 200 and "immutable" in res.headers["cache-control"]
    missing = client.get("/assets/missing.js")
    assert missing.status_code == 404 and "immutable" not in missing.headers.get(
        "cache-control", ""
    )

    assert "app" in client.get("/..%2F..%2Fetc%2Fpasswd").text  # 不会读到静态目录之外
    assert client.get("/api/unknown").status_code == 404
