import { Resend } from "resend";
import type { Env } from "../../env.js";

export type SendMailInput = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

export type Mailer = {
  send: (input: SendMailInput) => Promise<void>;
};

export function createMailer(env: Env): Mailer {
  if (!env.RESEND_API_KEY) {
    return {
      async send(input) {
        console.info(`[mail:dev] to=${input.to} subject=${input.subject}`);
      },
    };
  }

  const resend = new Resend(env.RESEND_API_KEY);
  const from = env.EMAIL_FROM;

  return {
    async send(input) {
      const { error } = await resend.emails.send({
        from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
      if (error) {
        throw new Error(`Resend failed: ${error.message}`);
      }
    },
  };
}

export async function sendMail(mailer: Mailer, input: SendMailInput): Promise<void> {
  await mailer.send(input);
}

export function inviteEmailHtml(input: {
  firstName: string;
  adminName: string;
  lineManagerName: string | null;
  year: number;
  activateUrl: string;
}): string {
  return `
  <div style="font-family: Nunito, Arial, sans-serif; max-width: 560px; margin: 0 auto; border-top: 4px solid #0B2A4A; padding: 24px;">
    <p style="font-weight: 700; color: #0B2A4A;">Dev-Afrique</p>
    <h1 style="color: #0B2A4A;">Welcome to Impact Plan, ${input.firstName}</h1>
    <p>Your administrator has created an Impact Plan account for you. Impact Plan is where you'll see your goals for the year, track progress and complete your year-end review.</p>
    <table style="width:100%; background:#f5f7fa; padding:12px; border-radius:8px;">
      <tr><td>Invited by</td><td style="text-align:right;">${input.adminName}, People &amp; Operations</td></tr>
      <tr><td>Line manager</td><td style="text-align:right;">${input.lineManagerName ?? "—"}</td></tr>
      <tr><td>Plan year</td><td style="text-align:right;">${input.year}</td></tr>
    </table>
    <p style="margin-top:24px;"><a href="${input.activateUrl}" style="background:#0B2A4A;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;display:inline-block;">Activate my account</a></p>
    <p style="color:#6b7c8f;font-size:12px;">This secure link is just for you and expires in 7 days. If it has expired, ask your administrator to resend the invitation.</p>
    <p style="color:#6b7c8f;font-size:12px;">Dev-Afrique Development Advisors · Abuja, Nigeria</p>
  </div>`;
}

export function reviewWindowOpenedEmailHtml(input: {
  firstName: string;
  year: number;
  windowLabel: string;
  deadline: string;
}): string {
  return `
  <div style="font-family: Nunito, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h1 style="color:#0B2A4A;">${input.windowLabel}</h1>
    <p>Hi ${input.firstName},</p>
    <p>Your administrator has opened the <strong>${input.windowLabel.toLowerCase()}</strong> for Impact Plan ${input.year}.</p>
    <p>Please sign in and complete the required steps before <strong>${input.deadline}</strong>.</p>
    <p style="color:#6b7c8f;font-size:12px;">Dev-Afrique Development Advisors</p>
  </div>`;
}

export function otpEmailHtml(code: string): string {
  return `
  <div style="font-family: Nunito, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px;">
    <h1 style="color:#0B2A4A;">Your Impact Plan code</h1>
    <p>Use this one-time code within 10 minutes:</p>
    <p style="font-size:32px;letter-spacing:8px;font-weight:800;color:#0B2A4A;">${code}</p>
  </div>`;
}
