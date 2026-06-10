import { billingFromEmail, resendApiKey } from "./config.js";

/** Sends a signup verification code. Logs to console when Resend is not configured. */
export async function sendVerificationEmail(to: string, code: string): Promise<boolean> {
  const apiKey = resendApiKey();
  const subject = "Your safeT PTT verification code";
  const html = `
    <p>Your safeT PTT verification code is:</p>
    <p style="font-size:24px;font-weight:bold;letter-spacing:4px">${code}</p>
    <p>This code expires in 30 minutes.</p>
  `;

  if (!apiKey) {
    console.log(`[billing] verification email (dev) to=${to} code=${code}`);
    return true;
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: billingFromEmail(),
      to: [to],
      subject,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`[billing] verification email failed status=${res.status} body=${body}`);
    return false;
  }
  return true;
}
