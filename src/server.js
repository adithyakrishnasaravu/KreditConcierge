import "dotenv/config";
import crypto from "crypto";
import express from "express";
import path from "path";

import {
  escalateToHuman,
  flagTransaction,
  listCustomerCards,
  listCustomerTransactions,
  openBillingDispute,
  reportFraudAlert,
  requestFeeWaiver,
  verifyCustomer
} from "./lib/actions.js";
import { processVoiceChain, synthesizeSpeech, transcribeAudio } from "./lib/hathora.js";
import {
  callHandling,
  finalResolutionSummary,
  voiceIntake
} from "./lib/resolution-flow.js";
import { getCustomerById } from "./lib/store.js";
import { createCall, getCallStatus } from "./lib/vapi.js";
import { handleVapiWebhook } from "./lib/vapi-webhook.js";

const app = express();
const port = Number(process.env.PORT || 3000);
const publicDir = path.resolve(process.cwd(), "public");

app.use(express.json({ limit: "4mb" }));
app.use(express.static(publicDir));

function checkWebhookSignature(req, res, next) {
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (!expected) return next();

  const incoming = req.header("x-vapi-secret");
  if (incoming !== expected) {
    return res.status(401).json({ error: "Unauthorized webhook" });
  }

  next();
}

function asyncRoute(handler) {
  return async (req, res) => {
    try {
      const data = await handler(req);
      return res.json({ ok: true, data });
    } catch (error) {
      console.error("[asyncRoute] ERROR:", error instanceof Error ? error.stack : error);
      return res.status(400).json({
        ok: false,
        error: error instanceof Error ? error.message : "Unknown error"
      });
    }
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "credit-card-voice-agent",
    timestamp: new Date().toISOString()
  });
});

app.post(
  "/api/tools/verify-customer",
  checkWebhookSignature,
  asyncRoute((req) => verifyCustomer(req.body))
);

app.post(
  "/api/tools/list-cards",
  asyncRoute((req) => listCustomerCards(req.body))
);

app.post(
  "/api/tools/list-transactions",
  checkWebhookSignature,
  asyncRoute((req) => listCustomerTransactions(req.body))
);

app.post(
  "/api/tools/flag-transaction",
  checkWebhookSignature,
  asyncRoute((req) => flagTransaction(req.body))
);

app.post(
  "/api/tools/request-fee-waiver",
  checkWebhookSignature,
  asyncRoute((req) => requestFeeWaiver(req.body))
);

app.post(
  "/api/tools/report-fraud-alert",
  checkWebhookSignature,
  asyncRoute((req) => reportFraudAlert(req.body))
);

app.post(
  "/api/tools/open-billing-dispute",
  checkWebhookSignature,
  asyncRoute((req) => openBillingDispute(req.body))
);

app.post(
  "/api/tools/escalate-to-human",
  checkWebhookSignature,
  asyncRoute((req) => escalateToHuman(req.body))
);

app.post(
  "/api/agent/voice-intake",
  checkWebhookSignature,
  asyncRoute((req) => voiceIntake(req.body))
);

app.post(
  "/api/agent/call-handling",
  checkWebhookSignature,
  asyncRoute((req) => callHandling(req.body))
);

app.post(
  "/api/agent/final-summary",
  checkWebhookSignature,
  asyncRoute((req) => finalResolutionSummary(req.body))
);

app.post(
  "/api/agent/test-call",
  asyncRoute(async (req) => {
    console.log("\n========== /api/agent/test-call ==========");
    console.log("[test-call] Body keys:", Object.keys(req.body));
    console.log("[test-call] customerId:", req.body.customerId);
    console.log("[test-call] cardLast4:", req.body.cardLast4);
    console.log("[test-call] callToNumber:", req.body.callToNumber || "NOT PROVIDED");
    console.log("[test-call] transcript:", req.body.transcript ? `"${req.body.transcript.slice(0, 80)}"` : "NOT PROVIDED");
    console.log("[test-call] audioBase64:", req.body.audioBase64 ? `YES (${(req.body.audioBase64.length * 0.75 / 1024).toFixed(1)} KB)` : "NOT PROVIDED");
    console.log("[test-call] mimeType:", req.body.mimeType || "NOT PROVIDED");

    const intake = await voiceIntake(req.body);
    console.log("[test-call] voiceIntake done. issueType:", intake.issueType, "sttUsed:", intake.sttUsed);

    const handled = await callHandling({ sessionId: intake.sessionId });
    console.log("[test-call] callHandling done. status:", handled.status);

    const summary = await finalResolutionSummary({ sessionId: intake.sessionId });
    console.log("[test-call] summary done.");

    let call = null;
    if (req.body.callToNumber) {
      const assistantId = process.env.VAPI_ASSISTANT_ID;
      if (!assistantId) throw new Error("Missing VAPI_ASSISTANT_ID in .env");

      const customer = await getCustomerById(intake.customerId);
      const card = customer?.cards?.find(c => c.last4 === intake.cardLast4);
      const fullNumber = card?.fullNumber || `ending in ${intake.cardLast4}`;

      const resolutionBrief = [
        `Hello, I'm calling on behalf of ${summary.customerName || "our customer"}.`,
        `Issue type: ${intake.issueType?.replace("_", " ")}.`,
        `The customer's full card number is ${fullNumber}.`,
        `The customer's name is ${summary.customerName}. Last 4 of SSN: ${customer?.last4Ssn || "on file"}.`,
        `Customer reported: "${intake.transcript}".`,
        summary.summary
      ].join(" ");

      call = await createCall({
        assistantId,
        customerNumber: req.body.callToNumber,
        phoneNumberId: process.env.VAPI_OUTBOUND_PHONE_NUMBER_ID || undefined,
        assistantOverrides: {
          firstMessage: resolutionBrief
        },
        metadata: {
          sessionId: intake.sessionId,
          issueType: intake.issueType,
          customerId: intake.customerId,
          cardLast4: intake.cardLast4
        }
      });
    }

    console.log("[test-call] === COMPLETE ===");
    console.log("[test-call]   call placed:", call ? `YES (id: ${call.id})` : "NO (no callToNumber)");
    console.log("==========================================\n");

    return {
      intake,
      handled,
      summary,
      call
    };
  })
);

app.get(
  "/api/agent/call-status/:callId",
  asyncRoute((req) => getCallStatus(req.params.callId))
);

app.post(
  "/api/voice/transcribe",
  asyncRoute((req) =>
    transcribeAudio({ audioBase64: req.body.audioBase64, mimeType: req.body.mimeType })
  )
);

app.post(
  "/api/voice/synthesize",
  asyncRoute((req) => synthesizeSpeech({ text: req.body.text, voice: req.body.voice }))
);

app.post(
  "/api/voice/chain",
  asyncRoute((req) =>
    processVoiceChain({
      audioBase64: req.body.audioBase64,
      mimeType: req.body.mimeType,
      sessionId: req.body.sessionId,
      enableConversationHistory: req.body.enableConversationHistory
    })
  )
);

app.post(
  "/api/vapi/webhook",
  checkWebhookSignature,
  asyncRoute((req) => handleVapiWebhook(req.body))
);

app.post("/api/demo/call-summary", asyncRoute((req) => {
  const id = `sum_${crypto.randomUUID().slice(0, 8)}`;
  return {
    summaryId: id,
    customerId: req.body.customerId || process.env.DEFAULT_CUSTOMER_ID || "cust_001",
    issueType: req.body.issueType || "unknown",
    outcome: req.body.outcome || "pending",
    nextStep: req.body.nextStep || "Follow-up in 48 hours"
  };
}));

// Local dev: listen on port. Vercel: export the app.
if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
  });
}

export default app;
