"""Allow only the dedicated notes document to be embedded by its configured KB."""

import re
from urllib.parse import urlsplit

BASE_ANCESTORS = "'self' https://www.openlims.ai https://pm.openlims.ai"


def notes_frame_ancestors(request, response, knowledge_origin: str) -> str:
    if (
        request.method not in {"GET", "HEAD"}
        or request.url.path != "/notes"
        or request.query_params.getlist("embed") != ["knowledge"]
        or not response.headers.get("content-type", "").lower().startswith("text/html")
    ):
        return BASE_ANCESTORS
    # Configuration must be one complete origin, never a wildcard, directive,
    # credential-bearing URL or arbitrary page path. Invalid values fail closed.
    try:
        origin = urlsplit(knowledge_origin)
        valid = (
            origin.scheme in {"http", "https"}
            and origin.hostname
            and re.fullmatch(r"[a-zA-Z0-9.:-]+", origin.hostname)
            and origin.username is None
            and origin.password is None
            and origin.port != 0
            and knowledge_origin == f"{origin.scheme}://{origin.netloc}"
            and not any(char.isspace() for char in knowledge_origin)
        )
    except ValueError:
        valid = False
    return f"{BASE_ANCESTORS} {knowledge_origin}" if valid else BASE_ANCESTORS
