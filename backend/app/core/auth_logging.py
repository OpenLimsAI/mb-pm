"""Do not record one-time OAuth codes or state in web access logs."""

import logging


class CallbackQueryFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple) and len(args) >= 3 and isinstance(args[2], str):
            path = args[2].split("?", 1)[0]
            if path in {"/api/v1/auth/callback", "/api/v1/portal/callback"}:
                values = list(args)
                values[2] = path
                record.args = tuple(values)
        return True
