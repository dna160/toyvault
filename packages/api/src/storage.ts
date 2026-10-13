import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

/** The private photo bucket. Only signed URLs ever leave the API. */
export interface Storage {
  presignPut(key: string, contentType: string): Promise<string>;
  presignGet(key: string): Promise<string>;
  exists(key: string): Promise<boolean>;
}

export interface S3Config {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

const PUT_TTL_SECONDS = 15 * 60;
const GET_TTL_SECONDS = 60 * 60;

export class S3Storage implements Storage {
  private client: S3Client;

  constructor(private config: S3Config) {
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  presignPut(key: string, contentType: string): Promise<string> {
    const cmd = new PutObjectCommand({ Bucket: this.config.bucket, Key: key, ContentType: contentType });
    return getSignedUrl(this.client, cmd, { expiresIn: PUT_TTL_SECONDS });
  }

  presignGet(key: string): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: this.config.bucket, Key: key });
    return getSignedUrl(this.client, cmd, { expiresIn: GET_TTL_SECONDS });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return true;
    } catch (err) {
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || status === 403) return false;
      throw err;
    }
  }
}

export function photoKeys(photoId: string, originalContentType: string) {
  const ext = originalContentType === "image/png" ? "png" : "jpg";
  return {
    original: `photos/${photoId}/original.${ext}`,
    preview: `photos/${photoId}/preview.jpg`,
    thumb: `photos/${photoId}/thumb.jpg`,
  };
}
