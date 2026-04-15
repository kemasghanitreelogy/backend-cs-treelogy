const { hf, modelId } = require('../config/huggingface');

// Ordered fallback list — try the configured model first, then known-available ones.
const MODEL_FALLBACKS = [
  modelId,
  'meta-llama/Llama-3.1-8B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
  'HuggingFaceH4/zephyr-7b-beta',
].filter((m, i, arr) => arr.indexOf(m) === i);

const PARAMS = {
  max_new_tokens: 1500,
  temperature: 0.3,
  top_p: 0.9,
  repetition_penalty: 1.15,
};

async function generateResponse(prompt) {
  let lastErr;
  for (const model of MODEL_FALLBACKS) {
    try {
      const result = await hf.textGeneration({
        model,
        inputs: prompt,
        parameters: { ...PARAMS, return_full_text: false },
      });
      return result.generated_text.trim();
    } catch (err) {
      lastErr = err;
      console.warn(`[LLM] textGeneration failed for ${model}: ${err.message}`);
    }
  }
  throw lastErr;
}

async function* streamResponse(prompt) {
  let lastErr;
  for (const model of MODEL_FALLBACKS) {
    try {
      const stream = hf.textGenerationStream({
        model,
        inputs: prompt,
        parameters: PARAMS,
      });
      for await (const chunk of stream) {
        if (chunk.token?.text) yield chunk.token.text;
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[LLM] textGenerationStream failed for ${model}: ${err.message}`);
    }
  }
  throw lastErr;
}

module.exports = { generateResponse, streamResponse };
