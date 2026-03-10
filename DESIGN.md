The next thing I'd like to implement is filters. Filters can be applied on clips or compositions. Now, filters are applied like this:

```
{
  ...clip data,
  "filters": [
    {
      "type": "adjust",
      "brightness": 0,
      "contrast": 1,
      "saturation": 0,
      "gamma": 1
    }
  ]
}
```

And are always evaluated in order.

Here's the filters I'd like to implement:

`adjust` - maps to FFMPEG's "eq". Brightness (-1 - 1), Contrast (-1000 to 1000), Saturation (0 to 3.0, default 1.0), gamma (0.1 - 10.0, default 1.0)
`opacity` - single parameter, 0-1. Maps to FFMPEG's "format=rgba,colorchannelmixer=aa=0.5"
`colorbalance` - FFMPEG colorbalance. rs/gs/bs, rm/gm/bm, rh/gh/bh.
`colortemperature` - FFMPEG colortemperature.

You'll need to think about how these will be applied in the preview.