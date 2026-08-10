const http = require("http");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

if (!WEBHOOK_SECRET) {
  console.error("WEBHOOK_SECRET is not configured.");
  process.exit(1);
}

function verifySignature(payload, signature) {
  if (!signature) return false;

  const expected = `sha256=${crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(payload)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => {
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  try {
    const rawBody = await readBody(req);

    const signature = req.headers["x-hub-signature-256"];

    if (!verifySignature(rawBody, signature)) {
      console.warn("Invalid webhook signature.");

      res.writeHead(401);
      res.end("Invalid signature");
      return;
    }

    const event = req.headers["x-github-event"];

    console.log(`Received GitHub event: ${event}`);

    const payload = JSON.parse(rawBody.toString("utf8"));

    console.log("Webhook received:", {
      event,
      action: payload.action,
    });

    // We only care about GitHub Projects V2 item events.
    if (event !== "projects_v2_item") {
      res.writeHead(200);
      res.end("Event ignored");
      return;
    }

    console.log("Project item changed.");

    /*
     * TODO:
     * Trigger the existing GitHub Actions sync workflow here.
     */

    res.writeHead(200);
    res.end("Webhook received");
  } catch (error) {
    console.error("Webhook processing failed:", error);

    res.writeHead(500);
    res.end("Internal server error");
  }
});

server.listen(PORT, () => {
  console.log(`Webhook server listening on port ${PORT}`);
});
