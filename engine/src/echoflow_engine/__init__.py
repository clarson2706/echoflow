import os

# The desktop shell passes its own version, so package.json stays the single source of truth.
__version__ = os.environ.get("ECHOFLOW_VERSION", "0.1.0")
