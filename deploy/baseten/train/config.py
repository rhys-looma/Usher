# One LoRA training job on a Baseten H100, run by hand (scripts/baseten-train.sh). The script
# copies train.py, its requirements and the data beside this file, and sets the environment below.
# USHER_JOB_MINUTES is a hard stop, inside the job, so a hung run can't outspend its budget.

import os

from truss.base import truss_config
from truss_train import CheckpointingConfig, Compute, Image, Runtime, TrainingJob, TrainingProject

minutes = int(os.environ["USHER_JOB_MINUTES"])
ENV = {name: os.environ[name] for name in ("USHER_MAX_STEPS", "USHER_LIMIT", "USHER_BATCH_SIZE") if os.environ.get(name)}

project = TrainingProject(
    name="usher-student",
    job=TrainingJob(
        image=Image(base_image="python:3.11"),
        compute=Compute(accelerator=truss_config.AcceleratorSpec(accelerator="H100", count=1)),
        runtime=Runtime(
            start_commands=[f"""timeout {minutes}m /bin/sh -c 'pip install -q -r requirements.txt && python3 train.py --baseten'"""],
            environment_variables={**ENV, "USHER_BASE_DIR": "/app/models/base"},
            checkpointing_config=CheckpointingConfig(enabled=True),
        ),
        weights=[truss_config.WeightsSource(source="hf://meta-models/Muse-Glimmer-30B@main", mount_location="/app/models/base")],
    ),
)
