# Platform, format, and duration

## Platforms the tool supports

| Platform | Shape | Typical viewer state |
|---|---|---|
| YouTube (long-form, 16:9) | 1.5–8 min | Searched or was sent a link; willing to watch if it earns it |
| YouTube Shorts / Reels / TikTok (9:16) | 20–60 s | Scrolling; decides in ~2 s |
| LinkedIn feed video | 45–90 s, captions-first | At work, sound often off |
| Internal LMS / intranet | 1–5 min per module | Assigned; attention is compliance-driven |
| Waiting room / clinic screen / QR on leaflet | 1–3 min, loops, sound optional | Captive but distracted |

If the doc's audience is clear, recommend the platform that matches *where the viewer actually is when the knowledge is needed* — not where the client wishes they were.

## Recommendation rules

**Series vs one-off**
- One job, or two tightly linked → one-off.
- Three or more separable jobs, each with its own trigger/action → series. Episode 1 = the job with the highest cost of getting wrong.
- Doc is a reference manual (lookup, not learn) → series of short "moment" episodes.

**Duration**
- Start from the one job: how many beats does tension → mechanism → action need? Usually 6–12 beats.
- Short-form (≤60s): one job, one mechanism, one action. No sub-lists.
- 90s–2 min: one job with a mechanism that needs an analogy, plus a short "what else" beat.
- 2–4 min: one job with a multi-step mechanism, or two linked jobs.
- 4–8 min: publishing/education explainers where the model itself is the point.
- If the doc is long but the job is simple, go short and say why ("the doc is 1,800 words; the job is one habit").

**By ICP (defaults, override with the diagnosis)**
| ICP | Default platform | Default duration | Series? |
|---|---|---|---|
| Healthcare / patient ed | YouTube (unlisted link / QR) or clinic screen | 90s–2:30 | Often yes, per self-care job |
| Corporate L&D | LMS or YouTube unlisted | 60–120s | Yes for policies with several procedures |
| Publishing / education | YouTube long-form + Shorts cutdowns | 3–6 min | Yes, per chapter/concept |
| NGO / mission-driven | Reels/Shorts for awareness; YouTube 2–3 min for donors/partners | 45–60s or 2–3 min | Campaign series |

## Word budgets

Voiceover pace for clear explainer delivery ≈ 150 wpm (2.5 words/sec). Short-form can run 160–170 wpm. Leave ~10% of time for pauses and visual-only beats.

| Duration | Target VO words (long-form pace) | Target VO words (short-form pace) |
|---|---|---|
| 0:30 | — | 70–80 |
| 0:45 | — | 105–120 |
| 1:00 | 130–140 | 145–160 |
| 1:30 | 200–215 | — |
| 2:00 | 270–285 | — |
| 2:30 | 335–355 | — |
| 3:00 | 400–425 | — |
| 5:00 | 670–710 | — |

Per segment: 1.5–3.0 words/sec is healthy. Above ~3.0 reads rushed; below ~1.5 needs a visual-only reason (a reveal, a pause for effect) — note it in the On screen column.

Hook (0:00–0:15): 30–40 words.

Visual-led scripts can sit near 2.0 w/s overall to leave room for reveals and pauses. Keep speech within the segment pacing range above.

`scripts/check_timing.py` checks these numbers on a finished draft.
