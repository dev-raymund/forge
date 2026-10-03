import type { Metadata } from "next";
import { AuthCard, AuthLink, ForgotPasswordForm, RESET_TOKEN_MINUTES } from "@/modules/auth";

export const metadata: Metadata = { title: "Reset your password" };

export default function ForgotPasswordPage() {
  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email address of your account and we will send you a link to choose a new password."
      footer={
        <>
          Remembered it? <AuthLink href="/login">Back to log in</AuthLink>
        </>
      }
    >
      <ForgotPasswordForm resetMinutes={RESET_TOKEN_MINUTES} />
    </AuthCard>
  );
}
