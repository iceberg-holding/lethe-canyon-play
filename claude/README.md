# LETHE / ЛЕТА — "Delivery" (prototype, variant `claude`, round 11)

Cinematic canyon run on Mars. Fly the amphibious **Cormorant** (БАКЛАН) from settlement **A** to settlement **B**
(7.99 km of canyon, ≈ 2:36 at cruise speed) with a tank of fresh water. Plain static three.js site (r170, vendored), no build step, no CDN.

Open `index.html` over HTTP (e.g. `python3 -m http.server`).
URL params: `?autostart=1` skip the start screen · `?autopilot=1` crude self-flying smoke test ·
`?q=low|med|high` force a quality tier (disables auto-adaptation) · `?noboost=1` autopilot at cruise speed (timing).
`?tips=0` / `?tips=1` turn the round-11 boat tutorial off / on (and re-arm it) for this page load only, without touching the saved setting.

## Controls
| | Desktop (keys **or** the clickable buttons, bottom-right) | Touch (landscape) |
|---|---|---|
| Steer (lateral / altitude) | `WASD` or arrows (W = climb) | left-thumb floating stick, or **TILT** (gyro; asks permission on iOS) |
| Fire twin nose cannons (also underwater, short range) | `Space` or left mouse (hold) · **FIRE [Space]** | **FIRE** (hold) |
| Rocket (heavy, 6 per run) | `R` or right mouse · **ROCKET [R]** | **ROCKET** (tap) |
| Boost | `Shift` · **BOOST [Shift]** (hold) | **BOOST** (hold) |
| Dive / surface (toggle) | `E`, `C`, `Q` or `Ctrl` · **DIVE [E]** | **DIVE** (tap) |
| Sound mute / unmute | `M` or the speaker icon (HUD, top) | speaker icon |
| Engine sound preset | `V` (cycle) or the gear icon next to the speaker | gear icon |
| Tips / Подсказки (boat tutorial) | start screen, **TIPS** ON / OFF next to the engine selector | same |
| Key legend on / off | `H` (shown automatically for the first ~20 s of flight) | — |

Multi-touch works (steer + fire + boost at once). Flight is auto-forward; you control lateral offset, altitude and boost.
Flight handling, speeds, rocket recoil and the LETHE lock sequence are unchanged since round 2.

## Round 9 — maximum detail polish

Visual-only work over `fa74941`. The entire world layout and flight, collision, camera, aiming, rocket/recoil and burn
functions remain byte-identical; `_test/r9_invariants.py` verifies this against that checkpoint.

Waterfalls now combine three scrolling value-noise layers, broken vertical filaments, feathered opacity, thin translucent
patches, warm foamy lips and subtle geometric width wobble. Each has a narrow animated teal impact pool with foam rings and
churn; spray rises through the existing mist pool. The pool footprint is sampled against the outer wall and aligned with the
path, so the new surfaces stay behind the collision envelope. These remain inexpensive animated sheets, not fluid simulation.

The colonial dam has a shared 512² procedural concrete albedo/normal atlas: aggregate, cracks, downward rust stains and faded
`MH / 04` stencils. Broken cap sections, spalled chunks and exposed rebar interrupt its edges. Greenhouses have tall translucent
Fresnel glass, dirt, merged metal ribs and horizontal rails, low base collars, planted silhouettes, warm interior lamps and
connecting terrace walks. Pipeline supports/flanges are retained and the pipe surface now has rust patches. Frames, plants,
rebar, walks and lights join the existing chunk batches; concrete and glass each use one additional shared batch where present.
The two canvas maps are generated once at load; no downloaded texture assets or per-frame canvas work.

High-tier sun-aligned shafts now reach into the lower canyon with softly feathered filaments; medium keeps shorter, fainter
sheets. Existing single-draw dust motes drift and sparkle more selectively. Bank and rock foam is more broken, and the ship
leaves a longer, rippled V-wake with wider boost spray and stronger entry/exit splash spread. Water colour/reflection stays
as before. Turrets use a cool cyan-white Fresnel rim and brighter pulsing red sensor sprites; the depth-tested eye and target
bracket are visible in the cinematic view from at least 255 m (`r9_turret_far.png`). No gameplay object moved.

| Tier | Round 9 budget |
|---|---|
| low | Original direct render; no waterfalls, pools, glass/concrete detail, dust or shafts. Turret rim/eye and existing water/wake remain. |
| med | First waterfall + pool and cheap mist, merged greenhouse/dam detail, shared texture maps, short faint shafts, dust. Half-resolution bloom unchanged. |
| high | Both waterfalls/pools with denser spray; longer/brighter shafts and fuller boost spray. Existing shadows/full-resolution bloom retained. |

Quality overrides, low/med/high and the auto-adaptation governor are unchanged.

**Performance:** `_test/r8_perf.mjs`, locked medium, 915×412 touch, DPR 1, GLB ship; 3 s warmup and ~20 s autopilot sample.
The baseline and all three after samples ran alone on the same headless Chromium/SwiftShader host. These are relative software-renderer costs,
not device FPS. The table compares one baseline with the mean of three after samples. Raw `r9_before` / `r9_after` / `r9_final` / `r9_pool_final` records are in `_test/r8_perf.log`.

| Metric | Before `fa74941` | Round 9 (mean of 3) | Change |
|---|---:|---:|---:|
| Average frame time | 104.77 ms | 111.18 ms | +6.1% |
| p95 frame time | 216.7 ms | 205.5 ms | −5.2% |
| FPS | 9.5 | 9.0 | −5.8% |
| Draw calls | 102 | 103.7 | +1.6% |
| Triangles | 304,300 | 309,030 | +1.6% |

After samples: **109.01 / 112.33 / 112.19 ms** average; **216.6 / 200.0 / 200.0 ms** p95. All are within the +15% frame-time budget.

**Visual review:** four passes compared the waterfall, dam and greenhouse views with `shots/r8_*`. Pass one exposed regular
curtain stripes and opaque hut walls. Pass two opened the planted glass volumes and broke the flow into noisy filaments.
Pass three added horizontal greenhouse rails, compact spray, longer high shafts, damaged dam caps and a tighter pool footprint.
The final close-up review replaced a regular pool grid with broken noise rings and softly fading opacity.
Review images are `shots/r9wip/pass1_*` / `pass2_*` / `pass3_*`; final images are `shots/r9_*`. The close waterfall framing focuses on the lower
cascade and impact, and the normal desktop/touch views retain the gameplay HUD.

Best views: [greenhouses](../../shots/r9_domes.png), [glass detail](../../shots/r9_domes_close.png),
[dam](../../shots/r9_dam.png), [skimming wake](../../shots/r9_wake.png).

Feature checkpoints: `89f22e0` waterfalls, `fd65737` textured props, `c0744df` shafts/dust,
`2625142` foam/wake, `40deabc` turret readability. Subsequent `Round 9:` commits contain the visual review fixes and probes.

**Validation:** `_test/r9.mjs` passed its complete desktop/touch/tier/mast/255 m turret run and uninterrupted delivery
(**15/15**, 117.63 s simulation, cargo 90.2%, no console errors). A final device-only rerun adds vertex checks for both
waterfall/pool meshes against the collision corridor: **15/15**, 108 vertices checked, minimum gap **1.10 m**, zero errors
(`_test/r9_final.log`). `_test/r8.mjs` passed **8/8** (delivery
117.54 s, cargo 90.2%); `_test/r7.mjs` passed **20/20** (117.98 s, 90.3%); `_test/r6.mjs` passed **13/13** (117.79 s,
90.3%). All runs use the original autopilot without simulation acceleration. Logs: `_test/r9.log`, `_test/r8_after_r9.log`,
`_test/r7_after_r9.log`, `_test/r6_after_r9.log`. The model fallback test deliberately injects GLB 404s; unexpected console
errors were zero. The final pool-fragment refinement was rechecked by both cinematic captures and the final medium perf run,
with zero errors; geometry and gameplay code did not change. Historical Round 6/7/8 screenshot references are preserved after the unchanged suites regenerate them.

Limits: plants and spray use simple mobile-budget silhouettes/particles. Glass has no refraction and shafts do not ray-march
or dynamically shadow canyon geometry. No physical phone test was available. The optional rainbow sheen is omitted.

## Round 8 — detailed final canyons

Visual changes only: flight, speed, camera tracking, aiming, recoil, `world.js` and the entire gameplay layout are unchanged.
The canyon mesh is recessed away from the analytic collision wall, with irregular erosion shelves, mineral seams in world
space, softer normal detail, dusty caprock and a broken rim profile. Merged six-sided mesas beyond the rim add actual skyline
parallax without extra draw calls. Cooler ground bounce and chalkier sandstone separate warm sunlight from the canyon shade.

The route now has a sheltered two-level colonial garden at 2.05–2.23 km, with planted terraces, greenhouse roofs, structural
supports and amber windows. At 4.42–4.55 km the surviving side abutment of a breached dam has broken heights, oxidised pipework
and weathered concrete. Both occupy recessed alcoves beyond the collision wall; the river channel remains open. Two tributary
waterfalls at 1.85 / 7.08 km flow down the outer wall, with pooled spray from the existing mist system. Existing bank/rock foam,
ship wakes, scree, lichen, pipes, dust, haze and light shafts are retained.

Field vaults now show fine animated hex seams instead of the old triangular Fresnel artefact (normalise the interpolated view
vector per fragment). Grazing highlights reveal the curved canopy, with a softer mirror halo above. The existing live-mast
collapse still flickers and extinguishes the actual sector mesh. An unshielded sector gets a desaturated ash haze and a darker
neutral grade; underwater keeps its original treatment. Phobos and Deimos are small procedural sky details. The start screen
now says **6 000 L FRESH WATER** (checkpoint `5b9ca8d`); the tank capacity is consistently 6 000 litres.

| Tier | Round 8 cost / behaviour |
|---|---|
| low | Recessed walls, world-space seams, rims, merged distant mesas and moons; no new terrace/dam detail meshes or waterfall draws. Existing direct-render path retained. |
| med | Colonial detail merged into the existing prop/emissive batches; one 48-triangle waterfall; existing half-resolution bloom, motes, shafts and foam. |
| high | Both 48-triangle waterfalls, plus existing shadows, grain and full-resolution bloom. |

Auto-adaptation and the locked `?q=` overrides remain intact. New rock detail uses arithmetic in the existing Lambert program,
without additional rock texture fetches or materials. The terrace and dam positions use a sampled outer-wall envelope so the
new props remain outside the flyable corridor. Rims and mesas stand above the flight ceiling.

**Visual review:** three iterations (`shots/r8wip/pass1_*`, `pass2_*`, then `shots/r8_*`) corrected harsh normals, the triangular
field pattern, excessive mirror/canopy brightness, hidden waterfall strips, repetitive dam heights, clean concrete and camera
framing. Final section views: `r8_slot`, `r8_basin`, `r8_domes`, `r8_dam`, `r8_thinair`, `r8_vista`, `r8_waterfall`; normal gameplay
at `r8_desktop` / `r8_mobile`, and a separate `r8_turret_check` for threat readability.

**Performance:** `_test/r8_perf.mjs`, medium locked, touch 915×412, DPR 1, GLB ship, 3 s warmup + approximately 20 s autopilot.
Headless Chromium / SwiftShader on the same host; these are relative software-renderer measurements, not phone FPS. Baseline
is the two samples captured at `5b9ca8d`. Final measurements run alone; the labelled `after` sample in the raw log was taken
while another browser was running and is excluded from comparison.

| Metric (mean of two samples) | Before `5b9ca8d` | Round 8 final | Change |
|---|---:|---:|---:|
| Frame time, average | 109.9 ms | 112.0 ms | +1.8% |
| Frame time, p95 | 183.4 ms | 191.7 ms | +4.5% |
| Draw calls | 101 | 102 | +1.0% |
| Triangles | 298,564 | 304,529 | +2.0% |

Raw final samples: 111.66 / 112.24 ms average, 200.0 / 183.3 ms p95. Logs: `_test/r8_perf.log`.

**Validation:** `_test/r8.mjs` checks desktop/touch flight, tiers, all 19 turrets, mast field collapse, thin-air state and console
errors, then runs the whole autopilot delivery. `_test/r7.mjs` and `_test/r6.mjs` are rerun unchanged, including full delivery.
The standalone device/field run passed **7/7** with no console errors (`_test/r8.log`). The separate full Round 8 autopilot
run delivered in **117.6 s**, cargo **90.2%**, no console errors (`_test/r8_first_full.log`). Its initial touch startup timeout
occurred with competing SwiftShader sessions; the sequential rerun passed. Round 7 passed **20/20**, including full delivery
in **119.14 s** with **90.5%** cargo (`_test/r7_after_r8.log`). Round 6 passed **13/13**, including delivery in **117.85 s** with **90.3%** cargo and no console errors (`_test/r6_after_r8.log`).

`_test/r8_invariants.log` records byte-identical `world.js`, flight/autopilot functions and camera movement/FOV code versus
`5b9ca8d`. Best views: [basin](../../shots/r8_basin.png), [terraces](../../shots/r8_domes.png),
[vista](../../shots/r8_vista.png), [turret readability](../../shots/r8_turret_check.png).

**Limits:** still a mobile-budget procedural environment. The dam is a surviving wall abutment, not a new cross-channel
obstacle. Waterfalls use translucent ribbons rather than fluid simulation. Moons are deliberately tiny. No physical phone
or human flight/play balance test was available. Existing collision/layout and audio limitations below still apply.

## Round 7 — the Blender «БАКЛАН / CORMORANT» replaces the procedural ship
The approved model (`/workspace/universe/ship/3d/baklan_game*.glb`: metres, +Y up, nose −Z, origin = centre of mass) is now
the player ship. Handling, physics, hitbox, camera, aiming and recoil are unchanged. Only `src/ship.js` (the model) and a
few non-flight lines in `main.js` changed: `ship.setQuality()` in `applyQuality`, the rocket launch point, the lift-engine
glows and the test hooks.

**Files** (`assets/ship/`). The textures are repacked by `_test/tools/pack_ship.py`: same glTF, images downsized
(Lanczos). The repack takes the pair from 6.6 MB to 1.65 MB.

| file | content | size |
|---|---|---|
| `baklan_lod0.glb` | LOD0, 16 934 tris, panel textures 1024² JPEG (normal q92, rest q85), emblems 256² PNG | 1.26 MB |
| `baklan_lod1.glb` | LOD1, 3 876 tris, textures 512² | 0.39 MB |
| `baklan_stats.json` | the modeller's stats (node triangle counts, bounds) | 1 KB |

I kept no 2K version. At chase distance the ship covers ≤ ~450 px, so 1K is enough.

**Loading.** The `Ship` constructor still builds the procedural ship immediately, so the start screen never waits.
- `setQuality(tier)` starts loading: LOD1 always (small), LOD0 for any tier above `low`. If the tier is raised to
  `med`/`high` later, LOD0 is fetched then.
- When the first GLB arrives the procedural meshes are disposed and the model is swapped in under `ship.body`
  (about 3–6 s in headless SwiftShader, mostly JPEG decoding).
- If loading fails (404, parse error) the procedural ship stays. The failure is logged with `console.warn` and
  `state().shipModel` stays `'procedural'`; once the model is in it reads `'glb'`.

**Fit.** The model is scaled ×1.05 inside `body`: 14.9 × 11.3 units, against the procedural hull's 15.2 (16.3 with gun
barrels) × 11.4. `SHIP_SCALE 0.85` still applies on top. Measured on-screen size (wingtip spread, same pose): GLB
0.157 vs procedural 0.148 of the screen width, within ±10 %.

**Merged draw calls.** Node transforms are baked and merged per material, so the ~45 glTF primitives become 12 draws
for LOD0. The wings stay separate pivots (`wings[]` = `Wing_L`/`Wing_R`, 2 draws each).

**Anchors, computed from the geometry at load:**
- `nozzles[]` / plumes sit at the `MainNozzle_L/R` exits. Plume radius is fitted to the nozzle bore.
- `lifts[]` are the `LiftEngine_L/R/C` bottoms (new small ventral glows in `main.js`).
- `muzzles[]` are the `Guns` barrel tips, at body (±2.4, −0.61, −3.2).
- `rocketPort` is under the front of the `Tank` (the rocket launch point, previously hard-coded).
- `navLights[]` are the outermost wing-tip vertices.
- The shield bubble is fitted to the model bounds.

**Wings and dive armour.** The wings stay static: a dive sweep would cut through the lift pods slung under the wing
roots. The dive armour is now a dark shell of the canopy's own shape, one size up. It rises out of the spine and closes
over the canopy in ~0.4 s.

**Materials.** The glTF PBR materials are kept, with these changes:
- Colours are made display-referred to match this project's pipeline (ColorManagement off; the grade pass decodes):
  factors go through `convertLinearToSRGB`, and base-colour maps use `NoColorSpace`.
- Every material gets the scene PMREM env map (intensity 1.0; glass 1.4) and the same highlight soft-knee as the old
  hull, so it never blooms into a white blob.
- Metalness is ×0.55. The Blender renders had a bright sky dome, while the canyon env is dim, and the fully metallic
  armour read near-black in game.
- All meshes except emissive/decal cast shadows (high tier).
- Emblem decals use `polygonOffset` (no z-fighting).
- **EmissiveOrange** (main nozzles + lift engines) becomes one shared `engineMat` per ship, driven by the existing
  `glowColor` logic: amber normally, cold cyan in dive/underwater, a steam-white blend while burning water (`G.steam`),
  brighter with boost and power.

**LOD.** A `THREE.LOD` holds LOD0 near and LOD1 beyond **70 m** of camera distance. The chase cam sits ~30 m away, so
LOD1 shows mostly on cutaways and distant views. On the **`low` tier LOD1 is pinned** (`autoUpdate` off) and LOD0 is not
even downloaded.

**Perf** (`_test/r7_perf.mjs`: medium tier, 915×412 touch, autopilot, 20 s sample after a 3 s warm-up, headless
SwiftShader, so only the relative numbers mean anything):

| | frame time | p95 | fps | draw calls | triangles |
|---|---|---|---|---|---|
| before (procedural, 2 runs) | 109.7 / 102.2 ms | 200 / 167 ms | 9.1 / 9.8 | 104 | 285 k |
| after (GLB LOD0, 2 runs) | 96.6 / 97.3 ms | 150 / 150 ms | 10.3 / 10.3 | 101 | 297 k |

There is no regression: frame time is within run-to-run noise (if anything slightly lower). The model has 3 fewer draw
calls than the procedural ship and +12 k triangles.

**Tests** (`_test/r7.mjs`): **20/20 pass**, no console errors. The run covers:
- **Loading:** the GLB loads (2–6 s headless) while the start screen stays up. If the GLB 404s, the game falls back to
  the procedural ship and keeps flying.
- **Size:** on-screen size is within ±10 % of the procedural ship.
- **LOD:** LOD0 near and LOD1 beyond 70 m. The `low` tier pins LOD1 and downloads LOD1 only. Switching from med to low
  and back works.
- **Weapons:** muzzles sit at the gun tips and the cannon flash comes from them; the rocket fires.
- **Engine colours:** boost + steam make the engine emissive brighter and whiter. In a dive the armour closes and the
  engines go cyan; on surfacing the armour retracts and they turn amber again.
- **Viewports:** desktop 1280×720 (high) and touch 915×412 (med) both run.
- **Full run:** the autopilot delivers in 118 s with 90 % cargo.

`_test/r6.mjs` re-run: **13/13 pass**. Shots: `shots/r7_start.png`, `r7_desktop.png`, `r7_mobile.png`,
`r7_boost_steam.png`, `r7_dive.png`, `r7_closeup.png`.

## Round 6 — water as reaction mass
Lore (owner-approved, BIBLE §9): a barrel-sized fission reactor feeds air-breathing plasma engines that ingest Martian CO₂
(orange plasma). Under the mast domes the air is dense. When air is not enough — **BOOST**, or a sector whose **mast was
shot (thin air)** — the engines flash **cargo water** into steam/plasma as backup reaction mass. Boosting costs the very
water you deliver. Handling, speeds, steering, aim assist, homing and rocket recoil are untouched.

| | rate (cargo-% per second) | notes |
|---|---|---|
| Boost (`BURN_BOOST`) | **0.15 × boost** (0..1) | 10 s of boost ≈ 1.5 %; 60–100 s of boost over the 2:36 route ≈ **9–15 %** |
| Thin air (`BURN_THIN`) | **+0.35** | in a zone whose mast is down, above water only |
| Boost in thin air | 0.35 + 0.15 × 1.6 = **0.59** | `BURN_THIN_BOOST = 1.6` |
| Underwater | **0** | hydrojet — no burn |
| Floor (`BURN_FLOOR`) | **5 %** | burn alone never empties the tank (damage still can breach it) |

- All rates × `SHIP_BURN_MUL` (Cormorant 1.0; planned: Tern 1.3, Pelican 0.6). Tank = **6 000 l** (`TANK_L`).
- `G.cargo` stays the single water gauge. `G.waterBurned` (engine burn) and `G.waterSpilled` (damage) are tracked apart.
- **Thin air** also gives a gentle **sink** (−2.5 m/s on the vertical-speed target) when you are not climbing
  (stick/`W` ≤ 0.1); it fades out between 7 m and 3 m above the water, so the ship settles low instead of bouncing.
  Climbing works as normal; dive physics unchanged. Radiation in that sector works as before.
- **HUD:** while burning, a pulsing steam-white tag under the cargo bar — `WATER BURN / РАСХОД ВОДЫ` or
  `THIN AIR · WATER BURN / РАЗРЕЖЕННЫЙ ВОЗДУХ · РАСХОД ВОДЫ` — a light shimmer runs along the cargo bar and the value
  shows one decimal so it visibly ticks down. Space for the tag is reserved, so the left panel never jumps
  (SHIELD DOWN flash moved down to match). One-time toasts on the first boost and the first thin-air entry.
- **Exhaust:** engine discs, plumes, glow sprites and exhaust sparks blend toward steam white `#e8f4ff` (up to 50 %), and
  soft white steam puffs trail the nozzles. Quiet procedural steam hiss on the (ducked) engine bus.
- **Result screen:** `WATER DELIVERED / ВОДА ДОСТАВЛЕНА` (e.g. `5 040 л (84%)`) and `BURNED BY ENGINES / СОЖЖЕНО
  ДВИГАТЕЛЯМИ` (litres and %). Score formula unchanged — it uses the cargo left, so burn lowers it naturally.
- Test API: `state()` adds `waterBurned`, `waterSpilled`, `burnRate` (current %/s, 0 when not burning / at the floor),
  `thinAir`, `steam` (0..1 exhaust tint), `burnTag`; `debug.setCargo(v)`, `debug.zones()` (zone spans + mast index).

**Round 6 tests:** `_test/r6.mjs` (headless Chromium + SwiftShader) — **13/13 pass, no console errors**:
no boost → no burn; 10 s boost → 1.54 % burned (cargo −1.5 %, no damage); tag + steam on while boosting, off after;
thin air → `thinAir`, 0.35 %/s, sink 21.0 → 13.4 m in 3 s hands-off, `W` still climbs (+17 m in 1 s); underwater no burn;
floor holds at 5.0 % (thin air + boost); 915×412 touch: tag visible, no overlap with buttons / stick / top icons / route;
full autopilot run **with boost the whole way**: delivered in 1:57.5, **9.8 % burned (590 l)**, 90 % / 5 410 l delivered.
Shots: `shots/r6_desktop_burn.png`, `r6_mobile_burn.png`, `r6_thinair.png`, `r6_result.png`. Portrait phones still get the rotate screen.

## Round 5 — beacons are LETHE relays
Lore (owner-approved): drones spot the smuggler and pass their **MARK** to the rim turrets **through the relays**.
The force-field masts are the first colonists' and protect everyone below — never shoot them (mast / radiation
mechanic unchanged). Flight feel, speeds, aim assist, rockets, turret lasers and the naval layer are unchanged.

- **Sections.** Each of the 13 force-field zones is a relay section. Its 1–2 relays (the old beacons; 18 total,
  2 in every third zone) link every rim turret in that zone — all 19 turrets are covered. A section stays linked until
  **all** its relays are down (killing one of two: toast `RELAY DOWN — sector still linked (1 left)`). Zones without
  relays (none in this layout) and the stretches outside zones behave as before.
- **Linked section:** drone mark → turret lock works exactly as before, but the lock only picks a *linked* turret, and
  only while the ship is inside a linked section.
  - **Data beam:** while the mark builds or a lock holds, a faint additive red-amber line with travelling dashed packets
    runs **marking drone → relay → locking turret**. The relay's top light flares while passing the mark.
  - It uses the existing pooled `Beams` quads (pool raised 256 → 384). There are 6 / 11 / 16 packets per leg on
    low / med / high, and the beam is hidden underwater.
- **Blind section** (all its relays down):
  - Its turrets **cannot lock**: no laser and no aimed volley. A lock in progress breaks when its relay dies.
  - They only fire rare, wild unaimed shots: cooldown ×2.6, spread ×2.2.
  - They sweep the canyon slowly instead of tracking the ship.
  - Their red eye becomes a small, steady, dull dark-red ember with no fog boost or pulse. The housing is tinted
    darker (instance colour), so the lit lens goes dull too.
  - In that section the MARK bar turns grey and reads **`NO RELAY / НЕТ СВЯЗИ`** (value `—`), the mark beeps stop, and
    the red lock tint is mostly suppressed.
  - Kill feedback: a big message plus the toast **`RELAY DOWN — turrets blind / РЕТРАНСЛЯТОР СБИТ — турели ослепли`**.
    The first blind section also gets the LETHE narrator in italics: *“…link lost. Sector blind.” / «…связь потеряна.
    Сектор слеп.»*
- **Relay model:** a small dark antenna mast on the ledge, with:
  - a pale dish facing the canyon and a red-banded equipment box;
  - a whip antenna with a **blinking red top light**;
  - a faint **upward data shimmer** of rising red motes (2 on low, 4 otherwise).

  It is dark and red throughout, so it can't be mistaken for the grey-and-cyan force-field masts. Hit spheres are unchanged.
- **Labels / hints:**
  - The bracket label, the score pop and the README now say `RELAY / РЕТРАНСЛЯТОР` instead of `BEACON / МАЯК`.
  - First sighting shows the hint toast *Relays pass drone marks to turrets. Shoot the relay first — the section goes
    blind. / Ретрансляторы передают метку турелям. Сбей ретранслятор — сектор ослепнет.*
  - The start screen line is now: *Amber brackets = targets. Drones mark you, relays pass it to rim turrets — down a
    relay, the sector goes blind.* It still fits 915×412 and 1280×720 without scrolling.
- **Score:**
  - A relay kill is worth +200 (was +100), plus +150 when it blinds its section.
  - The result screen adds `RELAYS / РЕТРАНСЛЯТОРЫ x / 18`.
- **Test hook:**
  - `state()` adds `relaysAlive`, `relaysDown`, `relayKills`, `noRelay`, `zone`, `sectorLinked`, `lockRelay` (relay
    available for the current lock), `lockTurret`, `dataBeam` (beam legs drawn this frame), `beamTurret` and
    `blindTurrets`.
  - It also adds `lockLog`: the last 8 lock attempts, each `{t, s, turret, zone, relay, locked}`. A full mark in a
    blind section logs `relay:false, locked:false`.
  - `aim` now reports `relay` instead of `beacon`.
  - `debug.relays()` lists `{i, s, zone, alive, side, turrets[]}`.
  - `debug.killRelay(i)` kills a relay as if shot (score, toasts) and returns whether its section is still linked.
  - `debug.turretBlind()` returns the blind flag for each turret.
- **Tests:**
  - `_test/r5.mjs desktop|touch` (1280×720 `q=high`, 915×412 touch `q=med`): **19/19 pass on both, no console errors
    or warnings**. It checks:
    - start-screen fit and wording;
    - every turret is covered;
    - the first relay sighting is labelled `RELAY / РЕТРАНСЛЯТОР` and shows the hint;
    - in a linked zone a forced mark builds a data beam (2 legs), then locks with `lockRelay=true`;
    - after `killRelay` on both of the zone's relays: +550 score, the toasts, a forced mark for 3 s gives no lock,
      `noRelay`, no beam, the zone's turrets blind, and the bar reads `NO RELAY / НЕТ СВЯЗИ`;
    - the next linked zone locks again;
    - the result screen shows `RELAYS 2 / 18` and fits.
  - `_test/r5_auto.mjs` (`?autopilot=1&noboost=1&q=low`): **the autopilot still delivers, in 2:38 (158.2 s)**, with
    cargo 100 %, health 100 %, 0 masts hit and no console errors. It doesn't target relays, so all 18 stay up and
    locks still happen on the route (8 logged).
  - Screenshots: `shots/r5_relay_link.png` (beam drone → relay → turret during the laser), `r5_relay_down.png`
    (blind section, NO RELAY), `r5_relay_label.png`, `r5_mobile.png`.

## Round 4 — diving becomes gameplay, readable turrets, a second sun you notice
Flight model, speeds, handling, aim assist for drones / turrets, rockets and the LETHE lock / laser sequence are unchanged.

**Underwater threats** (BIBLE: LETHE can't see underwater — so it mines the river and sends hunter-subs).
- **Tethered mines / МИНЫ** (36, in 6 fields):
  - Spiked spheres on link chains, anchored to the riverbed by sinkers. They bob and sway slowly.
  - Depths are mixed: about a third sit just under the surface (−1.1…−1.6 m), so they also threaten a skimming ship.
  - Each has a faint red blinking light underwater. Shallow ones also show a faint red glimmer on the surface.
  - Flying within 4.6 m sets one off: 34 damage (shield first, then cargo), a hard shake and a speed loss. Mines
    within 10 m go off in a chain, and the blast kills hunters nearby.
  - Shootable: with the cannon from underwater, or from above at close range. When flying low (< 8 m), assist
    reaches shallow mines inside ~50 m, and a bolt that enters the water carries a few metres down. A rocket blast at the surface also sets off mines within 15 m. +120 each.
  - Explosion: a ring shockwave of white water, bubbles, a cold flash, and a **water spout** column breaking the
    surface with a wide spray ring.
  - Placement: around the three low dive arches (1375–1525, 3385–3545, 5545–5700) and three open stretches under
    turret cover (2140–2290, 4360–4500, 7140–7290). Each field is a staggered slalom with gaps.
- **Hunter-subs / ОХОТНИКИ** (7, in three deep sections: ~3500, ~5600, ~7000):
  - Small torpedo drones: dark hull, cold cyan nose / side strips and pump-jet glow.
  - They live and patrol only underwater (always below −1.8 m), and ignore a ship on the surface.
  - A submerged ship within 80 m is engaged (sonar ping, at most two hunters at once). The hunter paces ~19 m ahead
    of the ship, or chases it from behind.
  - It charges (0.55 s cyan pulse + rising tone), then fires a dodgeable cyan bolt (78 m/s, 7 damage, shield first)
    every ~2–3 s. If it gets within 5 m it rams and detonates (11 damage).
  - It gives up when you surface, get > 150 m away, or after ~14 s.
  - Kill (+180): bubble burst + cyan flash.
- **Boats / КАТЕРА** (4 on the route: smugglers at ~1020 and ~4700, Council patrols at ~3200 and ~6280):
  - Smugglers are rusty, with crates, a wheelhouse and orange lamps. Patrol boats are grey-white, with blue strobes,
    a bridge, a radar mast and a bow gun.
  - They cruise slowly back and forth (±150 m, turning around) in lanes that avoid the rock columns.
  - **Armoured from above:** bolts from above ricochet (white sparks, metallic ting, a floating `ARMORED / БРОНЯ`
    tag). Rockets don't hurt them either.
  - **Weak from below:** a glowing belly panel (cyan on patrols, orange on smugglers) is visible only from
    underwater. 6 cannon hits from below sink a boat.
  - A destroyed boat explodes, breaks in two (bow and stern separate, tilt up and sink) and trails bubbles, smoke
    and fire. +400 for a patrol, +300 for a smuggler.
  - Hitting a hull = damage like a rock (bounce + 9…13 damage). Diving passes under the keel.
  - Patrol boats fire at a **surfaced** ship within 170 m with line of sight: a two-blip horn and a blue strobe on the
    gun, then 3 dodgeable blue bolts (125 m/s, spread, 7 damage, shield first).
- **Underwater cannon:**
  - Fire works while submerged: slower (260 m/s) turquoise tracers with bubble trails, ~70 m range. They die at the
    surface, the banks and the bed.
  - Aim assist underwater picks mines, hunters and boat bellies (~7.8° cone). Close mines get priority over distant
    rim targets.
  - The reticle turns turquoise underwater and sits on the bolt line. Rockets still can't be fired underwater.
- **Underwater camera** (framing only): the camera now drops ~3 m *below* the ship and looks slightly up. The old
  camera was pinned just under the surface, level with the ship, so the ship hid everything ahead at its own depth.
  Mines and hunters now show below the ship, and the Snell window and boat bellies show overhead.
- **Hints:** a one-line toast on the first approach of each:
  - mines: *Mines below — shoot them or steer clear. / Мины под водой — сбей или обойди.*
  - hunters: *Hunters live underwater — shoot them while diving. / Охотники только под водой — стреляй в нырке.*
  - boats: *Boats are armored on top — dive and hit the glowing belly. / Катера бронированы сверху — ныряй и бей в днище.*
- **Markers:**
  - Underwater, the round-3 brackets cover `MINE / МИНА` and `HUNTER / ОХОТНИК` (turquoise), and each boat's belly
    gets a pulsing orange bracket that is always labelled `WEAK POINT / УЯЗВИМОЕ МЕСТО`.
  - Above water, boats are bracketed `BOAT / КАТЕР · ARMORED`, and shallow mines within 80 m are bracketed too.
- **Score / result:** the result screen adds `MINES / МИНЫ`, `HUNTERS / ОХОТНИКИ` and `BOATS / КАТЕРА` (killed / total).
- **Autopilot:** when low (skimming, diving or under a lock) it steers around mines and boat hulls, and fires at
  whatever the underwater assist locks.

**Turret visibility.**
- **New silhouette:**
  - Dark gunmetal housing with a sloped front, light trim edges (top, sides, collar, muzzle rings) and a fresnel
    rim light, so it separates from the red rock.
  - Longer twin barrels, and a static dark wall backplate + bracket.
- **Red eye:** a bigger lens with a bloom sprite.
  - The sprite has a distance-scaled minimum size (≥ ~16 px) and is fog-compensated, so it reads as a red dot from
    several hundred metres.
  - It pulses brighter (×1.7 size, fast flicker) when the turret holds a lock.
  - The sprites are depth-tested: walls still hide turrets around a bend (you hear them first, as before).
- **Off-screen threat indicator:**
  - A pulsing red double chevron at the screen edge points to any threat that is off-screen, behind a wall or across
    the water surface: a spotter drone marking you, the turret holding the lock / volley, any turret shot, a patrol
    boat telegraphing or firing, or a hunter on the attack.
  - It fades out over 1.5 s after the threat ends. Up to 6 at once.

**Second sun (orbital mirror).**
- **Why it went unnoticed:** it sat at 25° elevation, but the chase camera (pitch −6°, ~62° vertical FOV) has its top
  edge at ~26°, and the HUD band covers the top ~110 px. So it was effectively always off-screen.
- **New placement:** both suns now sit ahead along the dominant route heading (≈ 8° east of −Z).
  - The real sun is low and warm: 10.5° elevation, azimuth +10°.
  - The mirror is cooler and higher: 15.5° elevation, azimuth +28° (≈ 18° right of the sun).
  - That is lower than the brief's 25–35°, deliberately: higher would be off-screen in the chase view.
  - An analytic sweep of the route (camera frustum + canyon-wall occlusion) puts the mirror in view in ~40 % of
    cruise frames, and at least one sun in ~55 %.
  - `__lethe.debug.suns()` reports both on-screen positions.
- **New look** (sky shader):
  - A crisp cold-white disc (0.9° radius, larger than before) and a sharp thin ring at 3.4°, plus a faint second ring.
  - A soft halo and a faint lens cross: a long horizontal streak and a short vertical one.
  - A slow dimming pulse with rare brief stutters, because LETHE is dimming it.
  - The cool fill light, water glints and god-ray shafts follow the new direction.

## Round 3 — from real play-testing (phone + desktop)
**Engine sound / звук двигателя.** The old engine (detuned saws + sub + saw growl) read as a heavy motorboat. It is replaced by
three light presets on their own bus: engine bus → two 170 Hz high-passes (24 dB/oct, no rumble) → soft low-pass → duck → world.
The bus sits well below the old level and briefly ducks under every cannon shot, rocket, explosion and hit, so it never masks them.
- **Jet whisper / Шёпот** (default): airy band-passed noise + a little high hiss + a faint, slightly vibrato 2–3 kHz whine.
- **Turbine / Турбина**: a clean whine (sine fundamental + soft 2nd harmonic, ≈430 → 1300 Hz) rising with speed, thin blade noise.
- **Ion hum / Ионный гул**: a soft open-fifth hum (~205–265 Hz) with slow chorus and a gentle tremolo shimmer on top.

All presets track speed, boost (an airy rush instead of the old growl) and wall/arch proximity. Pick one on the start screen
(segmented control, EN/RU; clicking auditions it for ~1.6 s), or in flight with `V` / the gear icon (brief toast).
The choice is saved in `localStorage` (`lethe.engine`).

**Desktop controls discoverability.**
- Dive was always on `C` / `E` / `Ctrl` (toggle); `Q` is added.
- All game keys are handled in a capturing `window` listener and `preventDefault`-ed in flight, so `Ctrl` used as
  a dive key no longer triggers `Ctrl+S` / `Ctrl+D` / `Ctrl+R` etc. (`Ctrl+W` / `Ctrl+T` can't be blocked by any page, so a
  leave-page confirmation guards the flight).
- On start the focused button is blurred and the canvas takes focus, so a hidden focused button can't swallow
  `Space` / `Enter`.
- On desktop the DIVE / FIRE / ROCKET / BOOST buttons are shown as compact mouse-clickable pills with key labels
  (`DIVE [E]` …), bottom-right. The virtual stick and TILT stay touch-only.
- The start screen has a key legend on desktop and the touch legend on touch devices.
- A small key legend sits bottom-left for the first ~20 s of flight, then fades. `H` toggles it.

**Targeting clarity.**
- **Target markers:** thin amber corner brackets mark drones, relays (round 5; were beacons) and rim turrets that are in view within 260 m, with a
  clear line of sight (walls, arches and rock columns hide them).
  - The first sighting of each type is labelled `DRONE / ДРОН`, `RELAY / РЕТРАНСЛЯТОР` (was `BEACON / МАЯК`) or `TURRET / ТУРЕЛЬ` for a few seconds.
  - Drones that are marking you keep the red LETHE bracket instead.
  - Each force-field mast gets a cyan `DO NOT HIT / НЕ СТРЕЛЯТЬ` tag the first time it comes near.
- **Reticle = where the bolts go.**
  - It sits on the bolt line from between the muzzles, at the first wall / water / rock / arch it would hit, or at
    ~170 m.
  - When aim assist engages a target, the reticle snaps onto it and turns amber, and that target's bracket brightens.
- **Aim assist:**
  - Drones and relays: a ~6° cone (was ~4.3°).
  - Rim turrets: a ±11° horizontal cone with up to ~35° of upward reach, so bolts angle up to the ledges. Strafing
    toward a turret's wall yaws the nose onto it.
  - Assist needs a clear line of fire. It never picks masts, and never fires when a mast is on the line of fire.
  - Rockets take the assisted drone/turret as their homing target (with a 1.4× wider lock cone than the cannon). A rocket locked on a turret launches straight
    along the line of fire, because a pursuit curve would graze the wall below the ledge.
  - Turret kills by cannon and by rocket are verified in the headless test.
- **Hit markers:** every kill flashes an X at the reticle and plays a crisp high double tick on the UI bus, followed by
  the score chime and the score pop.
- **Hints:** toasts now queue instead of overwriting each other. The first turret sighting adds: *"Turrets on the rims fire
  when a drone marks you. Shoot them or the drone. / Турели стреляют по метке дрона — сбей их или дрон."*

**Small fixes.**
- Start screen shows ≈ 2:36.
- A focused, hidden RETRY / BEGIN button could restart the run on `Space` / `Enter`.
- Toasts (first drone, first turret, LETHE "lost him") no longer wipe each other.
- Turret markers and assist ignore turrets hidden around a bend.

## Round 2b — sound pass, rockets + recoil, longer route
**Sound (all procedural, see `AUDIO_CREDITS.md`).** New Web Audio graph: voices → stereo panners → world bus →
underwater low-pass → bus compressor → volume → limiter, with a generated canyon impulse-response reverb (early wall
slaps + diffuse tail) and a filtered slap-echo send.
- **Energy cannon (LETHE signature):** glassy noise crack, bright 1.75 kHz→520 Hz chirp + tick, tight 122→44 Hz sub
  thump, canyon slap/reverb tail; ±7 % random pitch/filter per shot; twin cannons alternate left/right.
- **Rocket:** deep launch thump + rising whoosh + crackle.
- **Explosions:** crack, driven mid crunch, long sub-rumble sweep and debris rattles, panned and distance-scaled.
- **Engine:** replaced in round 3 by three light presets (see above).
- **Water:** rush scaled by altitude, spray when skimming, splashes, muffled underwater mix with bubbles.
- **Shield:** hit is a zing + resonant hum; regeneration a soft rising tone; shield-down a crack.
- **Hazards and LETHE:** two-tone mast-down alarm, geiger clicks by dose, a doppler-shifted and panned whine from the
  nearest drone, rising MARK beeps, lock tone, turret launch whoosh.
- **Audio unlock and volume:** audio unlocks in the start tap/click. The speaker icon (HUD) or `M` mutes; the volume
  and mute state are saved in `localStorage` (`lethe.audio`).

**Rockets / РАКЕТА.**
- 6 per run, 1.2 s cooldown; ammo pips in the HUD; ROCKET button in the right touch cluster.
- Each rocket leaves a smoke trail, has an orange exhaust glow and flame, and accelerates to ~190 m/s.
- Light homing (±12.8° cone, ≤ 1.3 rad/s) toward drones and turrets only — never masts or relays.
- Big explosion with splash damage: targets within 24 m die, and any force-field mast within 16 m breaks. Firing near a
  mast is therefore very risky. The blast also hurts the ship if it detonates within 14 m.

**Recoil.**
- **Rocket launch:**
  - Forward progress dips 13 % (60 ms attack, held to 0.3 s, smooth recovery by ~0.85 s). This is applied only to
    forward motion; the speed/steering model is untouched.
  - The ship mesh kicks nose-up (visual only) and nudges back.
  - The camera pushes back with the dip and gets a short shake.
- **Cannon:** micro-recoil only — a tiny camera tremor and a 0.14 s mesh jolt, no slowdown.

**Longer route.**
- Route is 7.99 km (pad A at 60 m → pad B at 8 050 m); speeds and handling are unchanged.
- Re-spaced content:
  - 12 arches (3 low dive arches), 5 narrow slots, 3 dry tributaries.
  - 13 force-field sections with masts, relays (ex-beacons) and drones.
  - 19 rim turrets, 2 scorched turret wrecks.
  - 11 cables, 13 ruins; scree, lichen and pipeline along the whole route.

## Round 2 — what changed
**Shooting.** Tracers are camera-facing HDR ribbons (white core + amber glow + short trail) that bloom. Muzzle flash =
HDR sprite burst + short flame ribbon + a pooled point light. Every surface hit sparks (walls/rocks/arches: sparks, flash,
dust puff, tick sound; water: small splash). Kills: growing fireball sprites, hot sparks, pooled instanced debris chunks
that tumble, trail sparks and splash into the river, smoke, a light flash (one pooled `PointLight`), distance-scaled camera
shake and a layered synth explosion with debris rattle. Aim assist (round 3: see above) never bends toward masts.

**Shield / ЩИТ.** Fresnel + hex-cell energy bubble around the ship: almost invisible at rest, flashes at the impact point
(amber spot + expanding ring) and overall on hits, shimmers while regenerating, flickers when low, drops out when empty.
It absorbs wall/rock/arch collisions and turret bolts first (bounce/slow on collisions still happen — handling unchanged).
Radiation: while charged it soaks 50 % of the dose and is itself drained (~7 %/s at full dose, blocks regen), so it softens
but never negates radiation. Regen starts 3 s after the last damage and refills in 4 s. HUD: separate bar, "SHIELD DOWN" flash,
glow on regen.

**LETHE spotters & turrets** (see design below). Drones with red lenses build a **MARK / МЕТКА**; full mark → a rim turret
paints the ship with a red laser, then fires an accurate 3-bolt volley. Scattered upper-ledge turrets (15) with red eyes
track the ship; unmarked they only fire rare inaccurate shots. Turrets can be shot (+250; aim assist reaches up to them since round 3).

**Review fixes.** Camera pulled back/up and the ship scaled to 0.85 (ship ≈ 1/7 of frame width; the line ahead is
readable). Camera lateral offset is clamped inside the analytic canyon walls with a 5 m margin, smoothed, plus a
sight-line check against the inner wall of tight bends. Orbital mirror is a clearly visible cold-white disc with halo,
a dimmed flickering ring and a cool fill light. (Route length: see round 2b — 7.99 km.) Start screen re-done in the codex
editorial layout (fits 915×412 and 844×390 without scrolling, tap anywhere / BEGIN, audio unlock). Underwater uses
codex's teal fog (`#123e47`, density 0.019), camera follows below the surface, Snell-window surface seen from below.
Phone HUD: stick zone and buttons never overlap HUD bars (checked at 915×412 and 844×390), safe-area insets everywhere.

**Visuals.** Canvas-generated tileable rock albedo + normal map (strata ledges, cracked blocks, gullies, desert-varnish
runs), dusty ledges, damp/mossy lower banks; instanced-style merged scree and fallen blocks at wall feet; lichen patches;
water pipeline on stilts; high cables with warning lights; ruined terraforming towers and condensers; a crashed courier
half in the water (with foam); a scorched turret wreck; a mast broken on a previous run; two dry tributary notches;
LETHE warning signs and striped bank markers. Settlements: habitat domes with lit window bands, pads with landing-light
rings and approach lights, antennas, cranes, water tanks, a desalination plant with steam, a tall beacon tower at B.
River: three scrolling wave octaves, fresnel reflection (walls low / hazy sky high), sun + mirror-sun glints with sparkle,
bank and rock foam, a foamy V-wake ribbon behind the ship, spray. Sky: dusty gradient, cirrus, sun and dimmed mirror, three
parallax mesa silhouette layers. Atmosphere: global height haze (patched three fog chunk), dust motes, additive god-ray
shafts from the mirror sun. Ship: more detailed Cormorant — armoured wedge nose, framed canopy, pods with intake grilles,
fins and hazard bands, amber running lights, PBR-ish materials (panel-line/scratch/soot canvas texture, roughness map,
PMREM canyon env map), HDR engine discs, noisy exhaust plumes, wing nav lights. Post: `EffectComposer` → `UnrealBloomPass`
→ grade pass (display→linear, warm-highlight/teal-shadow split tone, vignette, grain) → `OutputPass` (ACES Filmic + sRGB).
Directional sun with a ship-following PCF shadow map (high tier) + a soft blob shadow on the water (all tiers).

**Adaptive quality.** `high`: bloom full-res, shadows, grain, DPR ≤ 1.5. `med`: bloom half-res, no shadows/grain, DPR ≤ 1.25.
`low`: no post (direct render, no tone mapping), DPR 1, no set-dressing meshes / god rays / motes. Touch devices start at
`med`, desktop at `high`. FPS is measured over rolling 2.5 s windows: < 45 fps drops a tier, > 58 fps for three windows
raises one (3 s hold after every change; phones never auto-raise to `high`). `?q=` forces and locks a tier.

**UI.** System font stack with light/medium weights and wide tracking; thin bars with smooth value tweening, a fading
"ghost" damage trail and a shake/brighten pulse on damage; fade-in from black, fading start → flight → result transitions;
editorial result screen (time, cargo, health, targets, masts, LETHE hits, score).

## LETHE drone design (why drones matter)
BIBLE.md: LETHE is the automated turret network on the canyon rims, and **it cannot see underwater** — that is why river
pilots dive when a missile is already locked. Round 1 drones were just score targets. Now they are LETHE's **eyes**:
- A drone that has the ship in view (ahead of / near it, ≤ 250 m, clear line of sight against walls and arches, ship not
  submerged) builds **MARK** on the ship: ~3.4 s from 0 to full. While building: red pulsing bracket on the spotter, red
  MARK bar under the route bar, rising beeps, the drone turns its red lens to face you. Each spotting drone also tags
  the ship with brief **cold-cyan** ping beams (a short dash, twice — tyn-tyn — then a gap; a little faster and brighter
  as the mark fills). Cyan is the scanner. The turret designation laser stays red. Faint red-amber data packets still
  run drone → relay → turret, dimmer so they don't compete with the cyan tag. No pings underwater.
- Full MARK → the nearest rim turret of that section takes the lock (round 5: only through a live relay of the ship's section): red targeting laser (1.35 s), then a 3-bolt volley
  aimed at where the ship will be along the curving canyon. Flying straight gets you hit; hard lateral/vertical dodges or a
  dive make it miss (bolts hit the water / walls). Hits go to the shield first.
- Without a mark turrets stay mostly silent, firing only rare deliberately inaccurate harassment shots.
- Ways out: **shoot the spotter** (mark resets to 0, pending laser breaks — "SPOTTER DOWN"), **dive** (mark decays fast,
  the laser lock breaks and LETHE says "…and I lost him / …и я потеряла его", BIBLE's recurring line), or **out-run** it.
- Tension: spotters hover near the cyan force-field masts, so shooting them in a hurry risks a stray hit on a mast — which
  drops that section's radiation field. Shooting is meaningful, but risky.
- A one-line hint is on the start screen and a toast appears on the first drone encounter.

## Rules (unchanged mechanics)
- **Cargo / ГРУЗ**: wall, rock-column and arch hits bounce/slow the ship; damage goes to the shield first, then the tank.
  0 % = mission failed.
- **Dive / НЫРОК**: wings sweep back, canopy armour closes, engines turn cold turquoise, teal fog, muffled audio, bubbles,
  slower speed. **Air / ВОЗДУХ** ≈ 60 s; refills on the surface. Splashes on entry/exit and spray/wake when skimming.
- **Force-field masts**: hit one → −300, its section's field flickers and collapses; inside an unshielded section the
  screen tints red, geiger crackle, **RAD** meter, **Health** drains ~5.5 %/s (−50 % while the shield holds; diving
  blocks ~90 %). Health 0 = fail.
- **Water burn** (round 6): boost and thin air burn cargo water (see above).
- Settlement B: auto-landing. Result: time, cargo, water delivered / burned, health, targets, masts, relays, LETHE hits, score (+cargo/health/time bonus), retry.

## Structure
```
index.html        importmap, HUD / touch controls / start + result screens (DOM + CSS)
src/main.js       game state & loop, flight model, collisions, damage+shield, shooting (air + underwater), LETHE
                  spotters/turrets, naval layer (mines, hunters, boats, spouts), off-screen threat chevrons, hazards,
                  camera, HUD, quality switching, test hook
src/world.js      canyon spline (1 m table), width/height profiles, wall function (incl. tributary notches), riverbed,
                  level layout (arches, rocks, wreck, zones, relays, masts, drones, turrets, mines, hunters, boats,
                  set-dressing positions)
src/naval.js      round 4 instanced meshes: mines + chains + sinkers, hunter-subs, boat halves + belly panels,
                  LETHE turret head + wall mount, fresnel-rim Lambert material
src/terrain.js    chunked canyon meshes (terrain / scree / props / settlement / emissive per 240 m chunk), height-haze
                  fog patch, river shader, rock foam, god-ray shafts, force-field vaults + curtains, sky shader
src/textures.js   canvas textures: tileable rock albedo + normal map, ship panel/roughness maps
src/ship.js       Cormorant: GLB model + LOD (round 7, merged per material, anchors from geometry) with the procedural
                  ship as instant placeholder / fallback, PMREM env map, shield bubble shader, exhaust plumes, dive anim
assets/ship/      baklan_lod0.glb (LOD0, 1K textures), baklan_lod1.glb (LOD1, 512 textures), baklan_stats.json
src/fx.js         glow sprites, CPU particles, speed streaks, beams (tracers/lasers), debris pool, dust motes, wake ribbon
src/post.js       EffectComposer chain (bloom, grade, output) + quality tiers + fps governor
src/audio.js      procedural Web Audio: 3 engine presets on a high-passed, ducked bus, bus compressor + limiter, canyon reverb, slap echo, panned voices,
                  water rush, drone whine (doppler), weapons, explosions, shield, alarms, volume/mute
src/input.js      keyboard, mouse, multi-touch stick/buttons, gyro tilt
AUDIO_CREDITS.md  statement: all audio is procedural (no samples)
lib/              vendored three.js r170 (+ postprocessing addons copied from the r170 package)
```

## Testing hook
`window.__lethe.state()` → `{t, speed, distToB, cargo, hull, health, air, score, underwater, phase, outcome, s, lat, y, dive,
radiation, mastsBroken, kills, turretKills, shield, mark, spotters, lock, turretShotsFired, turretHits, ebLog, rkLog, quality, fps,
camDist, camWallGap, drawCalls, triangles, rockets, rocketsFired, recoilDip, muted, volume, engineSound, aim, markers, legend,
mines, hunters, boats, navalHits, threats, markerKinds, shipModel}` (round 7: `shipModel` = `'glb'` | `'procedural'`)
(`aim` = kind of the target aim assist is engaged on, incl. `mine` / `hunter` / `boat`; `markers` = visible target brackets,
`markerKinds` = their kinds; `legend` = HUD key legend shown; round 4: `mines = {alive, killed, hit}` (hit = contact
detonations), `hunters = {alive, killed, rams, shots, hunting, visible}`, `boats = {alive, killed, shots, ricochets}`,
`navalHits` = boat / hunter bolts that hit the ship, `threats` = off-screen chevrons shown).
Also `__lethe.start()`, `retry()`, `warp(s)`, `input` and `__lethe.debug`: `spawnDrone(ahead, lat, y)`, `forceMark(v)`,
`damageShield(n)`, `breakMast(i)`, `setQuality('low'|'med'|'high')`, `setEngine('whisper'|'turbine'|'ion')` (also accepts
the display names), `nearTurret(i, back)` (park the ship `back` m before the i-th live turret), `masts()`, `turrets()`.
Round 7 adds `shipInfo()` (muzzles / nozzles / lifts / rocket port in world space, LOD level state, engine emissive, glow
colour, armour + bubble) and `closeCam(az, el, dist)` (debug orbit camera in the ship's frame; `closeCam(null)` = off).
Round 4 adds:
- `spawnMine(ahead, lat, y)`, `spawnHunter(ahead, lat, y)` and `spawnBoat(ahead, lat, 'patrol'|'smuggler', speed)`
  spawn into spare debug slots near the ship (`lat` = `null` → the ship's lane).
- `naval()` lists every mine / hunter / boat.
- `place(s, lat, y, dive)` parks the ship.
- `threat('turret'|'drone', i)` reports a threat.
- `suns()` gives the on-screen NDC of both suns plus the camera pitch / FOV.

**Round 4 tests** (headless Chromium + SwiftShader, `?q=low`):
- `_test/r4.mjs desktop|touch` at 1280×720 and 915×412 (touch emulation), **20/20 pass on both, no console errors or
  warnings**:
  - The naval layout is 36 mines / 7 hunters / 4 boats.
  - **Mines:** flying into a mine detonates it (shield 100 → 66). Underwater the assist locks a mine and the cannon
    destroys it. A shallow mine is shot from above at close range (assist seen, mine killed, no contact).
  - **Hunters:** a hunter ignores a surfaced ship, has no marker from above and stays below −1.5 m. It engages a
    submerged ship and is shot underwater.
  - **Boats:**
    - Cannon bolts from above ricochet (`ARMORED`, hp unchanged), and a rocket from above leaves the boat intact.
    - Underwater the assist locks the belly (`markerKinds = weak`), and the cannon sinks the boat.
    - Flying into a hull damages the ship. A patrol boat fires at a surfaced ship.
  - **Threat chevrons:** a turret behind the ship shows a chevron, and it is gone ≈ 1.5 s (sim) after the last report.
  - **Result screen:** it shows `MINES x / 36`, `HUNTERS x / 7`, `BOATS x / 4` and fits without scrolling. The start
    screen still fits.
- `_test/r4_auto.mjs` (`?autopilot=1&noboost=1&q=low`): **the autopilot delivers in 2:38** in all three runs
  (157.8–158.0 s), with cargo 100 %, health 100 %, 0 masts hit and no console errors.
  - It brushes 0–2 mines per run (frame timing differs under SwiftShader), and the shield absorbs every contact.
  - It shoots 2–3 mines and up to 1 hunter on the way.
  - It takes 7–9 boat / hunter hits, all on the shield.
- `_test/r3.mjs desktop|touch` (round 3 checks: dive keys, legend, engine presets, turret kills by cannon and rocket)
  still all pass, with no errors.
- `_test/r4shots.mjs [q] [sun|mines|boat|hunter|turret]` takes screenshots for visual review.

Round 3 script `_test/r3.mjs desktop|touch` at 1280×720 and 915×412 (touch emulation):
- No console errors or warnings, and the start screen fits without scrolling.
- The engine selector works without starting the run, and the choice persists in `localStorage`; `debug.setEngine`
  works.
- Desktop:
  - The key legend shows at flight start and `H` toggles it.
  - **`E`, `Q`, `Ctrl` and clicking the DIVE button all set `underwater=true`** and surface again.
  - `V` cycles the engine presets.
  - The DIVE / FIRE / ROCKET / BOOST pills are visible with key labels; the stick and TILT are hidden.
- Touch: the DIVE tap dives, and the gear button cycles the engine.
- **Turret kills:** with the ship parked below a rim turret and strafing / climbing toward its wall, aim assist
  engages (`aim=turret`). Holding fire destroys the turret, and a single rocket destroys the next one.

Round 2 checks still hold:
- Autopilot delivers on the 7.99 km route in 2:38 at cruise speed (`?autopilot=1&noboost=1`, `_test/r3_auto.mjs`), with cargo
  and health at 100 %, no masts hit and no console errors.
- Rocket cooldown, ammo and the 13 % recoil dip work, and the cannon doesn't slow the ship.
- Spotter → mark → laser → volley → hits works; diving breaks the lock.
- Under radiation, health drains at half rate while the shield drains.
- The quality governor steps down through the tiers.

## Known issues
- **Round 4 balance is first-pass and tuned by reasoning plus the autopilot run, not by human play.** The knobs are:
  - mines: 34 damage, 4.6 m trigger, 36 mines;
  - hunters: 7 damage per bolt every ~2–3 s, max two engaged at once;
  - patrol boats: 3 × 7 damage bursts every ~3–5 s;
  - boats: 6 hits from below.
  All of them are constants at the top of the naval section in `main.js` and in `world.js`.
- **Underwater camera:** it now sits ~3 m below the ship, looking up, so mines and hunters ahead are not hidden by the
  ship. A boat belly *directly* overhead and within ~35 m can still be hidden by the ship itself, but its bracket
  stays visible and the assist still locks it.
- **The mirror sits at 15.5°, not the brief's 25–35°.** The chase camera's top edge is at ~26° and the HUD band covers
  the top ~110 px, so anything above ~18° is essentially never on screen in flight.
  - The canyon walls still hide both suns in tight bends: the analytic sweep gives the mirror in view ~40 % of the
    time, and at least one sun ~55 %.
  - Moving the real sun lower (10.5°) also lengthened shadows and the blob shadow, and the god-ray shafts are capped
    at 300 m.
- **Boats run in straight path-space lanes** (they don't avoid each other or the player). The hull collision is a
  path-aligned box, rotated only by the boat's heading.
- **Hunters don't path-find around rock columns.** They are clamped to the river width and stay above the bed.
- **Off-screen chevrons can stack at the bottom edge** when several drones behind the ship mark it at once (one per
  threat, max 6).
- **Audio is synthesised and was only checked for errors and graph construction headless.** No listening check was
  possible there. The three engine presets were levelled by reasoning (well below the weapons, high-passed at 170 Hz) and
  want a listening pass on real speakers and phones; per-preset levels are in `Audio.updateEngine`.
- **Turrets need the nose roughly toward their wall.** Aim assist reaches turrets on the rims only inside a ±11°
  horizontal cone, so you have to strafe toward the turret's wall to yaw onto it. Turrets around a bend (no line of
  fire) are neither marked nor assisted.
- **Target markers use the analytic canyon for occlusion** (walls, arches, rock columns). Set-dressing props don't hide
  them.
- **Leaving mid-flight asks for confirmation.** `Ctrl+W` / `Ctrl+T` can't be intercepted by a web page, so the
  beforeunload prompt is the only guard when `Ctrl` is used as the dive key. `E` / `Q` are the recommended dive keys.
- **Rockets have no ammo pickups** (6 per run), and their blasts don't damage canyon geometry (arcade collision model).
- **Performance on real hardware is unprofiled.**
  - No physical phone was tested. `med` is the expected default on phones; heavy dressing and post scale down
    automatically.
  - SwiftShader runs at ~4–20 fps, so the governor sits at `low` in headless tests.
- **Shadows are limited.** The high-tier shadow map covers a ±32 m box around the ship, and canyon walls don't cast
  shadows (baked AO in vertex colours instead).
- **Low tier looks different.** It renders without tone mapping/grade, so it is flatter and slightly different in colour
  from med/high.
- **Collisions are arcade path-space** (analytic walls, columns and arches). Set-dressing props (pipe, ruins, lichen) are
  visual only.
- **Fullscreen and orientation lock are best-effort** (not available on iOS Safari).

## Round 10 — river threats and waterfall curtains

Patrol boats announce themselves with red/white mast, bridge, bow and stern strobes;
smugglers retain amber lamps. Both have a white bow wave and instanced, fading foam
wake (32 m on medium/high, 9 m on low). Medium/high add a soft searchlight and water
pool; an alerted lamp turns toward the player. These effects share four instanced
batches, with only the bow/wake batches visible on low. Running lights use the
existing glow batch. A panned synthesized diesel/horn cue plays once per boat per run
at 400 m, alongside the short English/Russian dive hint.

Boat brackets and edge arrows now reach 400 m; active patrol warnings turn red.
Patrols engage at 335 m after a 0.8 s gun strobe/aim-laser warning, firing the existing
three visible, dodgeable tracers. Every burst rechecks line of sight and cancels on
dive. Damage is slightly reduced (7 to 6 per bolt) to balance the extra range.
Top armor and belly vulnerability are unchanged; rocket armor impacts now also emit
metal sparks and the same ping used for bullet ricochets.

Waterfall widths increased from 7/4 m to 18/10 m (2.57×/2.5×), with three geometry
sheets in each original draw batch, denser filaments, broader pools and fuller spray.
The analytic wall and collision corridor are unchanged. Low still omits waterfalls.

Performance probe: `/usr/bin/google-chrome`, SwiftShader, 915×412 touch, locked medium,
3 s warmup and 20 s sample. Raw records are in `_test/r8_perf.log`.

| Metric | `r10_before` | `r10_after` | Change |
|---|---:|---:|---:|
| Average frame time | 116.86 ms | 121.48 ms | +4.0% |
| p95 | 216.6 ms | 216.6 ms | 0% |
| Draw calls | 104 | 107 | +3 |

The sample labeled `r10_after_contended_discard` overlapped another browser test and
is excluded. The before and accepted after probes ran in isolation.

Validation commands (server: `python3 -m http.server 8123` in `variants/`):

```sh
python3 _test/r10_invariants.py
CHROME=/usr/bin/google-chrome node _test/r8_perf.mjs r10_after
CHROME=/usr/bin/google-chrome node _test/r6.mjs skipRun
CHROME=/usr/bin/google-chrome node _test/r7.mjs skipRun
CHROME=/usr/bin/google-chrome node _test/r8.mjs skipRun
CHROME=/usr/bin/google-chrome node _test/r9.mjs
node _test/r10.mjs
```

The Round 10 invariant script uses the required checkpoint; legacy tests remain unchanged.
All protected flight functions, world layout, quality governor and wall profile match
`72f3e9d` byte for byte. Legacy test assertions are unchanged. Round 10 checks tiered
boat effects and light colors, 300+ m fire, telegraph timestamps, the hint, boat bracket
and offscreen arrow, curtain widths/layers, console errors and uninterrupted delivery.
Screenshots use the existing cinematic/freeze hooks and live combat effects:
`shots/r10_boat_far.png`, `r10_boat_fire.png`, `r10_boat_marker.png`, `r10_ricochet.png`,
`r10_waterfall.png`, `r10_waterfall_close.png`, `r10_desktop.png`, `r10_mobile.png`.

Legacy regressions: Round 6 **12/12**, Round 7 **19/19**, Round 8 **7/7**, Round 9
**16/16**, including uninterrupted delivery in **117.64 s** with **90.2%** cargo
and zero console errors. The widened curtain/pool envelope checks **308 vertices**,
with minimum corridor clearance **1.31 m**. Rounds 6–8 use their existing `skipRun`
option; Round 9 and Round 10 each run the complete route without acceleration.

Round 10 full probe: **17/17**, delivery in **117.82 s**, **90.3%** cargo,
zero console errors (`_test/r10_verified.log`). Visual review corrected a foreground
pillar obscuring the far patrol, overlapping debug boats, and excessive white lamp
bloom; the final marker view includes both a bracket and a boat edge arrow.

The table uses the final isolated after sample (**+3.95%**, within the **+10%**
budget); the earlier isolated after sample was **118.41 ms** (+1.3%). Final visual
refresh: **16/16**, no console errors (`_test/r10_shots.log`).

### Round 10b — polish after review

**Waterfalls.** Each sheet is now a 9-column grid per layer, so it follows the wall
column by column. It flares ~10% toward the foot and bulges up to 0.9 m toward the river,
with each vertex clamped to at least 0.35 m behind the analytic wall. The shader frays
the side edges into separate noise-broken fibres and softens the top lip. The foot
dissolves into a bright white impact band instead of ending in a hard rectangle. Three
mist emitters sit at the foot: a billowing cloud of 6→34 m sprites drifting out over the
river, white impact spray thrown upward, and thin wisps that peel off the side edges as
they fall. Medium emits at a lower rate than high, and low still omits waterfalls. The
r9 corridor check still passes (minimum clearance 0.95 m).

**Boats at distance.** Running lights keep a minimum on-screen size (14–44 px, scaled
with camera distance) and brighten by up to 1.7× through the haze. Red and white now
alternate between 1.2 and 0.08 intensity, and patrols add a double-flash xenon strobe on
the mast top. The boat wake starts at the bow and has Kelvin V arms (~20°), a churned
foam band behind the stern, and a soft sheen. On medium/high it is 64 × 30 m, on low
16 × 14 m. The water decals use a polygon offset so they don't z-fight the waves at
300 m. The boat bracket now has a 76–130 px minimum and an always-on boxed label
`КАТЕР / BOAT · <distance> m` (plus `· ARMORED` on first sighting). It still turns red and
pulses while the boat telegraphs or fires.

The r10 wake-length assertion changed from 9/32 m to the new 16/64 m budget. The r10
waterfall shots now settle for 6 s so the mist can build. Shots refreshed:
`r10_boat_far.png`, `r10_boat_marker.png`, `r10_waterfall.png`, `r10_waterfall_close.png`
(plus the other r10 shots, re-taken by `_test/r10.mjs`). The quick re-shoot script is
`_test/r10bshots.mjs [boats|falls]`.

Performance (medium, 915×412 touch; the machine had an unrelated Chrome running):

| Sample | Avg frame | vs `r10_before` 116.86 ms |
|---|---:|---:|
| `r10b_after` (pre-trim, outlier) | 133.66 ms | +14.4% |
| `r10b_after` | 127.84 ms | +9.4% |
| `r10b_after` | 122.52 ms | +4.8% |
| contended control, `71f1abe` (pre-10b), 2 runs | 133.11 / 118.82 ms | — |
| contended pair, 10b, 2 runs | 125.62 / 123.25 ms | — |

Under the same contention the pre-10b build averaged 126.0 ms and 10b averaged 124.4 ms,
so the polish has no measurable cost. The first outlier ran before medium mist was
trimmed. Draw calls are unchanged (107–108).

Round 10b regressions (`_test/r10b_tests.log`): invariants vs `72f3e9d` byte-identical;
Round 6 **12/12**, Round 7 **19/19**, Round 8 **7/7** (`skipRun`), Round 10 **17/17**
(delivered in 117.54 s, 90.2% cargo), Round 9 **16/16** (delivered in 117.77 s, 90.3% cargo,
corridor clearance 0.95 m over 1358 vertices). There were zero console errors.

## Round 11 — tutorial boat encounter

The player couldn't react to boats in time, so the first boat of a run now gets a short
tutorial. Handling, physics, speeds, camera, aiming, recoil, the collision corridor, the
layout, the autopilot and the water burn are unchanged. `_test/r11_invariants.py`
checks them against `8740da1` (end of round 10), and all checks are byte-identical
(`_test/r11_invariants.log`; the r9/r10 invariant scripts also still pass).

**Slow motion.** The first time an alive boat ahead comes within 400 m (with tips on and
the tutorial not yet seen), the game runs at 0.3× for about 2.5 s: a 0.4 s smoothstep
ease-in, 2.1 s hold and 0.4 s ease-out. It is one global `timeScale` multiplied into the
shared `dt` in `loop()`, so everything slows equally and handling at 1× is untouched.
The player keeps full control. The tutorial clock runs on real time, and diving ends the
slow-mo early. Toast timers also use real time; a toast that would land under the
prompt is hidden and waits until the tutorial ends.

**Audio** (`audio.js`). `slowmo(k)` drops the pitch of every voice by up to 30%. That
covers one-shot tones and noise hits, the engine presets, the noise beds via
`playbackRate`, and the drone whine. It also pulls the world low-pass down to about
900 Hz. There is no music track, so the SFX and the beds carry the effect. The new
`tutorialSting()` is a procedural "wo-AH" radio-voice chirp: two detuned saw "glottal"
sources through three gliding formant band-passes (/o/ → /a/). A soft two-tone horn sits
under it, followed by a rising and falling whoosh. It plays on the UI bus and is exempt
from the pitch drop.

**Prompt.** A big centred «Катер впереди — ныряй!» / «BOAT AHEAD — DIVE!» appears in the
upper-middle of the screen, above the horizon where the boat bracket sits. Desktop shows
`Press [E] to dive`. Touch shows `Tap DIVE ↘`, and the on-screen **DIVE** button glows
with two expanding rings (a flatter ring on the desktop button). An animated ghost
diagram shows the path diving under the hull and an arrow shooting up, captioned
"dive under ↓, shoot up ↑ · нырни под него и бей снизу". The prompt stays up until the
player dives or 4 s pass, then fades. On short screens (≤ 500 px tall) it is compacted
and moved up. The round-10 boat toast is skipped when the tutorial shows.

**The tutorial boat** doesn't telegraph or fire until the player dives or the 4 s
prompt times out, and it moves at 0.6× speed.

**First mission easier.** The first two boats of the run, ordered by position (the
smuggler at 1020 m and the patrol at 3200 m), cruise at 0.65× and use a 1.6× gun
cooldown. Later boats are normal, and the round-10 ranged fire and telegraph are
unchanged. These are multipliers in `main.js`; `world.js` is untouched. The easing
applies even with tips off.

**Persistence and settings.** `localStorage['lethe.tips.boat'] = '1'` is written when the
tutorial triggers, so it shows once. `lethe.tips` = `'0'` / `'1'` stores the setting. The
gear button only cycles the engine sound (unchanged, and `_test/r3.mjs` relies on it),
so the toggle lives in the start-screen settings block next to the engine selector:
**TIPS / ПОДСКАЗКИ — ON / OFF**. Turning it on clears the seen flag and re-arms the
tutorial. With tips off there is no slow-mo or prompt, but the first-two-boat easing
still applies.

**Debug hooks.** `__lethe.state()` adds `timeScale` and a `tutorial` block:
`{phase: idle|active|done, timeScale, minScale, t, prompt, divePulse, hold, dived, dist,
count, boat, triggerAt, releaseAt, triggerS, tips, seen, armed}`. `__lethe.debug` adds:
- `tutorial(i)`: trigger on boat `i`, or the nearest boat ahead (debug boats too).
- `tutorialFreeze(on)`: hold the tutorial clock; combine with `freeze()` for shots.
- `tutorialReset()`.
- `setTips(on)`.
- `boatEase()`: per-boat pace and cooldown multipliers.

`boatShotLog()` entries now carry the boat index `i`.

**Tests.** `_test/r11.mjs` (`skipRun` skips the delivery) passes **34/34**; the log is
`_test/r11.log`. It checks:
- the natural trigger at 397–399 m on the first real boat;
- the dip to 0.30 and the return to 1, with intermediate ease values;
- the prompt staying up until the 4 s timeout;
- the `lethe.tips.boat` flag, the single trigger, and no repeat on retry;
- the toggle: OFF persists, ON re-arms;
- tips off: no slow-mo;
- the easing multipliers, plus a measured hull speed (boat 1 runs at 0.65× boat 3);
- the held boat not firing before release, by timeout and by dive;
- the dive ending the slow-mo early;
- prompt and HUD overlap on desktop and touch;
- the touch DIVE pulse and ring animations;
- the full autopilot delivery with the tutorial live (119.0 s, 90.5% cargo);
- zero console errors.

Old suites, unchanged, with the tutorial live (`_test/r11_old_*.log`): r7 **20/20**,
r8 **8/8**, r9 **16/16** and r10 **17/17** (r8, r9 and r10 each delivered under
autopilot). r6 went 12/13 when all five suites ran in parallel. Its "10 s boost burns ~1.5 %" check
waits a fixed real time for game time, and five browsers plus the 0.3× slow-mo starved
it. Run alone it passes, **12/12** with burned 1.53 % (`r11_old_r6_alone.log`), and the
parallel run's full delivery passed. No old test needed `?tips=0`.

Shots:
- `shots/r11_slowmo_desktop.png`: 1280×720, frozen at 0.3×, prompt above the patrol boat under the arch at 197 m.
- `shots/r11_slowmo_touch.png`: 915×412, compact prompt, pulsing DIVE ring.
- `shots/r11_settings_tips.png`: start screen with the TIPS toggle.
- `shots/r11_dive_under.png`: under the patrol boat with the WEAK POINT bracket.

Performance (medium, 915×412 touch, `_test/r8_perf.mjs`, `_test/r8_perf.log`):

| Sample | Avg frame | Draw calls |
|---|---:|---:|
| `r11_before` (2 runs) | 136.24 / 121.44 ms | 107 |
| `r11_after` (2 runs) | 119.46 / 120.18 ms | 108 |

`r11_after` is within the +10% budget, even against the faster `r11_before` run (−1.3%).

## Round 12 — torpedoes and boat combat from below

The player found hitting boats from below too hard: pitching up in the narrow space was
awkward and the murk hid the hull. Approved design: the ROCKET becomes a homing torpedo
underwater, the cannon gets a strong belly assist underwater, the boat itself becomes
readable from below (**the underwater murk is unchanged**), and skimming over a boat
on the surface is punished.

**Torpedo** (ROCKET / `[R]` / RMB while submerged; `fireTorpedo`, `updateTorpedoes`).
It uses the same rocket ammo pips, the 1.2 s cooldown and the rocket recoil (forward
dip, nose kick, camera shake), with a hull thunk, an air-bubble gurgle and a receding
propeller whirr (`audio.torpedo()`, procedural). It locks onto the nearest alive boat
within **250 m** in a **±60° horizontal cone, any elevation**. The cone is measured
along the river in path space, so no pitch-up is needed. The torpedo runs in path space
at −2.5 m, so it follows the river bends and slips around rock columns. It pursues the
target at a capped 4.2 rad/s turn rate (up to 88 m/s), rises into the belly over the
last ~34 m and detonates on the hull, with an underwater blast, a spout and sparks
in the boat's colour. It leaves a bubble trail (emitted per metre: 3 / 1.5 / 0.9 m
spacing on low / med / high), a pale wake streak, a cold motor glow and a faint
streak under the surface. With no target it runs straight along the river and
scuttles after 3 s, harmlessly. It ignores mines and hunters on the way, so a lock is
reliable. Its blast chains nearby mines and kills hunters.

**Damage rule.** One torpedo sinks a **smuggler**. A Council **patrol boat** takes
**two**: each torpedo breaches half its hull (6 → 3 HP), the popup says
`HULL 50% · ONE MORE / ЕЩЁ ОДНА`, and a new HP bar on the boat bracket shows it. One
torpedo plus three belly bolts also sinks a patrol boat.

**Lock HUD.** Underwater, the locked boat's belly bracket turns into a larger, pulsing
orange **«TORPEDO LOCK / ТОРПЕДА · N m»** bracket. It reuses the target-bracket pool,
and a two-ping sonar tone sounds on each new lock. Underwater boat brackets now reach
260 m, so boats stay marked through the murk; the lock bracket also shows behind a
bend.

**Cannon underwater.** The assist cone for a boat's belly weak point is **±25°**
(other naval targets keep their 7.8° cone). Bolts aim at and converge on the belly,
and the reticle snaps to it. Underwater bolts also test their segment midpoint against
hulls, so long frames don't tunnel past a belly. It sinks boats without rockets, just
slower (6 bolts).

**Boat from below** (`boat-fx.js` `buildBoatUnderFX`, underwater camera only). The fog
colour, density and visibility are **unchanged** and checked against `6cf69a9`. The new
effects use that same fog, so they add light around the hull and don't clear the water.
- `under`: a 44 × 80 m additive patch just under the surface, with Snell's-window light
  pooling around the hull, moving caustic ripples and wake turbulence behind the stern.
  The hull albedo drops to 0.2 underwater (the rim light stays), so it reads as a **dark
  silhouette** against the bright surface.
- `wash`: a churning propeller-bubble band trailing the stern (med/high), plus rising
  prop bubbles: 8 / 22 / 36 per second on low / med / high, only within 120 m.
- The belly weak point gets a stronger pulsing core, faster and brighter while
  torpedo-locked.

Both meshes are instanced (one draw call each) and hidden above water.

**Underwater camera.** Underwater only, the camera is raised from 3.2 m *below* the
ship to about 0.4 m *above* it (still clamped under the surface). It is pulled back
7 m (24 → 31 m before the canyon tightening) and looks slightly higher (+1.4 m). The
offset is blended in with a 0.7 s smoothstep (`G.uwCam`) after the dive; on surfacing
the existing camera damping blends it out. `G.uwCam` is 0 whenever the ship isn't
submerged, so the surface camera is byte-for-byte the old path. The extra pull-back
shrinks so the camera never parks behind a rock column in the river (`uwCamBack`). The
fog limits how far back the camera can go: further back, the boats would fade out
(about 27% visibility at 60 m).

**Close-range punish** (`updatePunish`). A ship above water that passes over or by a
boat within **40 m** without diving draws a point-blank burst. This applies to both
types; the smuggler has a deck gunner.
- **Telegraph:** for **0.65 s**, the red aim laser sweeps onto the ship and then
  freezes on a lock line for the last 0.2 s (thicker and solid). It comes with a rising
  siren, an alert boat bracket and «POINT-BLANK — DIVE OR JINK! / В УПОР — НЫРЯЙ ИЛИ
  УХОДИ!».
- **Burst:** 5 heavy bolts (24 each, 190 m/s) go down the locked line, led forward
  along the river but not sideways.
- **Avoiding it:** diving any time before the burst cancels it. A quick sideways or
  vertical jink makes every bolt miss.
- **Damage:** 120 total, a full shield plus ~20% hull. It never kills a full-health
  ship.
- Each boat then has a 4 s cooldown, and the tutorial boat holds this fire too.

**Tutorial (round 11 system).**
- The prompt is now «Нырни и пускай торпеду [R]» / «DIVE, THEN FIRE A TORPEDO [R]».
- New diagram: the ship dives ↓, then a dashed torpedo → the boat's pulsing weak spot.
- Desktop shows `[E] dive, then [R] torpedo`. Touch shows `Tap DIVE, then ROCKET`, and
  DIVE pulses first.
- After the tutorial dive, while submerged with a lock, the **ROCKET button pulses**
  with an orange ring. This works on touch and on the desktop key strip, for up to 7 s
  or until a torpedo is fired.
- The slow-mo, prompt timing and tips toggle are unchanged.
- The round-10 first-boat toast now reads «Boats: dive, then fire a torpedo [R] /
  Нырни и пускай торпеду [R]».

**Autopilot.** `autopilot()` itself is byte-identical. Two hooks in `loop()` drive it:
- `apBoatDive()` feeds the autopilot's existing dive timer when a live boat is close
  ahead (−25…170 m) or a punish telegraph is on. The autopilot dives under boats as the
  tutorial teaches.
- When submerged with a lock, it launches one torpedo at a time.
The underwater `aimObj` auto-fire (now with the wider belly assist) does the rest.

**Protected functions** (`_test/r12_invariants.py` vs `6cf69a9` → `_test/r12_invariants.log`).
These are byte-identical: `autopilot`, `updateFlight`, `collide`, `toggleDive`, `fire`,
`rocketTargetOK`, `findRocketTarget`, `fireRocket`, `updateRockets`, `updateReticle`,
`updateBurn`, `boltAimPoint`, `updateBolts`, `shipHitsBoat`, `hitBoat`, `killBoat`,
`updateShipVisual`, `leadTarget`, `enemyBolt`, `updateHazards`, `startTutorial`,
`endTutorial` and `hitCargo`. So are `world.js`, `post.js`, `input.js`, `ship.js`, the
terrain wall profile and every `FOG_*` constant. Changed protected functions:
- `aimTarget`: the underwater boat-belly cone (`uw && kind === 'boat' ? AIM_UW_BOAT : …`).
  This is the approved underwater cannon assist; surface aiming is untouched.
- `updateCamera`: the underwater offset terms (`uwCamBack() * uwk`, `UW_CAM_UP * uwk`,
  `UW_CAM_LOOK * uwk`, the `G.uwCam` blend). This is the approved underwater camera
  offset. All terms sit in `under ?` branches, and the blend is 0 above water.
- `updateTutorial`: one line arms the round-12 torpedo cue on the dive (the tutorial
  update feature). The slow-mo maths is unchanged.
- `damage`: one stats counter (`G.dmgTaken`, used for the balance report). The damage
  model is unchanged.

For each of these four, the script removes exactly those lines and terms and then
requires byte identity with `6cf69a9`, so nothing else in them changed.

**Debug hooks.** `__lethe.state()` adds:
- `torpedo` {lock, target, lockT, dist, fired, hits, kills, scuttled, inFlight, bracket,
  cue, cueSeen, rocketPulse};
- `punish` {tele, bursts, dodgedDive, hits, dmg, active};
- `fog` {density, color}, `uwCam`, `camUnder` and `dmgTaken`.

`__lethe.debug` adds `torpedoes()`, `torpLog()`, `torpCand()`, `fireTorpedo()`,
`punishLog()`, `fogConsts()`, `underFX()` and `camOffset()`. `spawnBoat` also resets
the punish state.

**Tests.** `_test/r12.mjs` (`skipRun` skips the delivery, `skipShots` skips the shots)
passes **41/41** (`_test/r12.log`). It checks:
- the fog constants against `6cf69a9` (source) and the runtime underwater fog;
- the lock at 231 m with a level nose, the bracket text and pulse, no lock at 268 m, a
  lock at ~50° off the nose and none at ~80°;
- submerged `[R]` → torpedo: one round of ammo, the rocket's dip, a run just below the
  surface, and one torpedo killing a smuggler;
- the patrol boat at 50% after one torpedo (HP bar `scaleX(0.5)`) and sunk by the second;
- the untargeted torpedo running straight and scuttling after ~3 s;
- the cannon assist locking a belly 22° off the nose and hitting it, with none at 38°;
- the under-FX, wash and dark hull underwater, and all of them off on the surface;
- the surface rocket (same lock target and turret result as the `6cf69a9` build, served
  side by side from an extracted copy in `variants/_r12base`, untracked);
- the surface camera distance equal to `6cf69a9` (31.75 vs 31.73 m);
- the underwater camera now above the ship (+0.4 m vs −3.2 m) and further back
  (26.3 vs 19.6 m at a narrow spot);
- punish: triggered at 38 m, telegraphed 0.65 s, 5/5 hits for 120 damage, cargo stays
  well above 0, dive → `dodged: 'dive'` with 0 shots, jink → 5 shots and 0 hits;
- tutorial: the new text and diagram, desktop `[E]` then `[R]`, touch DIVE pulse first,
  then the ROCKET ring once submerged with a lock, ending when the torpedo fires;
- the hint toast text;
- the full autopilot delivery, using a torpedo;
- zero console errors.

Old suites, all unchanged and passing (`_test/r12_old_*.log`): r6 **13/13**, r7
**20/20**, r8 **8/8**, r9 **16/16**, r10 **17/17**, r11 **34/34** (each delivered under
autopilot). No old test needed changing: the r11 tutorial assertions still hold,
because the big prompt still hides on the dive and step 2 is the ROCKET pulse.

**Balance** (full autopilot, low tier, `_test/r12_balance.mjs` → `_test/r12_balance.log`;
the last two lines are the comparable pair, `dmgTaken` counted the same way in both):

| | outcome | time | cargo | kills (air) | boats sunk | mines / hunters | damage taken | torpedoes |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| before (`6cf69a9`) | delivered | 117.9 s | 90.2% | 6 | 0 / 4 | 0 / 1 | 84.8 | — |
| after (round 12) | delivered | 128.4 s | 91.3% | 6 | **3 / 4** | 1 / 2 | **59.7** | 1 fired, 1 kill |

The autopilot now dives under every boat it meets. It takes ~10 s longer because it is
slower underwater, sinks 3 of 4 boats (one by torpedo, two by the belly assist), never
draws a punish burst, and takes less damage (it spends less time on the surface in front
of the patrol guns). Most rockets still go to turrets earlier in the run, so only one
torpedo is left by the boats.

Shots:
- `shots/r12_torpedo_lock.png`: from below, the dark patrol hull against the lit surface,
  caustic ripples, prop-wash bubbles, the pulsing weak spot and the TORPEDO LOCK bracket
  with the HP bar.
- `shots/r12_torpedo_hit.png`: the bubble trail from the ship to a smuggler, and the
  blast at its belly.
- `shots/r12_underwater.png`: the gameplay camera underwater (raised and pulled back).
  The murk is unchanged and the boat reads as a silhouette beside the ship.
- `shots/r12_punish.png`: side view of the telegraph laser from the patrol boat's gun
  onto the skimming ship, with the red alert bracket.
- `shots/r12_tutorial_touch.png`: 915×412, after the dive. ROCKET pulses with its ring,
  with the lock bracket at 187 m.

Performance (medium, 915×412 touch, `_test/r8_perf.mjs`, `_test/r8_perf.log`):

| Sample | Avg frame | Draw calls |
|---|---:|---:|
| `r12_before` (2 runs) | 113.67 / 121.03 ms | 108 |
| `r12_after` (2 runs) | 107.58 / 107.39 ms | 109 |

`r12_after` is within the +10% budget, even against the faster `r12_before` run (−5.4%).
The new meshes add 1 draw call on average (2 while underwater). Note that the autopilot
now spends part of the sample underwater (it dives under the first boat), where the sky
and shafts are not drawn. Treat the speed-up as "no regression" rather than a gain.

**Known limits.**
- The ship rides only ~2.4 m under the surface and the murk is kept, so a boat dead
  ahead still sits just above or behind the ship on screen, and beyond ~60 m it fades
  out. The lock bracket and the 260 m underwater boat brackets carry long-range
  readability.
- The torpedo ignores mines and hunters on its run (by design, so a lock stays
  reliable).

## Round 14 — slower underwater flight, readable boat wrecks

Phone feedback: a dive-and-shot at a river boat overshot before the hit could be read, and a kill looked like a box breaking apart.

**Underwater speed** (`updateFlight`, only when `G.underwater`). Air cruise stays **62 m/s** (boost **+32**, lateral **30**). The dive plunge, while still above the water, still targets **34 m/s** and lateral **15**, with the same vertical entry (−20 m/s down to −2 m). Once the hull is under (y < −0.6), drag pulls forward speed to **20 m/s** (about a third of air cruise) with a firmer rate (`UW_DRAG` 2.6, so entry speed bleeds in the first second) and lateral speed to **11 m/s** (response 3 vs 5 in air). Surfacing uses the old air accel again. Torpedo lock, belly aim assist, overfly punish, cyan drone pings, fog density and drone/turret/relay numbers are unchanged.

**Boat death** (`killBoat`, `drawSinkingBoat`). A kill no longer calls `explode()` (that spray of icosahedron chunks was the "box"). The breach is fire and a rising bubble column on the belly, a surface splash, and a procedural groan (`audio.boatSink`). Bow and stern stay the existing hull halves. For about two seconds the break opens against the bright surface (list, a kink, stern slightly down, a small belly wound — not a slab). Then the whole lit wreck drops ~7 m, with bow and stern lamps, gunwale points, a fracture seam and a point light so it stays a silhouette in the murk. The surface Snell patch fades as the hull leaves it. The wreck despawns after `sinkT > 7`, same as before. Fog colour and density are untouched.

## Round 15 — boat scan damp, breach shockwave, hull detail

A live boat is no longer something you can cruise over. It searches the lane with a visible amber scan beam from a few hundred metres out. Once the beam catches the ship it holds, flickering, with **no** speed change yet — that beat is the telegraph (`BOAT SCAN — DIVE` on the HUD, a rising chirp). About half a second later the beam locks, the speed readout turns amber (`ENGINES DAMPED — DIVE`), and air cruise is pulled toward **27 m/s** (38 on the first two, easier boats; 46 while the first-boat tutorial prompt is still up). Boost does not punch through the lock. Lateral response softens. The dive axis does not: pulling down still enters the water at the old rate.

The lock drops the moment you dive, go under, leave the lane (about 245 m ahead, 50 m to the side), or kill the boat. Submerged flight is still the round-14 **20 m/s** drag. With no beam on you, air cruise is still **62** (boost **94**, lateral **30**). Drone pings, turret fire, torpedo lock, belly aim, overfly punish, murk and the sinking wreck are unchanged. Punish fire still answers a surface pass inside ~40 m.

Killing a boat now throws a shockwave: three expanding rings (a wide surface ring, a hot core, an underwater ring on the breach), a harder flash, and a procedural sub punch (`audio.shockWave`). If you are close and underwater the wave adds a light camera shake and a small shove off the hull. It does not replace the round-14 sink.

The hull mesh (still procedural, still the same bow/stern split and the same collision box) has a keel, gunwales, rails, portholes, cabin glass, a rudder, a propeller and a scanner dish, so the wreck reads as a boat from the side and from below.

The two later boats sit over a short mine slalom on the approach (mines moved out of the dense field, so the river still has **36**). The centerline under the hull stays open for the belly shot. The first two boats stay clear so the tutorial dive is still the simple one: see the beam, dive, torpedo.

Sounds are procedural only (`AUDIO_CREDITS.md`). Headless check: `_test/r15.mjs`.
