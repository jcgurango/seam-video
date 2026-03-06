Our next big thing: layouts. This is actually the reason we built the video element the way we did. Compositions can now have positional and sizing parameters, as well as "fit".

```json
{
  "fit": "none",
  "position": "absolute",
  "top": "10px",
  "width": "100%",
  "height": "50px",
  ...composition
}
```

Possible values for fit:
- `none` - Default. Does nothing to the children.
- `fit` - Fits the entire child into the composition, centered.
- `cover` - Covers the composition with the child, centered.
- `center` - Centers the child without scaling it.

The big change here is that compositions, overlays, and clips now have explicit dimensions that they report back to the parent. We've already loaded clip dimensions and set them, we now have to pass that up the tree. We should apply fit using CSS transforms rather than relying on CSS's fitting parameters, this will ensure WYSIWYG when we do more complicated things with it later.

Now you might have also noticed the "position" attribute can be absolute and relative. This just changes the behavior of everything downstream. "position": "relative" with "top": "10px" is different from "position": "absolute" with "top": "0px". In ffmpeg these things will be applied via filters and we have to take care that the result in the preview and the result in the render are the same. Percentage units are understood as percentage of the parent width/height. If scaling/cropping is what we do on the FFMPEG side - that's also what we should do on the preview side.

Again, have a look and let me know of any concerns.