import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("seamApi", {
  onTimelineUpdate: (
    callback: (data: { timeline: any; basePath: string }) => void
  ) => {
    ipcRenderer.on("timeline-update", (_event, data) => callback(data));
  },
  onTimelineError: (callback: (errors: string[]) => void) => {
    ipcRenderer.on("timeline-error", (_event, errors) => callback(errors));
  },
  getInitialTimeline: () => ipcRenderer.invoke("get-initial-timeline"),
});
