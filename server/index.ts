import http from "node:http";
import { WebSocketServer } from "ws";
import { createApp } from "./app";
import type { AppContext } from "./context";
import { startBackgroundJobs } from "./jobs";
import { sessionUser } from "./routes/account";
import { Store } from "./store";

const port = Number(process.env.PORT ?? 4077);
const store = new Store();

const realtimeClients = new Set<import("ws").WebSocket>();
const context: AppContext = {
  store,
  broadcast(payload) {
    const message = JSON.stringify(payload);
    for (const client of realtimeClients) if (client.readyState === client.OPEN) client.send(message);
  }
};

const server = http.createServer(createApp(context));
const realtime = new WebSocketServer({ server, path: "/api/realtime" });

realtime.on("connection", (socket, request) => {
  const url = new URL(request.url ?? "/api/realtime", "http://localhost");
  if (!sessionUser(store.read(), url.searchParams.get("token") ?? "")) {
    socket.close(1008, "auth required");
    return;
  }
  realtimeClients.add(socket);
  socket.on("close", () => realtimeClients.delete(socket));
});

const stopJobs = process.env.DISABLE_BACKGROUND_JOBS === "true" ? () => undefined : startBackgroundJobs(store);

server.listen(port, () => {
  console.log(`VPN Payment Control: http://localhost:${port}`);
});

function shutdown() {
  stopJobs();
  realtime.close();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
