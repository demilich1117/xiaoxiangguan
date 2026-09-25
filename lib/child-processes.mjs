import { spawn } from "node:child_process";

const children = new Set();
let stopping = false;
export function trackChild(child) {
  children.add(child);
  child.once("close", () => children.delete(child));
  child.once("error", () => children.delete(child));
  if (stopping) void killProcessTree(child);
  return child;
}

export function killProcessTree(child) {
  if (!child.pid || child.exitCode !== null) return Promise.resolve();
  if (process.platform === "win32") return new Promise((resolve) => {
    const killer = spawn("taskkill.exe", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.once("error", () => { child.kill(); resolve(); });
    killer.once("close", () => { if (child.exitCode === null) child.kill(); resolve(); });
  });
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  return Promise.resolve();
}

export async function stopChildProcesses() {
  stopping = true;
  await Promise.allSettled([...children].map(killProcessTree));
}
