import os
from pathlib import Path

import requests

skill_root = Path("skill-deploy/magnetic-script-healthcare")
skill_id = os.environ["ANTHROPIC_SKILL_ID"]
api_key = os.environ["ANTHROPIC_API_KEY"]

uploads = []
opened_files = []

try:
    for path in sorted(skill_root.rglob("*")):
        if not path.is_file():
            continue

        handle = path.open("rb")
        opened_files.append(handle)

        relative_path = path.relative_to(skill_root).as_posix()

        uploads.append(
            (
                "files[]",
                (relative_path, handle, "application/octet-stream"),
            )
        )

    response = requests.post(
        f"https://api.anthropic.com/v1/skills/{skill_id}/versions",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        files=uploads,
        timeout=120,
    )

   if not response.ok:
    print("Anthropic API status:", response.status_code)
    print("Anthropic API response:", response.text)
    response.raise_for_status()

    result = response.json()

    print("Published skill version:", result["id"])

finally:
    for handle in opened_files:
        handle.close()
