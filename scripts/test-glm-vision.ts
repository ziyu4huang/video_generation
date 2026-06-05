#!/usr/bin/env bun
// Quick test: does GLM-5V-Turbo respond to vision (image_url) input?

const API_KEY = process.env.ZAI_API_KEY;
const BASE_URL = "https://api.z.ai/api/coding/paas/v4";
const MODEL = "glm-5v-turbo";

// A tiny public test image (1x1 red pixel PNG, base64)
const RED_PIXEL_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==";

async function testVision() {
  if (!API_KEY) {
    console.error("ZAI_API_KEY not set");
    process.exit(1);
  }

  const payload = {
    model: MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${RED_PIXEL_B64}`,
            },
          },
          {
            type: "text",
            text: "What color is this image? Reply in one word.",
          },
        ],
      },
    ],
    max_tokens: 64,
  };

  console.log(`Testing model: ${MODEL}`);
  console.log(`Endpoint: ${BASE_URL}/chat/completions\n`);

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    console.error("ERROR", res.status, JSON.stringify(data, null, 2));
    process.exit(1);
  }

  const reply = data.choices?.[0]?.message?.content ?? "(no content)";
  console.log("Vision response:", reply);
  console.log("\nFull response:");
  console.log(JSON.stringify(data, null, 2));
}

testVision().catch(console.error);
