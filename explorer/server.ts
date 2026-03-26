import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const RUNS_DIR = path.resolve(".jingu", "runs");
const PUBLIC_DIR = path.resolve("explorer", "public");

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".json": "application/json",
};

const server = http.createServer((req, res) => {
  const url = req.url ?? "/";

  if (url === "/runs") {
    if (!fs.existsSync(RUNS_DIR)) {
      res.setHeader("Content-Type", "application/json");
      return res.end("[]");
    }
    const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith(".json"));
    const runs = files
      .map((f) => {
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(RUNS_DIR, f), "utf-8"),
          );
          return {
            id: data.id,
            state: data.state,
            iterations: (data.history ?? []).length,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify(runs));
  }

  const runMatch = url.match(/^\/run\/(.+)$/);
  if (runMatch) {
    const id = runMatch[1];
    const file = path.join(RUNS_DIR, `${id}.json`);
    if (!fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    }
    res.setHeader("Content-Type", "application/json");
    return res.end(fs.readFileSync(file, "utf-8"));
  }

  // Static files
  let filePath: string;
  if (url === "/") {
    filePath = path.join(PUBLIC_DIR, "index.html");
  } else {
    filePath = path.join(PUBLIC_DIR, url.replace(/^\//, ""));
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.setHeader("Content-Type", MIME[ext] ?? "text/plain");
    return res.end(fs.readFileSync(filePath));
  }

  res.statusCode = 404;
  res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Jingu Explorer running at http://localhost:${PORT}`);
  console.log(`Runs dir: ${RUNS_DIR}`);
});
