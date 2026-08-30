# Design directions

Three typography and layout directions for the driver site, explored before
committing the live site to one. Each artboard is one direction at phone width
(390px), because that is where drivers actually are.

    Main.dc.html      A — Highway.    Overpass + Public Sans. Type as the graphic.
    Dispatch.dc.html  B — Dispatch.   Archivo + IBM Plex Mono. Built like a bill of lading.
    DobleVia.dc.html  C — Doble Vía.  Bricolage Grotesque + Instrument Sans. Spanish leads.
    canvas.json       Layout, and the tradeoff of each written beside it.

These are `.dc.html` — design-canvas artboards, not pages the site serves.
Nothing here is deployed; `drive.html` is still the live site. Once a direction
is picked, it gets built into the real pages and these stay as the record of
what was considered.

Common to all three, and the substance of what was wrong before: no system
fonts, no emoji icons (inline SVG throughout), no gradient hero, no uniform
card grid.
