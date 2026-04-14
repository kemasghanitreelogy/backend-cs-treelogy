const { hf, modelId } = require('../config/huggingface');

/**
 * Generate a complete text response from the LLM.
 */
async function generateResponse(prompt) {
  const result = await hf.textGeneration({
    model: modelId,
    inputs: prompt,
    parameters: {
      max_new_tokens: 1500,
      temperature: 0.3,
      top_p: 0.9,
      repetition_penalty: 1.15,
      return_full_text: false,
    },
  });

  return result.generated_text.trim();
}

/**
 * Stream a text response token-by-token via an async iterator.
 */
async function* streamResponse(prompt) {
  const stream = hf.textGenerationStream({
    model: modelId,
    inputs: prompt,
    parameters: {
      max_new_tokens: 1500,
      temperature: 0.3,
      top_p: 0.9,
      repetition_penalty: 1.15,
    },
  });

  for await (const chunk of stream) {
    if (chunk.token?.text) {
      yield chunk.token.text;
    }
  }
}

module.exports = { generateResponse, streamResponse };
