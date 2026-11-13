// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// Adapted from Muon3D Fluidd (src/util/page-blocks-printer.ts), written by Muon 3D.
//
// Whether the browser, not the printer, is what stops a page reaching a printer, and the printer's own page as the
// way round it.

/**
 * Whether the browser, not the printer, stops this page reaching `apiUrl`. A page served over HTTPS asking a
 * plain-HTTP printer is mixed content: every browser but Chromium blocks it before it leaves the machine, and Chromium
 * does too until the person allows local network access. The address is then usually right, and the printer's own
 * page works.
 */
export function pageBlocksPrinter(apiUrl: string, pageProtocol: string = (globalThis as { location?: { protocol?: string } }).location?.protocol ?? ''): boolean {
  return pageProtocol === 'https:' && /^http:\/\//i.test(apiUrl);
}

/** The printer's own page, for an API address such as `http://192.168.1.153`. */
export function printerPageUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/`;
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Text made safe to put inside HTML, an attribute value included. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}
