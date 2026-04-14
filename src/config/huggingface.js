const { HfInference } = require('@huggingface/inference');
const env = require('./env');

const hf = new HfInference(env.hf.apiToken);

module.exports = { hf, modelId: env.hf.modelId };
