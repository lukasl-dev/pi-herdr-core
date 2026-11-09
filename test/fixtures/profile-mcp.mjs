import { createInterface } from "node:readline";

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  let result;
  switch (request.method) {
    case "initialize":
      result = {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "profile-fixture", version: "1" },
      };
      break;
    case "tools/list":
      result = {
        tools: [
          { name: "echo", inputSchema: { type: "object", properties: {} } },
        ],
      };
      break;
    case "tools/call":
      result = { content: [{ type: "text", text: "Profile MCP works" }] };
      break;
    default:
      result = {};
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
});
