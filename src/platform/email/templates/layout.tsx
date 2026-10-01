import { Body, Button, Container, Head, Heading, Hr, Html, Link, Preview, Section, Text } from "@react-email/components";
import type { ReactNode } from "react";

/**
 * Shared layout for every Forge email (M1-4). Templates only format the data
 * they are given: no queries, no decisions. React escapes every value, so
 * names and other user-provided text can't inject markup.
 */

const styles = {
  body: { backgroundColor: "#f4f4f5", fontFamily: "-apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif", margin: 0 },
  container: { backgroundColor: "#ffffff", margin: "24px auto", padding: "32px", maxWidth: "560px", borderRadius: "8px" },
  brand: { fontSize: "18px", fontWeight: 700, margin: "0 0 24px", color: "#18181b" },
  heading: { fontSize: "20px", fontWeight: 600, margin: "0 0 16px", color: "#18181b" },
  text: { fontSize: "15px", lineHeight: "24px", color: "#3f3f46", margin: "0 0 16px" },
  button: { backgroundColor: "#18181b", color: "#ffffff", borderRadius: "6px", padding: "12px 20px", fontSize: "15px", fontWeight: 600, textDecoration: "none" },
  small: { fontSize: "13px", lineHeight: "20px", color: "#71717a", margin: "0 0 8px" },
  link: { color: "#71717a", wordBreak: "break-all" as const },
};

export function EmailLayout({ preview, heading, children }: { preview: string; heading: string; children: ReactNode }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={styles.body}>
        <Container style={styles.container}>
          <Text style={styles.brand}>Forge</Text>
          <Heading as="h1" style={styles.heading}>
            {heading}
          </Heading>
          {children}
          <Hr style={{ borderColor: "#e4e4e7", margin: "24px 0" }} />
          <Text style={styles.small}>You received this email because of activity on a Forge account.</Text>
        </Container>
      </Body>
    </Html>
  );
}

export function Paragraph({ children }: { children: ReactNode }) {
  return <Text style={styles.text}>{children}</Text>;
}

/** A call-to-action button plus the same URL as text, for clients that block buttons. */
export function ActionLink({ href, label }: { href: string; label: string }) {
  return (
    <>
      <Section style={{ margin: "8px 0 24px" }}>
        <Button href={href} style={styles.button}>
          {label}
        </Button>
      </Section>
      <Text style={styles.small}>Or open this link:</Text>
      <Text style={styles.small}>
        <Link href={href} style={styles.link}>
          {href}
        </Link>
      </Text>
    </>
  );
}

export function SmallPrint({ children }: { children: ReactNode }) {
  return <Text style={styles.small}>{children}</Text>;
}

export const formatDate = (date: Date) =>
  new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(date);
