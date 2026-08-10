const crypto = require("crypto");

function verifySignature(payload, signature, secret) {
  if (!signature || !secret) {
    return false;
  }

  const expected = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;

  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== signatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
}

module.exports = async (req, res) => {
  // GitHub should only send POST requests.
  if (req.method !== "POST") {
    return res.status(405).send("Method not allowed");
  }

  const secret = process.env.WEBHOOK_SECRET;

  if (!secret) {
    console.error("WEBHOOK_SECRET is not configured.");
    return res.status(500).send("Server configuration error");
  }

  try {
    /*
     * Vercel normally parses JSON request bodies for us.
     * GitHub's signature, however, must be calculated from
     * the ORIGINAL request body.
     */
    const rawBody =
      typeof req.body === "string" ? req.body : JSON.stringify(req.body);

    const signature = req.headers["x-hub-signature-256"];

    if (!verifySignature(rawBody, signature, secret)) {
      console.warn("Invalid webhook signature.");
      return res.status(401).send("Invalid signature");
    }

    const event = req.headers["x-github-event"];

    console.log(`Received GitHub event: ${event}`);

    let payload;

    try {
      payload = JSON.parse(rawBody);
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    console.log("Webhook received:", {
      event,
      action: payload.action,
    });

    // We only care about GitHub Projects V2 item events.
    if (event !== "projects_v2_item") {
      return res.status(200).send("Event ignored");
    }

    console.log("Project item changed.");

    const owner = "madayawgas";
    const repo = "madayawgas-automation";
    const workflow = "sync-project.yml";
    const ref = "main";

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ref,
        }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();

      console.error("Failed to trigger GitHub Actions workflow:", {
        status: response.status,
        response: errorText,
      });

      return res.status(500).send("Failed to trigger sync workflow");
    }

    console.log("Sync workflow triggered successfully.");

    return res.status(200).send("Webhook received");
  } catch (error) {
    console.error("Webhook processing failed:", error);
    return res.status(500).send("Internal server error");
  }
};
