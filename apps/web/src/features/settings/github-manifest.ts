/**
 * The browser half of GitHub's App manifest flow. GitHub only accepts a manifest as a
 * top-level form POST to github.com, so the dashboard builds a form and submits it; CSP
 * `form-action` allows exactly `https://github.com` for this.
 *
 * @module
 */

/** Hosts a manifest may be posted to. GitHub Enterprise Server is not supported yet. */
const GITHUB_ORIGIN = "https://github.com";

/**
 * Checks that the API's `post_url` points at GitHub's App creation page.
 *
 * @param postUrl - URL from `POST /v1/github/manifest`.
 * @returns The parsed URL.
 * @throws Error when it is not an https URL on github.com.
 */
export function githubPostUrl(postUrl: string): URL {
  let url: URL;
  try {
    url = new URL(postUrl);
  } catch {
    throw new Error("The API returned an invalid GitHub URL.");
  }
  // SECURITY: The form carries the manifest and single-use state; never post them
  // anywhere but GitHub, even if the API response were tampered with.
  if (url.origin !== GITHUB_ORIGIN || !/\/settings\/apps\/new$/.test(url.pathname)) {
    throw new Error("The API returned a URL that is not GitHub's App creation page.");
  }
  return url;
}

/**
 * Posts the manifest to GitHub by submitting a hidden form, which navigates the tab to
 * GitHub's "Create GitHub App" page.
 *
 * @param manifest - The App manifest from the API.
 * @param postUrl - GitHub URL from the API; it already carries `state`.
 * @param doc - Document to build the form in (tests pass their own).
 * @returns The submitted form.
 * @throws Error when `postUrl` is not GitHub's App creation page.
 */
export function submitGithubManifest(
  manifest: Record<string, unknown>,
  postUrl: string,
  doc: Document = document,
): HTMLFormElement {
  const url = githubPostUrl(postUrl);
  const form = doc.createElement("form");
  form.method = "post";
  form.action = url.toString();
  form.hidden = true;
  const input = doc.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.append(input);
  doc.body.append(form);
  form.submit();
  return form;
}
