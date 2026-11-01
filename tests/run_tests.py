import inspect
import sys
import tempfile
import traceback
from pathlib import Path

sys.path.insert(0, ".")
import tests.test_seen
import tests.test_new_features

failed = 0
passed = 0
for module in (tests.test_seen, tests.test_new_features):
    for name, func in inspect.getmembers(module, inspect.isfunction):
        if not name.startswith("test_") or func.__module__ != module.__name__:
            continue
        kwargs = {}
        if "tmp_path" in inspect.signature(func).parameters:
            kwargs["tmp_path"] = Path(tempfile.mkdtemp())
        try:
            func(**kwargs)
            passed += 1
            print("PASS", name)
        except Exception:
            failed += 1
            print("FAIL", name)
            traceback.print_exc()
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
