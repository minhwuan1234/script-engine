# Machine-readable output (only when asked)

Use when the user wants engine output to feed the Magnetic Script Studio UI. Same content as the markdown output. Return valid JSON only.

```json
{
  "crazy_level": "low | medium | high",
  "icp": "healthcare | ld | publishing | ngo",
  "diagnosis": {
    "viewer_moment": "",
    "one_job": "",
    "buried_gold": [""],
    "understanding_break": {"plain": "", "failure_type": "false_certainty | cognitive_overload | concept_fragmentation | transfer_failure"},
    "mechanism": "",
    "locked_facts": [""]
  },
  "recommendation": {
    "platform": {"value": "", "why": ""},
    "duration_seconds": {"value": 90, "why": ""},
    "format": {"value": "one_off | series", "why": "", "episodes": [{"n": 1, "job": "", "title": ""}]}
  },
  "differences": [{"dimension": "", "a": "", "b": ""}],
  "versions": [
    {
      "id": "A",
      "style": "",
      "title": "",
      "hook": [{"start": "0:00", "end": "0:05", "vo": "", "on_screen": ""}],
      "script": [{"start": "0:15", "end": "0:22", "vo": "", "on_screen": ""}],
      "reason": "",
      "best_when": ""
    }
  ],
  "engine_notes": {"assumptions": [""], "flags": [""]}
}
```

UI mapping: `hook` is the free 15s preview; everything else in `versions` sits behind the email gate.
