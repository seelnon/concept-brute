Fast, dirty, artistic.

Procedural Color Palette derived from initial 6
OKLCH OKLAB CMYK RYB RGB color spaces
Pigment (Blue + Yellow = Green)
Editing of colors are also supports those color spaces allowing better manipulation of channels
Color wheel harmonies that could be explored in the 'Lab' (also color icon on the top right of the Color Palette)

Hue/Value sliders based on speed of a stroke making it possible to extract more color / lightness from one brushstroke, fully controlled by speed of your hand (or anything you use to paint)

Infinite canvas with procedurally generated surfaces and grid patterns.

On the spot brush tips edit, generation. Snapping part of the canvas to immediately use it as a stamp
Procedural brushes (WIP - procedural settings for brushes, so you can pick fun ones out of nowhere)

Wireframe brush (2) - encloses points to have hatching-like gradient procedurally, creating automatic shading similar to Ambient Occlusion.

Selection (3) - it has interesting pin like deformation with a mesh, but I don't use much selection, just to move a chunk or mirror it.
Selection opacity changer (hold T and drag)... kind of cool, didn't use much tho.

Fast smudge (4) with ability to ignore alpha, so it is possible to generate full value/color strokes out of low opacity: can lead to fun results

Liquify (6, G) - very fast, acts as a brush, non destructive.

Per Stroke Recording (Waits for 'N'-amount of strokes to record 1 frame, so timelapces are always well paced. It ignores undo, so it waits until a pool of 'n'-strokes is fulfilled before recording a frame)

Inactive canvas saving (if you are in the zone, it doesn't run autosave and waits for you to be chill of n-amount seconds)

IndexDB (local saving into your browser database)

---

Navier Stokes fluid simulations and shaders:

Fluid Paint (F, 7) - somewhat derived from 'Fluid Paint by david li' - has oil feel with impasto that is 'arcad-y' in feel. It doesn't have physical simulations.

Air / Watercolor brush (A, 8) - crude implementation of watercolors that are fast and 'arcad-y' in feel. Could be used to blur things in a fun way.

Sumi-E Ink (9, Q, Shift + [1,2,3,4,5] ) - full simulation of ink, bristles, wetness, absorption into pores, fiber resistance, ink depletion, granulation, ink specks.
Subtools support ink - water - blow - dry - erase

Ability to create a canvas from an image. (includes auto generation of heightmap - albedo - pores)
Physical tools (7 8 9) support interaction with height maps, grain channeling, grip/slip of a surface.
Sumi supports 'pores' of surfaces, so it is simulated on multiple layers.

---

Tools work in tandem and fill specific roles. During painting the only tool that I don't really use is actually eraser / selections. It is much more fun to stack brushstrokes on top of each other.
There is no height map layer for 'impasto' so actual shine you get from brushes is possible to just erase or 'color pick'

Limitations that I consider good:

3 layers only... because yes... it is just 'yes'... builds character, trust.
no multiply/overlay/add/screen... because do it yourself *I added robust color correction per layer, should be fine... even though I didn't want, but having it in OKLCH space was a treat*
limited 'undo' history... because yes... own your mistakes... builds character, trust.
no ability to upload image as layer, because... it's not photoshop... paint...
recording checks your image ref, so no cheating for tracing. *tracing is not a big deal, saves time when you want to practice painting and just need a 'volume' or you have to have 1 to 1 proportions*
no much crazy brush tunning / settings. No cloud brushes - paint it by hand. Or draw your own cloud first, stamp it from canvas... No brush import either, make your own tool - makes your work be unique

---

Overall every tool can be used as main one. And all tools could be used well in tandem with one another.

---

Future (WIP)

Sumi needs optimisations... overall optimisations...
More work on Fluid Paint, needs much more tuning.
No more big feature / tools. Idea is that you should be able to take one of the tool and do weird stuff with it by playing with sliders.
Better exports (right now just .png and no settings for it)
Export of a gif directly from the app, so it is easy to share.
Better renderer for .MP4 (takes a while sometimes)
Fixes for things running at the same time to not disrupt workflow. (need a lot of findings, for now it is sumi that needs most attension)
Procedural brushes giving fun generations for settings, so you can get wild brushes out of nowhere.
Better procedural surfaces tunings / settings.
UI adjustments for important sliders to be 'closer' and advanced to be for smaller tunings.
Magic Wand selector + Key selector (selects a color completely)
And some other schizo stuff I will find interesting... but I'm pretty much at the end of things I like about painting and I think tools are distinct enough. So tool updates will be a thing, but no new tools. I shall leave it as a council of 9.
