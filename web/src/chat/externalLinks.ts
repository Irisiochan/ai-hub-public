export interface ExternalLinkView {
  url: string;
}

export function shouldOpenInExternalView(href: string | undefined, currentHref: string): boolean {
  if (!href) return false;
  try {
    const target = new URL(href, currentHref);
    const current = new URL(currentHref);
    return (target.protocol === 'http:' || target.protocol === 'https:') && target.origin !== current.origin;
  } catch {
    return false;
  }
}

export function openExternalLink(url: string): ExternalLinkView {
  return { url };
}

export function closeExternalLink(): null {
  return null;
}
