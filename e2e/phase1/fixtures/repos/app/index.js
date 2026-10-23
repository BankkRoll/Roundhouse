// Sample app deployed by the Phase 1 end-to-end test. The test rewrites
// VERSION between commits, so keep it on its own line.
const http = require("node:http");

const VERSION = "v1";
const port = Number(process.env.PORT || 3000);

const server = http.createServer(async (req, res) => {
  console.log(`request ${req.method} ${req.url} token=${process.env.API_TOKEN ?? ""}`);
  if (req.url === "/health") {
    res.end("ok\n");
    return;
  }
  if (req.url === "/peer") {
    try {
      const peer = await fetch(process.env.PEER_URL, { signal: AbortSignal.timeout(5000) });
      res.end(await peer.text());
    } catch (err) {
      res.statusCode = 502;
      res.end(`peer unreachable: ${err.message}\n`);
    }
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify({
      version: VERSION,
      greeting: process.env.GREETING ?? null,
      deployment_id: process.env.ROUNDHOUSE_DEPLOYMENT_ID ?? null,
    }),
  );
});

server.listen(port, () => console.log(`listening on ${port} (${VERSION})`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
