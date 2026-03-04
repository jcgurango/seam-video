I want to rebuild how the preview works and I think we can take a lot of queues from Remotion, but I want to refine the implementation. At the top level is a timeline context that provides:
- currentTime
- isPlaying
- totalDuration
- functions for controlling playback

A <Timeline /> component will emit a provider, but it will also inside that provider generate a <div />. Our timeline component will be provided an aspect ratio that that div must respect. The div will just size to whatever its container is (width-wise), but the aspect ratio must be respected. To do playback, all we're doing is requestAnimationFrame() and updating currentTime.

Now within that timeline component, we'll render the entire seam data as a series of components, so we're technically reusing ResolvedTimeline as the props. For example, if we have several clips, it'll be:

<ContextProvider>
  <Clip />
  <Clip />
  <Clip />
  <Clip />
</ContextProvider>

What we're passing to these objects is actually a ResolvedClip/ResolvedEmpty/ResolvedComposition as well. But the key here is that all these elements are still going through the React. Every element in the entire data set is constantly rendered *by React*, they just handle their own appearing/disappearing based on currentTime.

Here's how I think compositions should work:
- It's an absolute fill div (top/left/etc. all 0, position: absolute).
- We define a constant "window" variable, say 0.1s.
- What this means is if the composition is going to be on-screen within 0.1s of the current time, it should already be there, ready in the DOM, but with opacity 0. Then we turn it to opacity 1 when it's time to be visible.
- This exposes a secondary context provider that recomputes currentTime in *composition time* rather than in absolute time. This matches our resolution data model.

Here's how I think clips should work:
- We wrap this in a <Composition /> element and pass our timelineStart and timelineEnd to inherit the absolute fill and opacity behavior.
- In that, we render a <video /> which is also absolute fill - this will mirror our pillar/letterboxing behavior in ffmpeg.
- Two flows:
  - When currentTime reaches us and isPlaying = true and the video isn't already playing, we play().
  - When scrubbing, currentTime should just be constantly updating. It's not that big of a deal.
- We have to be conscious of isPlaying here - we're syncing two state machines. We can't be constantly overwriting currentTime on the video element with every frame. It should just be a play() during playback and a hard pause() if isPlaying ever becomes false. Scrubbing is where it would just be doing that constant overwrite, but that's okay for that use case.

Silence is just silence, it doesn't need its own component.

Then a separate <TransportControls /> component that can go to the start/end/play/pause and scrub just by hitting the context.

Do you get the vision? Let me know of any concerns before we proceed.
