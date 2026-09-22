/**
 * Who you are in a session.
 *
 * Anonymous by design: a random id, a generated handle, and a colour, all in
 * localStorage. There is no login and no account — the session URL is the only
 * credential, and it was never meant to be one (see the note on session ids in
 * shared/protocol.ts). So `clientId` decides whose name is on a message, who is
 * asked to render, and who may cancel their own queued message. Nothing else.
 *
 * The identity is shared across every session in this browser on purpose: you
 * are the same "rust owl" in every room, which is what makes a link you were
 * sent twice feel like the same place.
 */

import {
  newClientId,
  newColor,
  newNickname,
  sanitizeNickname,
  type Contributor,
} from "../shared/protocol";

const STORAGE_KEY = "claudio.identity.v1";

interface StoredIdentity {
  clientId: string;
  nickname: string;
  color: string;
}

function read(): StoredIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    if (typeof parsed?.clientId !== "string" || !parsed.clientId) return null;
    return {
      clientId: parsed.clientId,
      nickname: sanitizeNickname(parsed.nickname),
      color: typeof parsed.color === "string" && parsed.color ? parsed.color : newColor(),
    };
  } catch {
    // Private browsing, a quota error, or somebody's hand-edited JSON. A fresh
    // identity is a perfectly good outcome — never let this throw on boot.
    return null;
  }
}

function write(id: StoredIdentity): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(id));
  } catch {
    /* storage unavailable — the in-memory identity still works for this tab */
  }
}

let current: StoredIdentity =
  read() ?? { clientId: newClientId(), nickname: newNickname(), color: newColor() };

// Persist immediately, so the id is stable from the very first mutation even if
// the tab is closed before anything else happens.
write(current);

export const me = {
  get id(): string {
    return current.clientId;
  },
  get nickname(): string {
    return current.nickname;
  },
  get color(): string {
    return current.color;
  },

  /** The shape every mutation takes for attribution. */
  wire(): Contributor {
    return { clientId: current.clientId, nickname: current.nickname, color: current.color };
  },

  /**
   * Rename yourself. Returns the name actually stored — sanitizing can shorten
   * it or replace it wholesale, and the caller should reflect that back into the
   * input rather than let the box disagree with the room.
   */
  rename(raw: string): string {
    current = { ...current, nickname: sanitizeNickname(raw) };
    write(current);
    return current.nickname;
  },
};
