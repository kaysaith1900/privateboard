# Hero 3D poster · capture SOP

The homepage hero (`public/home.html`) paints with a static poster
image first (`home-3d-poster.webp` + `home-3d-poster.jpg` fallback),
then `home-3d-loader.js` lazy-mounts the live Three.js scene over
the top. Until the poster files exist the page falls back to a dark
panel (img `onerror` hides the broken-image icon); the 3D scene
still mounts and replaces the panel in ~500 ms on capable browsers.

This file documents how to generate the two poster image files
from the real running 3D scene so the static-paint state matches
what the visitor sees once the canvas mounts.

## One-time capture (~5 minutes)

1. Boot the app locally and open any voice room. If you're not in
   one, run `npm run dev` and click "Convene a Room" → pick any
   directors → enter voice mode.

2. Switch the room's tone to **brainstorm** (matches the marketing
   scene · red-brick walls + moss + green floor + potted plants
   read warm against the homepage's dark theme).
   Settings → tone → brainstorm, OR set
   `currentRoom.mode = "brainstorm"` via DevTools.

3. Enable the 3D round-table view if not already on:
   `localStorage.setItem("boardroom.stage3d", "on")` then reload.

4. Adjust the orbit camera to the marketing angle · pan / zoom
   until the table fills the frame with chairs visible around
   all sides. Default load lands you at a good 30° elevation;
   small tweaks to taste.

5. Snapshot the canvas via DevTools console:
   ```js
   (() => {
     const c = document.querySelector(".roundtable-stage canvas");
     const a = document.createElement("a");
     a.href = c.toDataURL("image/png");
     a.download = "home-3d-poster.png";
     a.click();
   })();
   ```
   Saves a PNG to your downloads folder.

6. Convert to WebP + JPEG fallback at 1280×540 (21:9 cinematic
   letterbox to match `.hero-3d`'s aspect-ratio), quality ~82:
   ```sh
   cd ~/Downloads
   # Crop top + bottom dead space first so 1280×540 keeps the
   # table + chairs centred. ImageMagick auto-centre crop:
   magick home-3d-poster.png -resize 1280 -gravity center \
     -crop 1280x540+0+0 +repage home-3d-poster-cropped.png
   # WebP · primary (~35-55 KB at 21:9)
   cwebp -q 82 -mt -af \
     home-3d-poster-cropped.png -o home-3d-poster.webp
   # JPEG · fallback for older Safari / no-WebP browsers (~50-80 KB)
   magick home-3d-poster-cropped.png -quality 84 home-3d-poster.jpg
   ```

   If you don't have `cwebp` / `magick`:
   - `brew install webp imagemagick` on macOS
   - Or use `https://squoosh.app` (drop the PNG, choose WebP +
     JPEG, save both at quality ~82).

7. Drop both files into `public/`:
   ```sh
   mv ~/Downloads/home-3d-poster.webp ~/Code/multi-agents/boardroom/public/
   mv ~/Downloads/home-3d-poster.jpg  ~/Code/multi-agents/boardroom/public/
   ```

8. Commit + push to trigger Netlify rebuild. Visitors will see the
   real poster on the next deploy.

## Target weights

| File | Target | Notes |
|---|---|---|
| `home-3d-poster.webp` | 30–55 KB | Primary · served to ~96% of modern browsers |
| `home-3d-poster.jpg`  | 50–80 KB | Fallback for old Safari / no-WebP browsers |

If either file lands > 100 KB:
- Drop quality to 75 (`cwebp -q 75`)
- Reduce dimensions to 960×405 (still looks crisp at 21:9)
- Crop tighter to the table center

## Re-capture triggers

Re-shoot the poster when any of these change in `voice-3d.js`:
- Wall palette (tone-keyed colors)
- Table or chair voxel geometry
- Camera FOV / default angle
- Lighting setup (key / fill / ambient hex values)
- Default `mode` displayed on the homepage (set in `home-3d-mock.js`)

Otherwise the poster is good indefinitely — the 3D scene is
deterministic for the same inputs.
