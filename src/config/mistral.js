const MISTRAL_API_URL = "https://api.mistral.ai/v1/chat/completions";

async function createChatCompletion({
  model,
  messages,
  temperature,
  max_completion_tokens,
  response_format,
}) {
  const apiKey = process.env.Mistral_Api;

  if (!apiKey) {
    const error = new Error("Mistral API key is not configured");
    error.status = 503;
    throw error;
  }

  const response = await fetch(MISTRAL_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model || process.env.MISTRAL_MODEL || "mistral-large-latest",
      messages,
      temperature,
      max_tokens: max_completion_tokens,
      response_format,
    }),
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.message || payload.error?.message || "Mistral API request failed",
    );
    error.status = response.status;
    error.error = payload;
    throw error;
  }

  return payload;
}

module.exports = {
  chat: {
    completions: {
      create: createChatCompletion,
    },
  },
};