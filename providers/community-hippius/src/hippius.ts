/**
 * Hippius S3 Client
 *
 * Wraps AWS SDK v3 to talk to Hippius S3-compatible storage (s3.hippius.com).
 * All bucket/key operations use a channel-ID prefix for data isolation.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import type { HippiusConfig } from './types.js';

let s3Client: S3Client;

export function initS3Client(config: HippiusConfig): void {
  s3Client = new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKey,
      secretAccessKey: config.secretKey,
    },
    forcePathStyle: true,
  });
  console.log(`[hippius] S3 client initialized → ${config.endpoint}`);
}

function getClient(): S3Client {
  if (!s3Client) throw new Error('S3 client not initialized. Call initS3Client() first.');
  return s3Client;
}

/**
 * Derives a namespaced bucket name from a channel ID to isolate agent data.
 * Uses the first 8 hex chars of the channel ID (after 0x) as prefix.
 */
export function namespaceBucket(channelId: string, userBucket: string): string {
  const prefix = channelId.replace('0x', '').slice(0, 8).toLowerCase();
  return `${prefix}-${userBucket}`;
}

export async function ensureBucket(bucket: string): Promise<void> {
  const client = getClient();
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export async function putObject(
  bucket: string,
  key: string,
  body: Buffer,
  contentType: string
): Promise<{ etag?: string; sizeBytes: number }> {
  const client = getClient();
  const result = await client.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));
  return {
    etag: result.ETag?.replace(/"/g, ''),
    sizeBytes: body.length,
  };
}

export async function getObject(
  bucket: string,
  key: string
): Promise<{ content: string; contentType: string; sizeBytes: number }> {
  const client = getClient();
  const result = await client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));

  const bodyBytes = await result.Body!.transformToByteArray();
  return {
    content: Buffer.from(bodyBytes).toString('base64'),
    contentType: result.ContentType || 'application/octet-stream',
    sizeBytes: bodyBytes.length,
  };
}

export async function listObjects(
  bucket: string,
  prefix?: string
): Promise<{ objects: Array<{ key: string; size: number; lastModified: string }> }> {
  const client = getClient();
  const result = await client.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: 1000,
  }));

  const objects = (result.Contents || []).map(obj => ({
    key: obj.Key || '',
    size: obj.Size || 0,
    lastModified: obj.LastModified?.toISOString() || '',
  }));

  return { objects };
}

export async function createBucket(
  bucket: string
): Promise<{ bucket: string }> {
  const client = getClient();
  await client.send(new CreateBucketCommand({ Bucket: bucket }));
  return { bucket };
}

export async function deleteObject(
  bucket: string,
  key: string
): Promise<{ deleted: boolean }> {
  const client = getClient();
  await client.send(new DeleteObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  return { deleted: true };
}

/**
 * Pin content to IPFS via Hippius by uploading to a designated IPFS bucket.
 * The object key is used as the filename; Hippius returns the CID via ETag or response metadata.
 */
export async function ipfsPin(
  ipfsBucket: string,
  filename: string,
  body: Buffer,
  contentType: string
): Promise<{ cid: string; sizeBytes: number }> {
  const client = getClient();
  const key = `ipfs/${Date.now()}-${filename}`;

  const result = await client.send(new PutObjectCommand({
    Bucket: ipfsBucket,
    Key: key,
    Body: body,
    ContentType: contentType,
  }));

  const cid = result.ETag?.replace(/"/g, '') || key;

  return {
    cid,
    sizeBytes: body.length,
  };
}
