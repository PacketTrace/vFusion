"""Shared grounding for anything that reasons about flows.

The builder generates them and the assistant explains them, and both are
only as good as what they know about this install. Keeping that in one
place means the two can never disagree -- and, more importantly, that
neither goes stale when an action is added, because the catalog is read
from the live registry rather than written down somewhere.
"""
