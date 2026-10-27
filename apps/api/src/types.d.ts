// Shell scripts are bundled as text (see the `rules` entry in wrangler.jsonc).
declare module "*.sh" {
  const content: string;
  export default content;
}

// The Cloudflare runtime Worker is bundled as text for upload (ADR 0011).
declare module "*.worker.js" {
  const content: string;
  export default content;
}
