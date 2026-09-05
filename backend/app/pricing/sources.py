"""Every way vFusion spends money, declared in one place.

Sources used to be string literals at call sites, which meant the only
way to know whether something was instrumented was to remember writing
it — and video generation, the most expensive thing in the product, was
not, for as long as nobody happened to check.

Declaring them here fixes that in both directions. The cost page can
list every source it knows about *including the ones at zero*, so a
feature you have used that still reads $0.00 is visibly missing its
ledger call. And an entry arriving under a name that is not here is
flagged as unregistered, which catches the opposite mistake.

Adding a spending feature means adding a line here. That is the point:
it is one line, and forgetting it is loud instead of silent.
"""

from __future__ import annotations

from typing import NamedTuple


class Source(NamedTuple):
    name: str
    what: str
    #: False when it is billed per unit rather than per token, which
    #: changes how the cost is derived and is worth showing.
    token_priced: bool = True


FLOW_RUN = "Flow runs"

SOURCES: list[Source] = [
    Source(
        FLOW_RUN,
        "Gemini steps inside a flow — the analysis a flow does when it fires.",
    ),
    Source(
        "Analytic composer",
        "Writing an analytic from a description on the Workbench.",
    ),
    Source(
        "Flow builder",
        "Drafting a flow from a sentence, including the validation retry.",
    ),
    Source(
        "Flow assistant",
        "The chat beside the flow editor.",
    ),
    Source(
        "Helix demo composer",
        "Designing a Helix event type and its data generator.",
    ),
    Source(
        "Help",
        "The help chat. Each question re-sends the whole corpus, so it is "
        "the same price whether you ask one thing or ten.",
    ),
    Source(
        "Video generation",
        "Veo clips for the video library. Billed per second of output, not "
        "per token — by far the most expensive thing here.",
        token_priced=False,
    ),
]

BY_NAME = {s.name: s for s in SOURCES}
