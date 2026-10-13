import { z } from "zod";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  CONNECTOR_TOKEN: z.string().min(32, "CONNECTOR_TOKEN must be at least 32 characters"),
  PORT: z.coerce.number().int().default(3000),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  S3_REGION: z.string().default("auto"),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  VIEWER_PASSWORD: z.string().min(12, "VIEWER_PASSWORD must be at least 12 characters").optional(),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters").optional(),
  VIEWER_DIST: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof Env>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = Env.safeParse(source);
  if (!result.success) {
    const fields = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${fields}`);
  }
  return result.data;
}
