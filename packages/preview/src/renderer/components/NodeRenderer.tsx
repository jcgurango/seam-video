import React from "react";
import type { ResolvedChild } from "@seam/core";
import Clip from "./Clip.js";
import Composition from "./Composition.js";

interface NodeRendererProps {
  node: ResolvedChild;
}

export default function NodeRenderer({ node }: NodeRendererProps) {
  switch (node.type) {
    case "clip":
      return <Clip clip={node} />;
    case "composition":
      return <Composition composition={node} />;
    case "empty":
      return null;
  }
}
