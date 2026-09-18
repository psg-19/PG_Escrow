# Vision eval fixtures

This directory is intentionally empty.

The text-pathway suite in `../cases.ts` measures rubric reasoning, burden of
proof, injection resistance and bias. It does **not** measure vision quality,
and the scorecard should never be quoted as if it did.

Generating synthetic before/after images to fill that gap would be worse than
leaving it open: spotting a black rectangle drawn onto a grey one is not the
task, and a score from it would be flattering and meaningless. Real photographs
are the only thing that measures real photograph adjudication.

## To add the vision suite

1. Drop matched pairs in here as `<case-id>/movein-<slot>.jpg` and
   `<case-id>/moveout-<slot>.jpg`.
2. Add a `<case-id>/truth.json` recording the settlement a careful human
   adjudicator reaches on those photos, and why.
3. Photograph both the damaged and the undamaged cases. A set that is all
   damage teaches the scorecard nothing about false positives, which are the
   expensive failure here.

Useful sources: your own rooms, a cooperating PG owner, or move-out inspection
photos a property manager is willing to share with identifying detail removed.
