/**
 * Account security state for the MSW handlers: who has two-factor on, pending
 * enrollments and sign-in challenges, other sessions, and locked addresses.
 *
 * The mocks accept {@link MOCK_TOTP_CODE} as every authenticator code; backup codes are
 * kept in plain text here (the real API keeps only hashes). Nobody starts enrolled, and
 * the mocks don't enforce the two-factor gate, so suites about other features run as
 * before.
 *
 * @module
 */
import type { AccountSession } from "../lib/api/security-types";

/** The authenticator code the mocks accept. */
export const MOCK_TOTP_CODE = "123456";

/** Backup codes handed out by mock enrollment, in order. */
export const MOCK_BACKUP_CODES = [
  "abcde-12345",
  "fghij-67890",
  "klmno-13579",
  "pqrst-24680",
  "uvwxy-11223",
  "zabcd-44556",
  "efghi-77889",
  "jklmn-99001",
  "opqrs-22334",
  "tuvwx-55667",
];

/** Id of the session the signed-in mock browser uses. */
export const CURRENT_SESSION_ID = "ses_current";

/** A TOTP URI like Better Auth's, for the mock enrollment. */
export const MOCK_TOTP_URI =
  "otpauth://totp/Roundhouse:ada%40example.com?secret=KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU&issuer=Roundhouse&digits=6&period=30";

/** The account security part of the mock database. */
export interface SecurityDb {
  /** Users with two-factor on, and their unused backup codes. */
  twoFactor: Record<string, { backupCodes: string[] }>;
  /** Users who started enrollment but haven't confirmed a code yet. */
  pending: Record<string, { backupCodes: string[] }>;
  /** The user whose sign-in waits for a second factor. */
  challengeUserId: string | null;
  /** Sessions other than {@link CURRENT_SESSION_ID}, by user. */
  otherSessions: (AccountSession & { user_id: string })[];
  /** Locked addresses (lowercased) and until when. */
  locked: Record<string, number>;
}

/**
 * The seeded state: one other session for the owner, nobody enrolled or locked.
 *
 * @param ownerId - The seeded owner's user id.
 * @param now - Seed time.
 * @returns A fresh security store.
 */
export function seedSecurity(ownerId: string, now: number): SecurityDb {
  return {
    twoFactor: {},
    pending: {},
    challengeUserId: null,
    otherSessions: [
      {
        id: "ses_laptop",
        user_id: ownerId,
        current: false,
        ip_address: "198.51.100.23",
        user_agent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
        created_at: now - 3 * 86_400_000,
        expires_at: now + 4 * 86_400_000,
      },
    ],
    locked: {},
  };
}
