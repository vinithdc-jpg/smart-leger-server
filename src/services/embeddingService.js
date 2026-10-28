const { pipeline } = require("@xenova/transformers");

const EMBEDDING_DIMENSION = 384;
let extractor;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }

  return extractor;
}

async function generateEmbedding(text) {
  const model = await getExtractor();

  const output = await model(text, {
    pooling: "mean",
    normalize: true,
  });

  const embedding = Array.from(output.data);

  if (embedding.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Invalid embedding dimension: expected ${EMBEDDING_DIMENSION}, received ${embedding.length}`,
    );
  }

  return embedding;
}

module.exports = {
  EMBEDDING_DIMENSION,
  generateEmbedding,
};
