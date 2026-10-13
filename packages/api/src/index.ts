import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { createDb } from "./db.js";
import { loadEnv } from "./env.js";
import { migrateToLatest } from "./migrate.js";
import { S3Storage } from "./storage.js";

const env = loadEnv();
const db = createDb(env.DATABASE_URL);

// Migrations run on every deploy before the server accepts traffic.
const applied = await migrateToLatest(db);
console.log(JSON.stringify({ level: "info", msg: "migrations applied", applied }));

const app = await buildApp({
  db,
  connectorToken: env.CONNECTOR_TOKEN,
  viewerPassword: env.VIEWER_PASSWORD,
  sessionSecret: env.SESSION_SECRET,
  secureCookies: process.env.NODE_ENV === "production",
  viewerDist: env.VIEWER_DIST ?? fileURLToPath(new URL("../../viewer/dist", import.meta.url)),
  logger: true,
  storage: new S3Storage({
    endpoint: env.S3_ENDPOINT,
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  }),
});

const shutdown = async () => {
  await app.close();
  await db.destroy();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

await app.listen({ host: "::", port: env.PORT });
