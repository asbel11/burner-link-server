/**
 * S3-compatible object storage for CONNECT attachments (presigned PUT/GET, bulk delete).
 * Works with AWS S3, Cloudflare R2, MinIO, etc. when `CONNECT_S3_ENDPOINT` is set.
 *
 * @see docs/connect-attachments-storage.md
 */

const {
  S3Client,
  DeleteObjectsCommand,
  HeadObjectCommand,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

/**
 * @returns {{ bucket: string, region: string, client: import('@aws-sdk/client-s3').S3Client } | null}
 */
function createS3ClientFromEnv() {
  const bucket =
    process.env.CONNECT_S3_BUCKET || process.env.S3_BUCKET || "";
  const region =
    process.env.CONNECT_S3_REGION ||
    process.env.AWS_REGION ||
    "us-east-1";
  const accessKeyId =
    process.env.CONNECT_S3_ACCESS_KEY_ID ||
    process.env.AWS_ACCESS_KEY_ID ||
    "";
  const secretAccessKey =
    process.env.CONNECT_S3_SECRET_ACCESS_KEY ||
    process.env.AWS_SECRET_ACCESS_KEY ||
    "";
  const endpointRaw = (
    process.env.CONNECT_S3_ENDPOINT || ""
  ).trim();
  const forcePathStyle = /^(1|true|yes|on)$/i.test(
    String(process.env.CONNECT_S3_FORCE_PATH_STYLE || "").trim()
  );

  if (!bucket || !accessKeyId || !secretAccessKey) {
    return null;
  }

  const client = new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
    ...(endpointRaw
      ? { endpoint: endpointRaw, forcePathStyle }
      : {}),
  });

  return { bucket, region, client };
}

/**
 * @param {{ bucket: string, client: import('@aws-sdk/client-s3').S3Client }} s3
 */
function createAttachmentObjectStorage(s3) {
  const { bucket, client } = s3;

  return {
    bucket,

    /**
     * @param {string} key
     * @param {string} contentType
     * @param {number} expiresInSeconds
     */
    async presignPutObject(key, contentType, expiresInSeconds) {
      const cmd = new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: contentType || "application/octet-stream",
      });
      const url = await getSignedUrl(client, cmd, {
        expiresIn: expiresInSeconds,
      });
      return url;
    },

    /**
     * @param {string} key
     * @param {number} expiresInSeconds
     */
    async presignGetObject(key, expiresInSeconds) {
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });
      return getSignedUrl(client, cmd, { expiresIn: expiresInSeconds });
    },

    /**
     * @param {string} key
     * @returns {Promise<{ contentLength: number } | null>}
     */
    async headObject(key) {
      try {
        const out = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key })
        );
        const n = Number(out.ContentLength);
        if (!Number.isFinite(n) || n < 0) {
          return null;
        }
        return { contentLength: Math.floor(n) };
      } catch {
        return null;
      }
    },

    /**
     * @param {string[]} keys
     */
    async deleteObjects(keys) {
      const uniq = [...new Set(keys.filter((k) => typeof k === "string" && k))];
      if (uniq.length === 0) {
        return { deleted: 0 };
      }
      const out = await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: uniq.map((Key) => ({ Key })),
            Quiet: true,
          },
        })
      );
      const n = (out.Deleted && out.Deleted.length) || uniq.length;
      return { deleted: n };
    },
  };
}

module.exports = {
  createS3ClientFromEnv,
  createAttachmentObjectStorage,
};
