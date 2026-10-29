"""Starts the student's server: fetch the promoted adapter from the registry, then run vLLM.

The registry answers GET /training/student with the promoted run and presigned URLs for its
adapter's files (Baseten checkpoint storage). Without a promoted run it serves the base alone, under
another name: the registry asks the student nothing until a run is promoted.
"""

import json
import os
import urllib.request
from pathlib import Path

BASE = "/app/models/base"
ADAPTER = Path("/app/adapter")
NAME = "usher-labeller"


def promoted() -> dict:
    secret = Path("/secrets/usher_training_secret").read_text().strip()
    request = urllib.request.Request(
        os.environ["USHER_REGISTRY_URL"].rstrip("/") + "/training/student",
        headers={"Authorization": "Bearer " + secret},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read())


def main() -> None:
    found = promoted()
    files = [f for f in found.get("files", []) if f["relative_file_name"].startswith("adapter/")]
    for f in files:
        target = ADAPTER / f["relative_file_name"][len("adapter/") :]
        target.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(f["url"], target)
    print(json.dumps({"event": "student_start", "run": found.get("run"), "adapter_files": len(files)}), flush=True)
    args = ["vllm", "serve", BASE, "--host", "0.0.0.0", "--port", "8000", "--max-model-len", "4096", "--gpu-memory-utilization", "0.9"]
    if files:
        args += ["--served-model-name", NAME + "-base", "--enable-lora", "--max-lora-rank", "16", "--lora-modules", f"{NAME}={ADAPTER}"]
    else:
        args += ["--served-model-name", NAME + "-base"]
    os.execvp(args[0], args)


if __name__ == "__main__":
    main()
