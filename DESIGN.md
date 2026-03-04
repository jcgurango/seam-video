We are building a new video editing experience lovingly called "Seam Video." The philosophy is simple: video is inherently a flowing art. Ripple editing and absolute timecodes are byproducts of digitization that we no longer need. Let me lay out what V1 should look like:
- There are two components
  - An editor - React-based, Electron. For V1 I just need one component: the preview. Something that takes Seam data and renders it in a web browser so we can preview it.
  - A renderer - MLT-based. This takes Seam data, converts it into something MELT can understand.

Both should be Typescript based and inherit a single data model.

Seam projects are hierarchical and can be nested. The top-level primitive is a *Composition* which defines a sequence. Here's an example of seam data:

```json
{
  "type": "composition",
  "children": [
    {
      "type": "clip",
      "source": "video.mp4",
      "in": 13.4,
      "out": 18.9 // Seconds
    },
    {
      "type": "clip",
      "source": "video.mp4",
      "in": 15.4,
      "out": 16.9 // Seconds
    },
    {
      "type": "empty",
      "duration": 1
    }
  ]
}
```

Notice how all we're really defining here is clips with their in/out. We're not defining specific time-codes. If the clip0 gets longer, or shorter, clip1 moves automatically. Compositions can also be nested within each other:

```json
{
  "type": "composition",
  "children": [
    ...other clips,
    {
      "type": "composition",
      "segments": [
        {
          "type": "clip",
          "source": "video.mp4",
          "in": 13.4,
          "out": 18.9 // Seconds
        },
        {
          "type": "clip",
          "source": "video.mp4",
          "in": 15.4,
          "out": 16.9 // Seconds
        }
      ],
      "in": 12,
      "out": 16.4
    }
  ]
}
```

Which means compositions are technically handled like clips too. They both must define an in/out so we know the duration. The only thing that is allowed to not have an in/out is the top-level composition. Where this gets interesting is in layout. V1 doesn't yet need to support the spatial side, but it does need to support the temporal layout. Our primary unit is seconds, not frames. Let's map this carefully, but we can take many cues from flexboxes here:

```json
{
  "type": "composition",
  "layout": {
    "duration": 30, // The total duration of the composition. This is optional.
    "justify": "start", // How to justify clips within
    "gap": 0 // How much silence to leave between each child
  },
  "children": [
    {
      // Clip or composition data
      "in": 12,
      "out": 16.4,
      "flex": 1, // Optional, but with this we can define that this child should take proportional space relative to other children w/ flex. If we're enforcing a unit, then the child will take unit * flex. This requires a duration to be set.
      "overflow": "trim-end", // Only valid if there's flex.
      "underflow": "extend-center" // Only valid if there's flex.
    }
  ]
}
```

`justify` can take the following values:
- start - Pack clips backward in time, leave silence after
- end - Lead with silence, pack clips forward
- center - split the silence evenly at the start and end
- space-between - equal silence between each clip

`underflow` activates when the target duration of a clip is greater than the in/out specifies. It takes:
- null - default. Does nothing. Puts the clip at the start. Lets silence happen.
- extend-end - Puts the start of the clip at the start, extends "out" to fill the space after
- extend-start - Puts the end of the clip at the end, extends "in" to fill the space before
- extend-center - Puts the center of the clip at the center, extends both "in" and "out"
- stretch - Clip speeds up/slows down to fill the space

`overflow` activates when the target duration of a clip is less than the in/out specifies. It takes:
- trim-end - Puts the start of the clip at the start, shrinks "out" to fill the space after. Technically the default null behavior too.
- trim-start - Puts the end of the clip at the end, shrinks "in" to fill the space before
- trim-center - Puts the center of the clip at the center, shrinks both "in" and "out"
- stretch - Clip speeds up/slows down to fill the space

Feel free to iterate on this and come back to me with any issues and questions. The expected output is two commands:
- preview X (a seam file) - to open an electron window that'll let me preview and live-reload whenever I make changes.
- render X (a seam file) - render to MLT XML.
