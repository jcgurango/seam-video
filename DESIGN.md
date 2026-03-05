The next thing I'd like to implement is overlays. Overlays are defined like this:

```json
{
  "type": "overlay",
  "children": [
    { ... },
    { ... },
    { ... },
  ],
  "duration": 10,
  "alignItems": "center"
}
```

I notice clips and compositions actually share a lot of the same fields. I think it would be worth it to move these:
- in: number;
- out: number;
- flex?: number;
- overflow: Overflow;
- underflow?: Underflow;

To a generic properties interface since overlays are also gonna have these as well.

So what is an overlay? It essentially puts each child on top of the other. Third over second over first, so the order you define them is from base -> top.

- Duration is optional
- alignItems is the interesting thing. We take the longest duration thing in the children, then with the other children:
  - "start" will put those children at the start
  - "end" will put the ends of those children at the end
  - "center" will try to center those children instead
