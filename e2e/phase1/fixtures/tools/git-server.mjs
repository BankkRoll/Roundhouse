/**
 * Read-only git smart-HTTP server over HTTPS: a minimal CGI bridge to
 * `git http-backend`. The builder only fetches over https://, so plain
 * `git daemon` or http:// would not exercise the real fetch path.
 *
 * Env: GIT_PORT (default 18443), GIT_ROOT (default /srv/git), CERTS (default /certs).
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";

const port = Number(process.env.GIT_PORT ?? 18443);
const root = process.env.GIT_ROOT ?? "/srv/git";
const certs = process.env.CERTS ?? "/certs";

const server = createServer(
  { key: readFileSync(`${certs}/server.key`), cert: readFileSync(`${certs}/server.crt`) },
  (req, res) => {
    const url = new URL(req.url, "https://git.invalid");
    const env = {
      PATH: process.env.PATH,
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: "1",
      REQUEST_METHOD: req.method,
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: req.headers["content-type"] ?? "",
      REMOTE_ADDR: req.socket.remoteAddress ?? "",
      // Protocol v2 is negotiated through this header; without it the
      // backend silently falls back to v0.
      HTTP_GIT_PROTOCOL: req.headers["git-protocol"] ?? "",
      HTTP_CONTENT_ENCODING: req.headers["content-encoding"] ?? "",
    };
    const cgi = spawn("git", ["http-backend"], { env });
    req.pipe(cgi.stdin);
    cgi.stderr.on("data", (d) => process.stderr.write(d));

    let head = Buffer.alloc(0);
    let headersDone = false;
    cgi.stdout.on("data", (chunk) => {
      if (headersDone) {
        res.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const sep = head.indexOf("\r\n\r\n");
      const alt = head.indexOf("\n\n");
      const end = sep !== -1 ? sep : alt;
      if (end === -1) return;
      const skip = sep !== -1 ? 4 : 2;
      headersDone = true;
      let status = 200;
      for (const line of head.subarray(0, end).toString().split(/\r?\n/)) {
        const i = line.indexOf(":");
        if (i === -1) continue;
        const name = line.slice(0, i).trim();
        const value = line.slice(i + 1).trim();
        if (name.toLowerCase() === "status") status = Number.parseInt(value, 10);
        else res.setHeader(name, value);
      }
      res.writeHead(status);
      res.write(head.subarray(end + skip));
    });
    cgi.on("close", (code) => {
      if (!headersDone) {
        res.writeHead(500);
        res.end(`git http-backend exited ${code}\n`);
        return;
      }
      res.end();
    });
    console.log(`${req.method} ${req.url}`);
  },
);

server.listen(port, "127.0.0.1", () => console.log(`git server listening on 127.0.0.1:${port}`));
