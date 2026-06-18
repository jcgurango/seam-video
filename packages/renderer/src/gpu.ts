/// <reference types="@webgpu/types" />
/**
 * Dawn (headless WebGPU) device creation for Node.
 *
 * Critical: the Dawn **instance** returned by `create()` owns the event
 * processing that resolves async work (`mapAsync`, `onSubmittedWorkDone`). The
 * `webgpu` Node bindings free a wrapper's native object once the JS wrapper is
 * GC'd — so if the instance is left unreferenced, a garbage collection that
 * fires while a submission is in flight destroys the instance and the next
 * device sync point faults on a dangling pointer (EXC_BAD_ACCESS in
 * `pthread_mutex_lock` inside `mapAsync`). We therefore pin the instance at
 * module scope for the lifetime of the process.
 *
 * The WebGPU globals (`GPUBufferUsage`, `GPUTextureUsage`, `GPUMapMode`, …) are
 * installed onto `globalThis` here too, since the compositor and backend
 * reference them as ambient globals.
 */
import { create, globals } from "webgpu";

// Module-scope GC root — never collected for the life of the process.
let instance: ReturnType<typeof create> | null = null;
let globalsInstalled = false;

export async function createGpuDevice(): Promise<GPUDevice> {
  if (!globalsInstalled) {
    Object.assign(globalThis, globals);
    globalsInstalled = true;
  }
  if (!instance) instance = create([]);
  const adapter = await instance.requestAdapter();
  if (!adapter) throw new Error("no WebGPU adapter available from Dawn");
  return adapter.requestDevice();
}