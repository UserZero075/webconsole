"""Keep session bearer credentials out of application and access logs.

Session URLs are bearer credentials: anyone holding ``/c/<token>`` owns the
terminal view. Werkzeug's development access log prints the request target
verbatim, so a plain deployment writes those tokens into journald. The filter
below rewrites log records *before* any handler formats them, which keeps the
change local to WebConsole instead of depending on a particular WSGI server.
"""

import logging
import re

# /c/<token> and /ws/<id>?token=<token> both carry the same credential.
# token_urlsafe(32) yields 43 characters of [A-Za-z0-9_-]; the bound keeps the
# pattern tight enough to avoid rewriting ordinary path segments.
REDACTION_PATTERNS = (
    (re.compile(r'(?P<prefix>/c/)[A-Za-z0-9_-]{32,}'), r'\g<prefix>[redacted]'),
    (re.compile(r'(?P<prefix>[?&]token=)[^&\s"\'<>]+'), r'\g<prefix>[redacted]'),
)

# Werkzeug only redacts nothing today; this marker makes the filter idempotent.
_FILTER_MARKER = '_webconsole_redacting'


def redact_secrets(text):
    """Return ``text`` with session credentials replaced by a fixed marker."""
    if not text or not isinstance(text, str):
        return text
    for pattern, replacement in REDACTION_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


class RedactingLogFilter(logging.Filter):
    """Rewrite record arguments so credentials never reach a log handler."""

    def filter(self, record):
        if isinstance(record.msg, str):
            record.msg = redact_secrets(record.msg)
        args = record.args
        if isinstance(args, tuple):
            record.args = tuple(redact_secrets(arg) if isinstance(arg, str) else arg
                                for arg in args)
        elif isinstance(args, dict):
            record.args = {key: redact_secrets(value) if isinstance(value, str) else value
                           for key, value in args.items()}
        elif isinstance(args, str):
            record.args = redact_secrets(args)
        return True


def install_access_log_redaction(logger_name='werkzeug'):
    """Attach the redaction filter once and return the logger it protects."""
    logger = logging.getLogger(logger_name)
    if not any(getattr(existing, _FILTER_MARKER, False) for existing in logger.filters):
        redacting = RedactingLogFilter()
        setattr(redacting, _FILTER_MARKER, True)
        logger.addFilter(redacting)
    return logger
