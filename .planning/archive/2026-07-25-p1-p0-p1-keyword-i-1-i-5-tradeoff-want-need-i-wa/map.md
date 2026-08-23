# Wayfinder map: 2026-07-25-p1-p0-p1-keyword-i-1-i-5-tradeoff-want-need-i-wa

> **Status: EXECUTED DIRECTLY — no tickets.** Wayfinder step-3 fog assessment
> concluded this batch was small and sharp (every decision precisely statable,
> not foggy) → the escape hatch fired → we skipped the ticketed map and went
> grill-and-execute. All work is DONE (7 commits). **Authoritative traceability
> lives in the audit resolution log**, not here:
> [`../../2026-07-25-tool-gate-audit/report.md`](../../2026-07-25-tool-gate-audit/report.md) → "Resolution log".

## Destination (pinned)

**全做 P1,保守窄化** — apply every audit Important finding; for the items with
recall↔precision tradeoffs use conservative narrowing (not blanket-drop); pure
gains directly; verified by an updated probe suite locking both new precision and
protected recall.

| P1 item | tradeoff |
|---|---|
| drop flux2/ltx `want`/`need` verbs (I-1) | +precision / −recall (colloquial requests no longer auto-fire) |
| CJK `圖`→`圖片`/`圖像` (I-2) | +precision / −minor recall |
| add CJK `照片` to flux2 (I-3) | +recall (pure gain) |
| narrow ltx `relay` (I-4) | +precision / −minimal recall |
| drop pi_deploy `test` verb (I-5) | +precision (fired on every test turn) / −minimal recall |
| close captured≠loaded seam (I-7/I-8) | pure gain (honest phantom detection) |
| net self-promotion accounting (I-6) | pure gain (make enable_tool overhead visible/drift-detectable) |

## Resolution (executed, not ticketed)

Each finding → fix commit (full detail + verification evidence in the audit
resolution log):

| finding | commit | one-line |
|---|---|---|
| C-1 cost phantom | `d07059fc` | deleted phantom `cost` gate + 5 probe arrays + EXTRA_ENTRIES |
| C-2/C-3/C-4 miss-rate | `000d0112` | demoted to diagnostic; removed false "verdict driver" claims |
| I-1 want/need | `003dfb38` | dropped from flux2+ltx verbs |
| I-2 CJK 圖 | `003dfb38` | → 圖片/圖像 in nouns |
| I-3 照片 | `003dfb38` | added 照片/相片 nouns |
| I-4 pi_deploy test | `003dfb38` | dropped `test` verb |
| I-5 relay | `003dfb38` | narrowed to video relay/vbvr relay |
| I-7 malformed manifest | `8e7b02ce` | ENOENT swallows, parse-error throws |
| I-8 gateMissing | `8e7b02ce` | documented one-directional; closed at source |
| I-6 net accounting | `954df0e3` | enableToolOverhead + netSavedTok; computeNet() |

**Deferred (with rationale):** I-9 calibration (needs traffic data), miss-rate
full redesign (needs L2 live-A/B), inspect_hooks phase-2 (riskier), Minors (P3).

**Verification:** tool-gate 222 pass / 0 fail; pi-agent-cli schema-cost 17 pass;
qa default + --strict ✅ PASS; savings 8,054 gross / **7,811 net** (47%);
coverage 0 ungated / 21 gated; benign false-fires 12→8.

## Decisions / Not yet specified / Out of scope

_(captured in the audit resolution log; this map intentionally carries no
separate ticket artifacts — they would duplicate the audit report.)_
