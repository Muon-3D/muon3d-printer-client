// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Muon 3D Technologies Limited
// What a person reads about an error: one plain sentence (the title), a second line where it helps (the detail), and
// at most one thing to do (the action). Every client shows the same words for the same kind, so a printer that is
// offline reads the same in Slice, in Control and in Design. British English, no codes, no blame.
//
// The action is an id the client acts on (open the printer in Control, try again, sign in, …) with the label for its
// button. The other side's own words (`detail` of the PrinterError) are not shown here: they are English for logs and
// support, not for the person.
import { cleanText, isErrorKind, needsRegrant, type ErrorKind, type PrinterError } from './kinds.ts';

/** What a client can offer to do about an error. */
export type ActionId = 'open-control' | 'retry' | 'queue' | 'ask-access' | 'sign-in' | 'open-in-chrome' | 'reload';

/** Each action's button label. */
export const ACTION_LABELS: Readonly<Record<ActionId, string>> = {
  'open-control': 'Open in Control',
  retry: 'Try again',
  queue: 'Queue it',
  'ask-access': 'Ask for access',
  'sign-in': 'Sign in',
  'open-in-chrome': 'Open in Chrome',
  reload: 'Reload',
};

/** What the client knows that the words can use: the printer's name, its owner's, when it was last seen ("2 hours ago"). */
export interface ExplainContext {
  printer?: string;
  owner?: string;
  lastSeen?: string;
}

export interface Explanation {
  title: string;
  detail?: string;
  action?: { id: ActionId; label: string };
}

/** The longest name used in a sentence; a longer one is cut (cleanText). */
const MAX_NAME = 64;

const action = (id: ActionId): { id: ActionId; label: string } => ({ id, label: ACTION_LABELS[id] });

/** How long to wait, in words: "30 seconds", "a minute", "5 minutes". */
function waitWords(seconds: number): string {
  if (seconds <= 1) return 'a second';
  if (seconds < 60) return `${Math.ceil(seconds)} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'a minute' : `${minutes} minutes`;
}

function sentence(kind: ErrorKind, error: PrinterError, ctx: ExplainContext): Explanation {
  const name = cleanText(ctx.printer ?? '', MAX_NAME);
  const owner = cleanText(ctx.owner ?? '', MAX_NAME);
  const lastSeen = cleanText(ctx.lastSeen ?? '', MAX_NAME);
  // The printer as the subject of a sentence, inside one, and as an owner.
  const Printer = name || 'The printer';
  const printer = name || 'the printer';
  const Printers = name ? `${name}'s` : "The printer's";
  const ownerCan = owner ? `${owner} can` : 'Its owner can';

  switch (kind) {
    case 'offline':
      return {
        title: `${Printer} isn't connected to Muon3D`,
        detail: `${lastSeen ? `It was last seen ${lastSeen}. ` : ''}Check it's switched on and on Wi-Fi; it reconnects by itself.`,
        action: action('open-control'),
      };
    case 'unreachable':
    case 'lost':
    case 'timeout':
      return { title: `${Printer} is on, but not answering this browser`, detail: 'It may be restarting; this usually clears in a minute.', action: action('retry') };
    case 'busy':
      // The relay's "at capacity" arrives as busy too, and is not a print.
      if (error.refusal === 'rate-limited') return { title: `${Printer} has too many connections right now`, detail: 'Try again in a minute.', action: action('retry') };
      return { title: `${Printer} is printing`, action: action('queue') };
    case 'not-allowed':
      return { title: `You can watch ${printer}, but not print on it`, detail: `${ownerCan} let you print from Control.`, action: action('ask-access') };
    case 'signed-out':
      return { title: 'Your Muon3D sign-in has ended', action: action('sign-in') };
    case 'chrome-only':
      return { title: 'Printers on your network need Chrome', detail: "Firefox and Safari don't let a website reach printers on your network.", action: action('open-in-chrome') };
    case 'permission':
      return { title: "Chrome isn't allowed to use your local network here", detail: 'Allow it from the icon left of the address, then try again.', action: action('retry') };
    case 'upload-refused':
      return { title: `${Printer} refused the file` };
    case 'cancelled':
      return { title: 'Cancelled', detail: `Nothing more was sent to ${printer}.` };
    case 'refused':
      if (needsRegrant(error)) return { title: `${Printer} didn't let this browser in`, detail: 'Your access needs renewing; trying again renews it.', action: action('retry') };
      if (error.refusal === 'revoked') return { title: `${Printer} no longer lets you in`, detail: `${ownerCan} give you access again from Control.`, action: action('ask-access') };
      return { title: `${Printer} didn't let this browser in`, detail: 'Open it in Control to check your access.', action: action('open-control') };
    case 'denied':
      return { title: `${Printer} didn't allow that`, detail: `${ownerCan} change what you're allowed to do from Control.`, action: action('ask-access') };
    case 'checksum':
      return { title: `${Printer} didn't get the whole file`, detail: 'Part of it was lost on the way; sending it again usually works.', action: action('retry') };
    case 'safety-pass':
      return { title: `${Printers} safety check stopped the file`, detail: "Slice it again with the printer's own profile." };
    case 'printer':
      return { title: `${Printer} reported a problem`, detail: 'Open it in Control to see what it says.', action: action('open-control') };
    case 'console':
      return {
        title: "Muon3D isn't answering right now",
        detail: `Try again in ${waitWords(error.retryAfterS !== undefined && error.retryAfterS > 0 ? error.retryAfterS : 60)}.`,
        action: action('retry'),
      };
    case 'printer-changed':
      return { title: 'Another printer was chosen', detail: `Nothing more was sent to ${printer}.` };
    case 'unsupported':
      return { title: `${Printer} can't do that from here`, detail: 'Open it in Control instead.', action: action('open-control') };
    case 'bad-request':
      return { title: `${Printer} couldn't take that request`, detail: 'Try again; if it happens again, open it in Control.', action: action('retry') };
    case 'protocol':
      return {
        title: `${Printer} sent an answer this page doesn't understand`,
        detail: 'Its software may be newer or older than this page; reloading the page usually fixes it.',
        action: action('reload'),
      };
  }
}

/**
 * What a person reads about `error`: a title (one sentence, no full stop), a detail where it helps, and at most one
 * action. `ctx.printer` names the printer ("Walnut is printing"; "The printer is printing" without it), `ctx.owner`
 * the person who can grant access, and `ctx.lastSeen` when an offline printer was last seen ("2 hours ago"). A kind
 * this package does not know (an error made by a newer copy of it) reads as `protocol`.
 */
export function explain(error: PrinterError, ctx: ExplainContext = {}): Explanation {
  return sentence(isErrorKind(error.kind) ? error.kind : 'protocol', error, ctx);
}
