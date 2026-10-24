# Audio credits — LETHE / ЛЕТА "Delivery" (variant `claude`)

**All sound in this build is procedural.** There are no audio sample files, no recordings and no third-party
sound assets: every sound is synthesised at runtime with the Web Audio API in `src/audio.js`
(oscillators, a generated white-noise buffer, biquad filters, a wave-shaper, a delay-feedback slap echo,
a `ConvolverNode` fed with a procedurally generated canyon impulse response, stereo panners and compressors).

Nothing was copied, sampled or traced from any existing game, film or library. The energy-cannon signature
("glassy crack + bright chirp + tight sub thump + canyon slap echo") and all other sounds were designed for
this prototype.

| Sound | Synthesis |
|---|---|
| Energy cannon | high-passed noise crack (≈1 ms attack) + band-passed sizzle + 1750→520 Hz sine chirp + 880→330 Hz square tick + 122→44 Hz sine thump + 64→36 Hz triangle body; ±7 % random pitch/filter per shot; twin cannons alternate L/R; reverb + slap-echo sends |
| Rocket launch | 95→30 Hz sine thump, 55 Hz triangle tail, low-pass noise whoosh sweeping 260→2600 Hz, band-passed hiss, crackle ticks |
| Explosions | noise crack, driven band-pass mid crunch, low-pass rumble, 90→24 Hz sub sweep, randomised debris rattles, panned by position |
| Engine (3 presets) | own bus → 2× 170 Hz high-pass (24 dB/oct) → soft low-pass → duck. **Jet whisper**: band-passed + high-passed noise air, faint detuned 2.1–3 kHz sine whine with vibrato. **Turbine**: sine fundamental 430–1300 Hz + soft triangle 2nd harmonic through a tracking band-pass, narrow band-passed blade noise. **Ion hum**: open-fifth sine/triangle stack ≈205–265 Hz with slow chorus, tremolo-modulated 8×/12× sine shimmer. Boost adds a band-passed air rush; wall/arch proximity swells level and cutoff; the bus ducks under shots, rockets, explosions and hits |
| Hit marker | 2.9 kHz square tick + 4.2 kHz sine tick on the UI bus, followed by the score chime |
| Water | low-pass noise rush scaled by altitude, high-pass spray when skimming, splash bursts on dive/surface, underwater low-pass + bubbles |
| Shield | hit: bright sine zing + band-passed noise + resonant 174/261 Hz hum bed; regen: soft rising dual sine; down: noise crack + falling saw |
| LETHE | lock ticks rising in pitch and rate with the MARK, lock tone, targeting-laser buzz, turret launch whoosh + thump, drone whine (saw/square, vibrato, doppler pitch, stereo pan), spotter mark ping (short cold sine, one tick per cyan beam) |
| Spotter mark ping | sine tick ≈1860 Hz (second tap of the pair ≈2280 Hz), both rising ~260 Hz as MARK fills; 36 ms decay, light level, stereo pan toward the drone, small canyon reverb. No sample files |
| Boat sink | falling sawtooth groan ≈130→36 Hz, triangle body ≈78→26 Hz, low-pass flooding hiss 820→110 Hz, eight short sine bubble ticks; panned to the hull, canyon reverb. No sample files |
| Boat scan | catch: sine 520→860 Hz plus triangle 1040→1480 Hz; lock: sawtooth 180→90 Hz, square 410→260 Hz, band-passed noise 880→220 Hz; hold tick: sine 760→700 Hz on the UI bus. While the beam holds, the engine low-pass closes (same presets, duller). No sample files |
| Boat shockwave | sine sub 46→20 Hz, triangle 70→28 Hz, low-pass noise 480→70 Hz under the breach. No sample files |
| Hazards / UI | two-tone mast-down alarm, geiger clicks (density by dose), air beeps, score chime |

License: same as the rest of this prototype's code (original work).
