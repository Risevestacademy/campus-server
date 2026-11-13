/** How recordings and uploads both reach Cloudflare R2 through its S3 API. */
export interface R2Connection {
  region: 'auto';
  endpoint: string;
  forcePathStyle: true;
}

export function r2Connection(accountId: string): R2Connection {
  return {
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    forcePathStyle: true,
  };
}
