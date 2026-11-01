import { serviceError } from "./inputs.js";

/** Block new data-plane admissions while existing dispatches drain. The admin endpoint stays responsive. */
export function requestGate(current) {
  let paused = false,
    readers = 0,
    notify;
  function get() {
    return paused ? null : current();
  }
  get.acquire = () => {
    const session = get();
    if (!session) return null;
    readers++;
    let released = false;
    return {
      session,
      release() {
        if (released) return;
        released = true;
        if (--readers === 0) notify?.();
      },
    };
  };
  get.pause = async () => {
    paused = true;
    if (!readers) return;
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(serviceError("BUSY")), 15000);
        notify = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    } catch (e) {
      paused = false;
      throw e;
    } finally {
      notify = undefined;
    }
  };
  get.resume = () => {
    paused = false;
  };
  return get;
}
