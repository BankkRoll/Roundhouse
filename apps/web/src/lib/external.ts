/**
 * Leaving the dashboard for another site. One object, so tests can replace the
 * navigation (jsdom's `window.location.assign` can't be stubbed).
 *
 * @module
 */

/** Full-page navigations away from the dashboard. */
export const external = {
  /**
   * Sends the browser to `url`, as a link would.
   *
   * @param url - Absolute URL, e.g. GitHub's install page.
   */
  assign(url: string): void {
    window.location.assign(url);
  },
};
