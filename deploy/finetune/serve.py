"""Serves the tuned labeller: vLLM on Modal, the base weights plus the latest LoRA adapter, behind an
OpenAI-compatible endpoint (/v1/chat/completions) that model.ts calls as the "student" provider.

    npm run finetune:serve        # modal deploy; prints the URL to set as USHER_STUDENT_URL
    npm run finetune:stop         # modal app stop: no GPU left running

The endpoint needs a bearer key (USHER_STUDENT_KEY, a Modal secret named usher-student). It scales
to zero when idle, so an idle deployment costs nothing but the volume.
"""

import subprocess
from pathlib import Path

import modal

VOLUME = "usher-finetune"
VOLUME_DIR = "/vol"
MODEL_NAME = "usher-labeller"
PORT = 8000

image = modal.Image.debian_slim(python_version="3.11").pip_install("vllm==0.11.0")
app = modal.App("usher-labeller", image=image)
volume = modal.Volume.from_name(VOLUME, create_if_missing=False)


@app.function(gpu="H100", volumes={VOLUME_DIR: volume}, secrets=[modal.Secret.from_name("usher-student")], scaledown_window=300, timeout=3600)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=PORT, startup_timeout=900)
def serve() -> None:
    import os

    run = (Path(VOLUME_DIR) / "runs" / "latest").read_text().strip()
    adapter = Path(VOLUME_DIR) / "runs" / run / "adapter"
    subprocess.Popen(
        [
            "vllm", "serve", str(Path(VOLUME_DIR) / "base"),
            "--host", "0.0.0.0", "--port", str(PORT),
            "--enable-lora", "--max-lora-rank", "16",
            "--lora-modules", f"{MODEL_NAME}={adapter}",
            "--max-model-len", "4096",
            "--api-key", os.environ["USHER_STUDENT_KEY"],
        ]
    )
