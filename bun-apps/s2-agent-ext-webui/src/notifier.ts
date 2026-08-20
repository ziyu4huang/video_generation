import type { Frontend } from "./mutex.js";
import type { MutexNotifier } from "./mutex-controller.js";
import type { Broadcaster } from "./broadcaster.js";

/** MutexNotifier that surfaces block / force-release as WS frames through a Broadcaster. */
export class BroadcastingNotifier implements MutexNotifier {
  constructor(private readonly broadcaster: Broadcaster) {}
  notifyBlocked(blocked: Frontend, by: Frontend): void {
    this.broadcaster.broadcast({ type: "mutex_blocked", blocked, by });
  }
  notifyForceRelease(driver: Frontend): void {
    this.broadcaster.broadcast({ type: "mutex_force_release", driver });
  }
}
