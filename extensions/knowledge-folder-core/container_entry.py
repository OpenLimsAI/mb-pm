"""Use the reviewed Core extension for the existing container serve command."""

import os
from pathlib import Path
import runpy
import sys

if len(sys.argv) > 1 and sys.argv[1] == "serve":
    script = Path(__file__).with_name("run.py")
    sys.argv = [str(script), *sys.argv[2:]]
    runpy.run_path(str(script), run_name="__main__")
else:
    os.execvp("dikw", ["dikw", *sys.argv[1:]])
