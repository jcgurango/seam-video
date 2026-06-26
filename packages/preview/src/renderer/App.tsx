import React, { useState, useEffect } from "react";
import Player from "./components/Player.js";
import type { ResolvedTimeline } from "@seam/core";
import { setMapBasePath } from "./mapBasePath.js";

declare global {
  interface Window {
    seamApi: {
      onTimelineUpdate: (
        cb: (data: { timeline: ResolvedTimeline; basePath: string }) => void
      ) => void;
      onTimelineError: (cb: (errors: string[]) => void) => void;
      getInitialTimeline: () => Promise<{
        timeline: ResolvedTimeline;
        basePath: string;
      } | null>;
    };
  }
}

export default function App() {
  const [timeline, setTimeline] = useState<ResolvedTimeline | null>(null);
  const [basePath, setBasePath] = useState<string>("");
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    window.seamApi.getInitialTimeline().then((data) => {
      if (data) {
        // Update the module-level map basePath before the timeline state so the
        // boot-registered pmtiles resolver sees it on the first map render.
        setMapBasePath(data.basePath);
        setTimeline(data.timeline);
        setBasePath(data.basePath);
        setErrors([]);
      }
    });

    window.seamApi.onTimelineUpdate((data) => {
      setMapBasePath(data.basePath);
      setTimeline(data.timeline);
      setBasePath(data.basePath);
      setErrors([]);
    });

    window.seamApi.onTimelineError((errs) => {
      setErrors(errs);
    });
  }, []);

  if (errors.length > 0) {
    return (
      <div style={{ padding: 20, color: "#ff6b6b", fontFamily: "monospace" }}>
        <h2>Validation Errors</h2>
        <ul>
          {errors.map((err, i) => (
            <li key={i}>{err}</li>
          ))}
        </ul>
      </div>
    );
  }

  if (!timeline) {
    return (
      <div
        style={{
          padding: 20,
          color: "#999",
          fontFamily: "sans-serif",
          textAlign: "center",
          marginTop: 100,
        }}
      >
        Loading...
      </div>
    );
  }

  return <Player timeline={timeline} basePath={basePath} />;
}
