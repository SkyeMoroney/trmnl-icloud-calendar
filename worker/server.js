import { createServer } from "node:http";
import handler from "./src/index.js";

const port = process.env.PORT || 8787;

createServer(async (req, res) => {
  const url = `http://${req.headers.host || `localhost:${port}`}${req.url}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const chunks = hasBody ? [] : null;
  if (hasBody) for await (const chunk of req) chunks.push(chunk);

  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });

  const response = await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(port, () => {
  console.log(`iCloud calendar backend listening on http://localhost:${port}`);
});
