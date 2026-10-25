import { PageReadRequest, type PageProjectionRequest } from './page-read.js';

// Fixed, read-only DOM implementation shared by the extension and the private SDK observer.
// Callers supply selectors as validated data; this never accepts executable source from the UI.
export function projectPage(request: PageProjectionRequest) {
  return {
    url: location.href,
    timeOrigin: performance.timeOrigin,
    ready: document.readyState,
    visibility: document.visibilityState,
    rows: request.queries.map((query) => {
      const nodes = [];
      const matches = document.querySelectorAll(query.selector);
      for (let index = 0; index < Math.min(matches.length, query.limit); index++) {
        const element = matches[index];
        if (!element) continue;
        const rect = element.getBoundingClientRect(),
          style = getComputedStyle(element);
        const attributes: Record<string, string> = {};
        for (const key of query.attributes) {
          const value = element.getAttribute(key);
          if (value !== null) attributes[key] = value.slice(0, 2048);
        }
        nodes.push({
          tag: element.tagName.toLowerCase().slice(0, 30),
          text: query.text
            ? (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 500)
            : '',
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== 'none' &&
            style.visibility !== 'hidden',
          attributes,
        });
      }
      return { key: query.key, nodes };
    }),
  };
}

export function pageProjectionExpression(input: PageProjectionRequest): string {
  const request = PageReadRequest.parse(input);
  return '(' + projectPage.toString() + ')(' + JSON.stringify(request) + ')';
}
