// Vite's `?raw` suffix imports a file's text; the configuration test reads
// config files this way because the Workers runtime has no host filesystem.
declare module "*?raw" {
  const content: string;
  export default content;
}
