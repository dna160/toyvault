// Fails the build if any AI, OCR, vision, embedding or catalogue API package appears in a
// package.json or anywhere in the resolved dependency tree (master prompt §3.3).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN: RegExp[] = [
  /^@anthropic-ai\//,
  /^openai$/,
  /^@openai\//,
  /^@google-cloud\/vision$/,
  /^@google\/generative-ai$/,
  /^@google\/genai$/,
  /^@aws-sdk\/client-rekognition$/,
  /^@aws-sdk\/client-textract$/,
  /^@aws-sdk\/client-bedrock/,
  /^@azure\/(ai-|cognitiveservices-)/,
  /^tesseract\.js/,
  /^onnxruntime/,
  /^@xenova\/transformers$/,
  /^@huggingface\//,
  /^@tensorflow\//,
  /^@mediapipe\//,
  /^clip(-|$)/,
  /^langchain$/,
  /^@langchain\//,
  /^cohere-ai$/,
  /^replicate$/,
  /^@mistralai\//,
  /^ollama$/,
  /^ai$/,
  /^@ai-sdk\//,
  /upcitemdb|barcodelookup|go-upc/,
];

const root = join(import.meta.dirname, "..");
const hits: string[] = [];

function checkName(name: string, where: string) {
  if (FORBIDDEN.some((re) => re.test(name))) hits.push(`${name} (${where})`);
}

const manifests = [join(root, "package.json")];
for (const dir of readdirSync(join(root, "packages"))) {
  const p = join(root, "packages", dir, "package.json");
  if (existsSync(p)) manifests.push(p);
}
for (const file of manifests) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    for (const name of Object.keys(pkg[field] ?? {})) checkName(name, file.replace(root + "/", ""));
  }
}

// Transitive dependencies from the lockfile ("  /name@version:" or "  name@version:" keys).
const lock = join(root, "pnpm-lock.yaml");
if (existsSync(lock)) {
  for (const line of readFileSync(lock, "utf8").split("\n")) {
    const m = /^ {2}'?\/?((?:@[^/@\s]+\/)?[^@\s']+)@/.exec(line);
    if (m?.[1]) checkName(m[1], "pnpm-lock.yaml");
  }
}

if (hits.length > 0) {
  console.error(`Forbidden dependencies found:\n  ${[...new Set(hits)].join("\n  ")}`);
  process.exit(1);
}
console.log(`check-forbidden-deps: OK (${manifests.length} manifests + lockfile)`);
