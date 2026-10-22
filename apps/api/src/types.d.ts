// Shell scripts are bundled as text (see the `rules` entry in wrangler.jsonc).
declare module "*.sh" {
  const content: string;
  export default content;
}
