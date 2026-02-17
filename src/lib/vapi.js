const VAPI_BASE_URL = "https://api.vapi.ai";

function getVapiApiKey() {
  const key = process.env.VAPI_API_KEY;
  if (!key) throw new Error("Missing VAPI_API_KEY");
  return key;
}

export async function createAssistant(assistantPayload) {
  const apiKey = getVapiApiKey();
  const res = await fetch(`${VAPI_BASE_URL}/assistant`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(assistantPayload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create assistant (${res.status}): ${body}`);
  }

  return res.json();
}

export async function updateAssistant(assistantId, assistantPayload) {
  const apiKey = getVapiApiKey();
  const res = await fetch(`${VAPI_BASE_URL}/assistant/${assistantId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(assistantPayload)
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update assistant (${res.status}): ${body}`);
  }

  return res.json();
}

export async function createCall({
  assistantId,
  customerNumber,
  phoneNumberId,
  assistantOverrides,
  metadata
}) {
  const apiKey = getVapiApiKey();

  if (!assistantId) throw new Error("Missing assistantId for call creation");
  if (!customerNumber) throw new Error("Missing customerNumber for call creation");

  const body = {
    assistantId,
    customer: {
      number: customerNumber
    },
    metadata: metadata || {}
  };

  if (phoneNumberId) body.phoneNumberId = phoneNumberId;
  if (assistantOverrides) body.assistantOverrides = assistantOverrides;

  console.log("[Vapi] Creating call...");
  console.log("[Vapi]   assistantId:", assistantId);
  console.log("[Vapi]   customerNumber:", customerNumber);
  console.log("[Vapi]   phoneNumberId:", phoneNumberId || "NOT SET");
  console.log("[Vapi]   firstMessage:", assistantOverrides?.firstMessage?.slice(0, 100) || "none");

  const res = await fetch(`${VAPI_BASE_URL}/call`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const responseText = await res.text();
    console.error(`[Vapi] FAILED to create call (${res.status}):`, responseText);
    throw new Error(`Failed to create call (${res.status}): ${responseText}`);
  }

  const json = await res.json();
  console.log("[Vapi] Call created successfully. ID:", json.id);
  return json;
}

export async function getCallStatus(callId) {
  const apiKey = getVapiApiKey();
  const res = await fetch(`${VAPI_BASE_URL}/call/${callId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get call status (${res.status}): ${body}`);
  }

  return res.json();
}
