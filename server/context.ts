import type { Store } from "./store";

export type AppContext = {
  store: Store;
  /** Pushes a message to every authenticated realtime client. */
  broadcast: (payload: unknown) => void;
};
