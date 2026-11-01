# Phase 13 — optimisation & release hardening

Delivered on the integrated Phases 1–12 line. Everything here is measurable,
bounded and tested; no visual quality is lowered silently and no subsystem was
rewritten.

## Performance profiling (`src/core/profiler.ts`)

`FrameProfiler` keeps fixed-size ring buffers (240 samples ≈ 4 s at 60 fps) of
wall-clock frame time, accumulated fixed-step time and render-callback time,
measured directly around `FixedLoop.tick` in `Game.frame`. Queries (avg, p95,
max) copy at most one window; the steady-state path allocates nothing. The F3
performance overlay gained two lines:

```
Frame p95   16.7 ms · avg 15.9 ms
Adaptive    high ≤ ultra   (or: off)
```

## Adaptive quality (`src/core/adaptive-quality.ts`)

`AdaptiveQualityController` is pure decision logic over the profiler's p95:

- steps **down** one preset after 10 s sustained p95 above 33 ms (~30 fps);
- steps **up** only after 45 s sustained p95 below 15 ms, and **never above the
  player's chosen preset** (the ceiling, updated by every manual change);
- 60 s minimum cooldown between changes; a single stall is clamped to 2 s of
  credit so one hitch cannot cascade the preset;
- disabled while a menu/overlay is open or the world is still loading.

Changes go through the existing `setQuality` path (a real re-stream) and are
**always announced with a toast** — adaptive quality is a visible aid, not a
silent downgrade. A settings switch (“Adaptive quality”, Phase 13 section)
turns it off; the overlay shows the current preset and ceiling.

## Long-run streaming (`tests/long-run.test.ts`)

A headless 30-minute soak: 108 k fixed steps, a ~29 km traverse, ~14
floating-origin rebases, discovery-cell growth, event emission, objective
progress and six save roundtrips through the autosave slot. Asserts:

- player coordinates never go NaN; local coordinates stay ≤ 2048 m from the
  canonical origin; the origin sits exactly on the 2048 m grid;
- discovery grows linearly (~113 cells for 29 km), capped ≤ 8192;
- profiler window ≤ 240 samples; every save < 4 MB and re-validates;
- mission progress restores bounded after hostile input.

## Save/load validation fuzz (`tests/save-fuzz.test.ts`)

500 seeded mutations (structural + numeric: NaN/±∞/oversized/missing keys/type
swaps) of a valid v2 save: the validator either throws or returns a save that
satisfies every documented invariant — never garbage. Idempotent roundtrip of
clean saves and explicit rejection of hostile formats are covered separately.
Combined with the Phase 11 v1→v2 migration tests, the save path has both a
migration and a fuzz regression net.

## Physics stability (`tests/prop-physics.test.ts`)

A 40-body mixed-material pile settles for 60 simulated seconds at the full
120 Hz rate: every body stays finite, neither falls through the world nor is
launched, and ≥ 30 bodies reach sleep (bounded residual energy).

## Memory-bound audit

Bounded-state guarantees are asserted where they live, and re-checked by the
soak: discovery ≤ 8192 cells, event history ≤ 64 entries, game saves ≤ 4 MB
with ≤ 8192 cells, objectives ≤ 64 missions × 32 objectives × 256 flags,
profiler ≤ 240 samples, water/vegetation/prop budgets per preset (existing
tests), building collider budgets (existing tests).

## Regression & production build

- `npx tsc --noEmit`: clean.
- `npx vitest run`: **525 tests across 53 files** (Phases 1–13).
- `npm run build`: TypeScript check + Vite production bundle pass (~1.9 s).
- Browser matrix / hardware WebGPU remain outside this repository's sandbox
  (software WebGL2 only) — see `INTEGRATION.md`; that limitation is unchanged
  and no hardware-WebGPU claim is made here.

## Explicitly not in scope

- No invented story, no authored mission content (infrastructure only).
- Adaptive quality never exceeds the player's preset and is never silent.
- NPC interior navigation and Rapier rigid-body building colliders for
  vehicles/props remain documented boundaries (`INTEGRATION.md`).
