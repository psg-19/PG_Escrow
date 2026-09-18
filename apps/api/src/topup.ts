import QRCode from "qrcode";
import { rupees, formatPaise } from "@pg/core";

/**
 * UPI top-up — a mock.
 *
 * The intended product is: you pay rupees over UPI, we receive them, and we
 * credit the same amount of escrow currency to your wallet. None of that is
 * built. There is no merchant account, no payment gateway, no settlement, and
 * nobody on the other end of this QR code.
 *
 * ## Why the payee is deliberately unreachable
 *
 * A QR code that encodes a *valid* UPI address is a live payment request. Print
 * it, screenshot it, put it in a demo video, and somebody eventually scans it
 * and real money leaves their account for an address nobody is watching.
 *
 * So the payee handle below uses a PSP suffix that does not exist. Every UPI app
 * rejects it at validation, before any amount is entered. The QR still scans and
 * still looks right in a screenshot, which is all a demo needs — it simply
 * cannot move money. Do not "fix" this by putting a real VPA here.
 */
export const DEMO_PAYEE_VPA = "pgescrow-demo@notarealpsp";
export const DEMO_PAYEE_NAME = "PG Escrow (demo)";

export const TOPUP_PRESETS_RUPEES = [5_000, 15_000, 45_000, 100_000];

/** Builds the UPI deep link a QR code encodes. */
export function upiUri(amountRupees: number, note: string): string {
  const params = new URLSearchParams({
    pa: DEMO_PAYEE_VPA,
    pn: DEMO_PAYEE_NAME,
    am: amountRupees.toFixed(2),
    cu: "INR",
    tn: note,
  });
  return `upi://pay?${params.toString()}`;
}

export interface TopupQuote {
  amountRupees: number;
  amountDisplay: string;
  /** What the wallet would be credited. 1:1 — no spread, no fee, it is a demo. */
  creditsDisplay: string;
  upiUri: string;
  qrSvg: string;
  payeeVpa: string;
  /** Always true. Kept in the payload so the UI cannot forget to say so. */
  isMock: true;
  notice: string;
}

export async function buildTopupQuote(amountRupees: number): Promise<TopupQuote> {
  const amount = Math.min(500_000, Math.max(100, Math.round(amountRupees)));
  const paise = rupees(amount);
  const uri = upiUri(amount, "PG Escrow wallet top-up (demo)");

  // SVG rather than a PNG data URL: it stays sharp at any size and costs
  // nothing to inline.
  const qrSvg = await QRCode.toString(uri, {
    type: "svg",
    errorCorrectionLevel: "M",
    margin: 1,
    width: 240,
  });

  return {
    amountRupees: amount,
    amountDisplay: formatPaise(paise),
    creditsDisplay: formatPaise(paise),
    upiUri: uri,
    qrSvg,
    payeeVpa: DEMO_PAYEE_VPA,
    isMock: true,
    notice:
      "This QR is not a live payment request. The payee handle does not exist, so any UPI app will refuse it — scanning cannot move money. Real UPI settlement is not built yet.",
  };
}
