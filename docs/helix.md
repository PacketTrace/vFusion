# Helix

*Event types, a way to test them, what is really on Verkada, and demo data for something not built yet.*

**Where:** the **Helix** item in the nav. Three views: Event types, Published events, Demo data.

Helix connects third-party data to camera footage so video can be found by what happened rather than scrubbed for. An event type is the shape of one kind of record; every flow in vFusion that "posts to Helix" writes into one.

## Event types

- **Synced from Verkada** and shown as a card grid, one line each.
- **Draft one from a sentence.** The manual path asks for a name and an unbounded list of attribute-name/type pairs against an empty box. Describe the integration instead and a name, sensible attributes and their types are proposed.
- **Send a test event by hand** to any type. Type errors come back per attribute: which one, what Helix wanted, what it got.
- **Delete** a type from Verkada.

Helix attribute values are capped at 200 characters and every attribute lands as a string.

## Published events

What is actually on Verkada right now, read back from Verkada rather than from vFusion's own records. This is the difference between "the run said HTTP 200" and "the event is there", and those come apart more often than you would like: a flow posting to a deleted type, a timestamp in the wrong unit, an attribute Helix truncated.

## Demo data

Helix is easier to want once you have seen it working on your own cameras, and seeing it working requires an integration nobody has built at the point of asking. This closes that gap.

- **Describe the system** — a clothing-store POS, a pharmacy drug-tracking system, a truck scale — and the composer designs the event type and a *specification* of the data: what an item costs, how often a discount appears, which products exist.
- **Ready-made scenarios** load instantly with no model call: Point of sale (clothing store), Pharmacy drug tracking, Time clock shift punches, Vehicle scale weigh-ins. Adjust one in a sentence to make its products yours.
- **Review, then seed.** Composing is cheap and reversible; seeding writes to a live org, so they are separate buttons. Seeding expands the spec into as many coherent rows as you ask for (totals scale with counts, codes appear at the rate the model said) across a week of history, on cameras that are online.
- **Past runs** keep the design and the parameters so a demo can be re-run with fresh data, or the same seed.
- **Live demo.** Pair it with the [virtual camera](virtual-camera.md) and the video library: an ambient clip holds the stream, event clips jump the queue on a schedule, and each Helix event is stamped inside its clip's window so the footage in Command matches the event.

This is a demo tool. vFusion cannot delete what it posted, and it is aimed at trial orgs where a timeline is meant to be re-run rather than tidied away.
