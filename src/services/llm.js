const { hf, modelId } = require('../config/huggingface');

// HuggingFace inference providers now only support the `conversational` task,
// so we must use chatCompletion / chatCompletionStream (OpenAI-style messages),
// not the legacy textGeneration / textGenerationStream APIs.
const MODEL_FALLBACKS = [
  modelId,
  'meta-llama/Llama-3.1-8B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct',
  'mistralai/Mistral-7B-Instruct-v0.3',
].filter((m, i, arr) => arr.indexOf(m) === i);

const PARAMS = {
  max_tokens: 1500,
  temperature: 0.3,
  top_p: 0.9,
};

function toMessages(prompt) {
  return [{ role: 'user', content: prompt }];
}

async function generateResponse(prompt) {
  let lastErr;
  for (const model of MODEL_FALLBACKS) {
    try {
      const result = await hf.chatCompletion({
        model,
        messages: toMessages(prompt),
        ...PARAMS,
      });
      const text = result?.choices?.[0]?.message?.content;
      if (text) return text.trim();
      throw new Error('Empty completion response');
    } catch (err) {
      lastErr = err;
      console.warn(`[LLM] chatCompletion failed for ${model}: ${err.message}`);
    }
  }
  throw lastErr;
}

async function* streamResponse(prompt) {
  let lastErr;
  for (const model of MODEL_FALLBACKS) {
    try {
      const stream = hf.chatCompletionStream({
        model,
        messages: toMessages(prompt),
        ...PARAMS,
      });
      for await (const chunk of stream) {
        const delta = chunk?.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      }
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[LLM] chatCompletionStream failed for ${model}: ${err.message}`);
    }
  }
  throw lastErr;
}

module.exports = { generateResponse, streamResponse };
