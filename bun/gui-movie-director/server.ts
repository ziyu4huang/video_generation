import { handleRequest } from "./api/routes";

const PORT = 3099;

const server = Bun.serve({
  port: PORT,
  async fetch(req, server) {
    return handleRequest(req, server);
  },
});

console.log(`🎬 Movie Director UI: http://localhost:${server.port}`);
