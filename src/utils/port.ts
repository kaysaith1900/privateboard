/**
 * Find a free local port starting from `base`. We probe by attempting to bind
 * a Node net.Server to 127.0.0.1; the OS only opens the port if it's free.
 */
import { createServer } from "node:net";

export async function findFreePort(base = 3030, maxTries = 20): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = base + i;
    if (await isPortFree(port)) return port;
  }
  throw new Error(`No free port in range ${base}..${base + maxTries - 1}`);
}

function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => {
        tester.close(() => resolve(true));
      })
      .listen(port, "127.0.0.1");
  });
}
