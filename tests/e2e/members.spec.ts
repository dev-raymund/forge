import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import { accountMenu, asUniqueVisitor, landing, logOut, newEmail, PASSWORD, passwordField, signUp } from "./helpers/auth";
import { countEmails, firstLink, waitForEmail } from "./helpers/mailbox";
import {
  invitationSentMinutesAgo, invitationsOf, markEmailVerified, organizationRow, rolesIn, seedOrganization, setInvitationExpiry, type SeededOrganization,
} from "./helpers/orgs";
import { addMember, seedUser } from "./helpers/sites";

/**
 * M3-4 end to end against the production build: the members page, invitations
 * by email (delivered to the local Mailpit inbox), accepting one with an
 * existing and with a new account, and managing members.
 *
 * Emails are real messages from the `email.send` job; the link a test follows
 * is the one in the message, the only place the token exists outside the
 * recipient's address bar.
 */

// After a client-side navigation Next keeps the page it left in the document, hidden: look at what is on screen only.
const shown = (scope: Page | Locator, testId: string) => scope.getByTestId(testId).filter({ visible: true });
const orgNav = (page: Page) => page.getByRole("navigation", { name: "Organization" });
const memberRole = (page: Page) => shown(page, "member-role");
const memberRow = (page: Page, email: string) => page.getByRole("row").filter({ hasText: email });
const roleOf = (page: Page, email: string) => memberRow(page, email).getByTestId("role");
const invitationRow = (page: Page, email: string) => shown(page, "invitation").filter({ hasText: email });
const boardAnswer = (page: Page) => page.locator("main > [data-form-alert], main [data-form-alert].mb-6").filter({ visible: true });
const inviteDialog = (page: Page) => page.getByRole("dialog", { name: "Invite a member" });
const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const invitationSubject = (inviter: string, organization: SeededOrganization) => `${inviter} invited you to ${organization.name} on Forge`;

/** A signed-in user who is a member of the organization, on its members page. Verified, so they may invite. */
async function memberOn(page: Page, organization: SeededOrganization, role: Parameters<typeof addMember>[2], name: string) {
  await asUniqueVisitor(page);
  const email = newEmail();
  await signUp(page, email, { name });
  await markEmailVerified(email);
  await addMember(organization.id, email, role);
  await page.goto(`/${organization.slug}/members`);
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  return email;
}

/** Another person, in a browser of their own. */
async function anotherPerson(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await asUniqueVisitor(page);
  return { context, page };
}

/** Sends an invitation through the dialog and returns the link from the email that arrives. */
async function invite(page: Page, email: string, role: "Admin" | "Editor" | "Author" | "Viewer", subject: string): Promise<string> {
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = inviteDialog(page);
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByRole("radio", { name: new RegExp(`^${role}\\b`) }).check();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.locator('[data-form-alert][role="status"]')).toHaveText(`Invitation sent to ${email}.`);
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
  const link = firstLink(await waitForEmail(email, { subject }));
  expect(new URL(link).pathname).toMatch(/^\/invite\/[A-Za-z0-9_-]{43}$/);
  return link;
}

test.beforeEach(async ({ page }) => {
  await asUniqueVisitor(page);
});

test("invite an existing user: the Owner invites by email, the person accepts from the link, and the role they were given is what they can do", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("team");
  const owner = await memberOn(page, organization, "owner", "Olive Owner");

  // Bob already has a Forge account, and belongs nowhere yet.
  const bob = await anotherPerson(browser);
  const bobEmail = newEmail();
  await signUp(bob.page, bobEmail, { name: "Bob Existing" });

  // The dialog: an address and a role. Owner is not on the list of roles.
  await page.getByRole("button", { name: "Invite member" }).click();
  const dialog = inviteDialog(page);
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await expect(dialog.getByRole("radio", { name: /^Owner\b/ })).toHaveCount(0);
  for (const role of ["Admin", "Editor", "Author", "Viewer"]) await expect(dialog.getByRole("radio", { name: new RegExp(`^${role}\\b`) })).toBeVisible();
  // Nothing chosen, nothing valid: said at the fields, and nothing is sent.
  await dialog.getByLabel("Email").fill("not an address");
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByText("Enter a valid email address.")).toBeVisible();
  await expect(dialog.getByText("Choose a role.")).toBeVisible();
  expect(await invitationsOf(organization.id)).toEqual([]);
  await dialog.getByRole("button", { name: "Cancel" }).click();

  const link = await invite(page, bobEmail, "Author", invitationSubject("Olive Owner", organization));
  // On the page: waiting for an answer.
  await expect(invitationRow(page, bobEmail)).toContainText("Author");
  await expect(invitationRow(page, bobEmail)).toContainText("Invited by Olive Owner.");
  // In the database: a hash, not the token.
  const token = new URL(link).pathname.split("/").pop()!;
  const [stored] = await invitationsOf(organization.id);
  expect(stored).toMatchObject({ email: bobEmail, role: "author", state: "pending" });
  expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored!.token_hash).not.toContain(token);
  // The email: who, where, as what, until when.
  const mail = await waitForEmail(bobEmail, { subject: invitationSubject("Olive Owner", organization) });
  expect(mail.Text).toContain(`Olive Owner invited you to join ${organization.name} as Author.`);
  expect(mail.Text).toContain("This invitation expires on");
  expect(link.startsWith(`${baseURL}/invite/`)).toBe(true);

  // The same address again: refused, at the field, and no second email.
  await page.getByRole("button", { name: "Invite member" }).click();
  await dialog.getByLabel("Email").fill(bobEmail.toUpperCase());
  await dialog.getByRole("radio", { name: /^Viewer\b/ }).check();
  await dialog.getByRole("button", { name: "Send invitation" }).click();
  await expect(dialog.getByText("There is already an invitation for this address. You can send it again or revoke it.")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await countEmails(bobEmail)).toBe(2); // his own verification email, and the one invitation

  // The Owner herself opens the link: it is not hers, and there is nothing to accept with.
  await page.goto(link);
  await expect(page.getByRole("heading", { level: 1, name: `Join ${organization.name} on Forge` })).toBeVisible();
  await expect(page.getByText(`You are logged in as ${owner}`)).toBeVisible();
  await expect(page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
  expect(await rolesIn(organization.id)).toEqual({ [owner]: "owner" });

  // Bob opens it, signed in as the address it was sent to.
  await bob.page.goto(link);
  await expect(bob.page.getByRole("heading", { level: 1, name: `Join ${organization.name} on Forge` })).toBeVisible();
  await expect(bob.page.getByText(`Olive Owner invited you to join ${organization.name} as an Author.`)).toBeVisible();
  await expect(shown(bob.page, "invitation-state")).toContainText(bobEmail);
  await bob.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(bob.page).toHaveURL(`${baseURL}/${organization.slug}`);
  await expect(memberRole(bob.page)).toHaveText("Author");
  expect(await rolesIn(organization.id)).toEqual({ [owner]: "owner", [bobEmail]: "author" });
  expect((await invitationsOf(organization.id))[0]!.state).toBe("accepted");

  // The role is enforced: an Author sees the people, and has nothing to manage them or the organization with.
  await orgNav(bob.page).getByRole("link", { name: "Members" }).click();
  await expect(bob.page.getByRole("row")).toHaveCount(3); // the header and two members
  await expect(roleOf(bob.page, bobEmail)).toHaveText("Author");
  await expect(memberRow(bob.page, bobEmail)).toContainText("You");
  await expect(bob.page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
  await expect(bob.page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  await expect(bob.page.getByRole("heading", { name: "Invitations" })).toHaveCount(0);
  await expect(orgNav(bob.page).getByRole("link", { name: "Settings" })).toHaveCount(0);
  await bob.page.goto(`/${organization.slug}/settings`);
  await expect(shown(bob.page, "no-access")).toBeVisible();

  // The Owner's list: Bob is a member now, and nobody is waiting.
  await page.goto(`/${organization.slug}/members`);
  await expect(roleOf(page, bobEmail)).toHaveText("Author");
  await expect(shown(page, "no-invitations")).toBeVisible();

  // The link has been used: it names nothing any more, for Bob or for anyone.
  for (const visitor of [bob.page, page]) {
    await visitor.goto(link);
    await expect(shown(visitor, "invitation-state")).toHaveAttribute("data-state", "invalid");
    await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("This invitation is not valid");
    expect(await visitor.content()).not.toContain(organization.name);
  }
  await bob.context.close();
});

test("invite a new person: from the email to an account to the organization, without losing the invitation on the way", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("newcomer");
  await memberOn(page, organization, "owner", "Olive Owner");
  const email = newEmail();
  const link = await invite(page, email, "Editor", invitationSubject("Olive Owner", organization));

  // Nobody is signed in where the link is opened. It says what it is, and offers both ways to an account.
  const ivy = await anotherPerson(browser);
  await ivy.page.goto(link);
  await expect(ivy.page.getByRole("heading", { level: 1, name: `Join ${organization.name} on Forge` })).toBeVisible();
  await expect(ivy.page.getByText("To accept it, use a Forge account with that email address.")).toBeVisible();
  await expect(ivy.page.getByRole("link", { name: "Log in", exact: true })).toBeVisible();
  // The page does not ask to be remembered by the next site: no referrer leaves it.
  expect(await ivy.page.locator('meta[name="referrer"]').getAttribute("content")).toBe("no-referrer");

  // Create an account: the address is filled in, and afterwards she is back at the invitation.
  await ivy.page.getByRole("link", { name: "Create an account" }).click();
  await expect(ivy.page).toHaveURL(/\/signup\?next=%2Finvite%2F/);
  await expect(ivy.page.getByLabel("Email")).toHaveValue(email);
  await ivy.page.getByLabel("Name").fill("Ivy Newcomer");
  await passwordField(ivy.page).fill(PASSWORD);
  await ivy.page.getByRole("button", { name: "Create account" }).click();
  await expect(ivy.page).toHaveURL(link);
  await expect(ivy.page.getByRole("button", { name: "Accept invitation" })).toBeVisible();

  await ivy.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(ivy.page).toHaveURL(`${baseURL}/${organization.slug}`);
  await expect(memberRole(ivy.page)).toHaveText("Editor");
  await expect(accountMenu(ivy.page)).toContainText("Ivy Newcomer");
  // Her address is not verified yet: the app says so, and she can work meanwhile.
  await expect(shown(ivy.page, "verify-email-banner")).toBeVisible();
  expect((await rolesIn(organization.id))[email]).toBe("editor");

  // She belongs somewhere now: `/` is this organization, not onboarding.
  await ivy.page.goto("/");
  await expect(ivy.page).toHaveURL(`${baseURL}/${organization.slug}`);
  await ivy.context.close();
});

test("an invitation is for the address it was sent to: another account cannot accept it, and is shown the way to the right one", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("address");
  await memberOn(page, organization, "admin", "Adam Admin"); // an Admin may invite, too
  const invitedEmail = newEmail();
  const link = await invite(page, invitedEmail, "Viewer", invitationSubject("Adam Admin", organization));

  // Two accounts, one browser: Mallory holds the link; Ivy is who it was sent to.
  const other = await anotherPerson(browser);
  await signUp(other.page, invitedEmail, { name: "Ivy Invited" });
  await logOut(other.page);
  const mallory = newEmail();
  await signUp(other.page, mallory, { name: "Mallory Other" });

  await other.page.goto(link);
  await expect(other.page.getByText(`You are logged in as ${mallory}`)).toBeVisible();
  await expect(other.page.getByText("This invitation is for a different address, so this account cannot accept it.")).toBeVisible();
  await expect(other.page.getByRole("button", { name: "Accept invitation" })).toHaveCount(0);
  expect(Object.keys(await rolesIn(organization.id))).not.toContain(mallory);

  // Switching accounts keeps the invitation: log out, log in as the invited address, and it is there to accept.
  await other.page.getByRole("button", { name: "Log in with another account" }).click();
  await expect(other.page).toHaveURL(/\/login\?next=%2Finvite%2F/);
  await expect(other.page.getByLabel("Email")).toHaveValue(invitedEmail);
  await passwordField(other.page).fill(PASSWORD);
  await other.page.getByRole("button", { name: "Log in" }).click();
  await expect(other.page).toHaveURL(link);
  await other.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(other.page).toHaveURL(`${baseURL}/${organization.slug}`);
  await expect(memberRole(other.page)).toHaveText("Viewer");
  expect(await rolesIn(organization.id)).toMatchObject({ [invitedEmail]: "viewer" });
  expect(Object.keys(await rolesIn(organization.id))).not.toContain(mallory);
  await other.context.close();
});

test("resend, revoke and expiry: an old link never works again, and an expired or withdrawn one names nothing", async ({ page, browser }) => {
  const organization = await seedOrganization("links");
  await memberOn(page, organization, "owner", "Olive Owner");
  const subject = invitationSubject("Olive Owner", organization);
  const visitor = await anotherPerson(browser);
  const stateOf = async (link: string) => {
    await visitor.page.goto(link);
    return shown(visitor.page, "invitation-state").getAttribute("data-state");
  };

  // Resend: not within a minute of the last one; after that, a new link, and the first one is dead.
  const email = newEmail();
  const first = await invite(page, email, "Viewer", subject);
  const resend = page.getByRole("button", { name: `Send the invitation to ${email} again` });
  await resend.click();
  await expect(boardAnswer(page)).toHaveText("This invitation was sent a moment ago. Wait a minute before sending it again.");
  expect(await countEmails(email)).toBe(1);

  await invitationSentMinutesAgo(organization.id, email, 10);
  await resend.click();
  await expect(boardAnswer(page)).toHaveText(`Invitation sent again to ${email}.`);
  await expect.poll(() => countEmails(email)).toBe(2);
  const second = firstLink(await waitForEmail(email, { subject }));
  expect(second).not.toBe(first);
  expect(await stateOf(first)).toBe("invalid");
  expect(await stateOf(second)).toBe("open");
  expect(await invitationsOf(organization.id)).toHaveLength(1); // the same invitation, with a new link

  // Expired: the page says so, and nothing about the organization. The list marks it, and it can be sent again.
  await setInvitationExpiry(organization.id, email, -5);
  expect(await stateOf(second)).toBe("expired");
  await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveText("This invitation has expired");
  expect(await visitor.page.content()).not.toContain(organization.name);
  expect(await visitor.page.content()).not.toContain(email);
  await page.reload();
  await expect(invitationRow(page, email)).toContainText("Expired");

  // Revoke: gone from the list, and the link is not valid any more.
  await page.getByRole("button", { name: `Revoke the invitation to ${email}` }).click();
  await expect(boardAnswer(page)).toHaveText("The invitation has been revoked.");
  await expect(invitationRow(page, email)).toHaveCount(0);
  await expect(shown(page, "no-invitations")).toBeVisible();
  expect((await invitationsOf(organization.id)).map((i) => i.state)).toEqual(["revoked"]);
  expect(await stateOf(second)).toBe("invalid");
  await expect(visitor.page.getByRole("heading", { level: 1 })).toHaveText("This invitation is not valid");
  expect(await visitor.page.content()).not.toContain(organization.name);

  // A link that never existed gets the same page.
  expect(await stateOf(`/invite/${"A".repeat(43)}`)).toBe("invalid");
  expect(await stateOf("/invite/not-a-token")).toBe("invalid");
  await visitor.context.close();
});

test("an Admin changes a member's role, and what that member can do changes with it", async ({ page, browser }) => {
  const organization = await seedOrganization("roles");
  const admin = await memberOn(page, organization, "admin", "Adam Admin");
  const owner = (await seedUser("Olive Owner")).email;
  await addMember(organization.id, owner, "owner");

  // Mia is an Admin too: she can invite, and open the settings.
  const mia = await anotherPerson(browser);
  const miaEmail = await memberOn(mia.page, organization, "admin", "Mia Member");
  await expect(mia.page.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(orgNav(mia.page).getByRole("link", { name: "Settings" })).toBeVisible();

  await page.reload();
  // What the Admin is offered: everyone but the Owner and himself.
  await expect(page.getByRole("button", { name: "Actions for Mia Member" })).toBeVisible();
  await expect(memberRow(page, owner).getByRole("button")).toHaveCount(0);
  await expect(memberRow(page, admin).getByRole("button", { name: /^Actions for/ })).toHaveCount(0);

  // With the keyboard: the row's menu, the dialog, the choice, and back to where he was.
  const actions = page.getByRole("button", { name: "Actions for Mia Member" });
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Change role…" })).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Change the role of Mia Member" });
  await expect(dialog.getByRole("radio")).toHaveCount(4);
  await expect(dialog.getByRole("radio", { name: /^Owner\b/ })).toHaveCount(0); // ownership is not on this list
  await expect(dialog.getByRole("radio", { name: /^Admin\b/ })).toBeChecked(); // starts from what she is
  await dialog.getByRole("radio", { name: /^Viewer\b/ }).check();
  await dialog.getByRole("button", { name: "Save role" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(boardAnswer(page)).toHaveText("The role has been changed.");
  await expect(roleOf(page, miaEmail)).toHaveText("Viewer");
  await expect(actions).toBeFocused();
  expect(await rolesIn(organization.id)).toMatchObject({ [miaEmail]: "viewer", [admin]: "admin", [owner]: "owner" });

  // Mia, on her next page load, is a Viewer: no invite button, no menus, no settings.
  await mia.page.reload();
  await expect(roleOf(mia.page, miaEmail)).toHaveText("Viewer");
  await expect(mia.page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
  await expect(mia.page.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
  await expect(orgNav(mia.page).getByRole("link", { name: "Settings" })).toHaveCount(0);
  await mia.page.goto(`/${organization.slug}/settings`);
  await expect(shown(mia.page, "no-access")).toBeVisible();
  await mia.context.close();
});

test("removing a member, and leaving: the person is out from their next request; the only Owner stays", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("leaving");
  const owner = await memberOn(page, organization, "owner", "Olive Owner");
  const rex = await anotherPerson(browser);
  const rexEmail = await memberOn(rex.page, organization, "editor", "Rex Removed");
  const lee = await anotherPerson(browser);
  const leeEmail = await memberOn(lee.page, organization, "author", "Lee Leaver");
  await page.reload();
  await expect(page.getByRole("row")).toHaveCount(4);

  // Remove: asked first, and cancelling changes nothing.
  await page.getByRole("button", { name: "Actions for Rex Removed" }).click();
  await page.getByRole("menuitem", { name: "Remove from organization…" }).click();
  const removal = page.getByRole("dialog", { name: `Remove Rex Removed from ${organization.name}?` });
  await expect(removal).toContainText("They lose access to this organization at once.");
  await removal.getByRole("button", { name: "Cancel" }).click();
  await expect(removal).toHaveCount(0);
  expect(Object.keys(await rolesIn(organization.id))).toContain(rexEmail);

  await page.getByRole("button", { name: "Actions for Rex Removed" }).click();
  await page.getByRole("menuitem", { name: "Remove from organization…" }).click();
  await removal.getByRole("button", { name: "Remove member" }).click();
  await expect(boardAnswer(page)).toHaveText("They have been removed from the organization.");
  await expect(memberRow(page, rexEmail)).toHaveCount(0);
  expect(await rolesIn(organization.id)).toEqual({ [owner]: "owner", [leeEmail]: "author" });

  // Rex's next request: the organization is not there for him any more, and `/` has nowhere to take him but onboarding.
  await rex.page.reload();
  await expect(shown(rex.page, "not-found")).toBeVisible();
  await rex.page.goto("/");
  await expect(landing(rex.page)).toBeVisible();

  // Leave: any member may, after being asked once.
  const leave = memberRow(lee.page, leeEmail).getByRole("button", { name: "Leave" });
  await leave.click();
  const leaving = lee.page.getByRole("dialog", { name: `Leave ${organization.name}?` });
  await leaving.getByRole("button", { name: "Leave organization" }).click();
  await expect(lee.page).toHaveURL(`${baseURL}/onboarding`);
  expect(await rolesIn(organization.id)).toEqual({ [owner]: "owner" });
  await lee.page.goto(`/${organization.slug}/members`);
  await expect(shown(lee.page, "not-found")).toBeVisible();

  // The only Owner: the same button explains why not, and offers nothing to submit.
  await page.reload();
  await memberRow(page, owner).getByRole("button", { name: "Leave" }).click();
  const blocked = page.getByRole("dialog", { name: `You are the only Owner of ${organization.name}` });
  await expect(blocked).toContainText("Transfer ownership to another member first");
  await expect(blocked.getByRole("button", { name: /Leave/ })).toHaveCount(0);
  await blocked.getByRole("link", { name: "Go to settings" }).click();
  await expect(page).toHaveURL(`${baseURL}/${organization.slug}/settings`);
  expect(await rolesIn(organization.id)).toEqual({ [owner]: "owner" });
  await rex.context.close();
  await lee.context.close();
});

test("invite → accept → transfer: the Owner hands the organization to someone who joined by invitation", async ({ page, browser, baseURL }) => {
  const organization = await seedOrganization("handing");
  const owner = await memberOn(page, organization, "owner", "Olive Owner");
  const nia = await anotherPerson(browser);
  const niaEmail = newEmail();
  await signUp(nia.page, niaEmail, { name: "Nia Next" });

  const link = await invite(page, niaEmail, "Admin", invitationSubject("Olive Owner", organization));
  await nia.page.goto(link);
  await nia.page.getByRole("button", { name: "Accept invitation" }).click();
  await expect(nia.page).toHaveURL(`${baseURL}/${organization.slug}`);

  // In the settings there is now somebody to hand it to: a real member, not a seeded one.
  await page.goto(`/${organization.slug}/settings`);
  await page.getByRole("button", { name: "Transfer ownership…" }).click();
  const dialog = page.getByRole("dialog", { name: `Transfer ownership of ${organization.name}` });
  await dialog.getByLabel("New Owner").selectOption({ label: `Nia Next (${niaEmail}), Admin` });
  await dialog.getByLabel(`Type ${organization.slug} to confirm`).fill(organization.slug);
  await dialog.getByRole("button", { name: "Transfer ownership", exact: true }).click();
  await expect(page).toHaveURL(`${baseURL}/${organization.slug}/settings?changed=owner`);
  expect(await rolesIn(organization.id)).toEqual({ [owner]: "admin", [niaEmail]: "owner" });

  // The members page shows it, for both: who the Owner is, and that the former Owner is managed like anyone else.
  await orgNav(page).getByRole("link", { name: "Members" }).click();
  await expect(roleOf(page, niaEmail)).toHaveText("Owner");
  await expect(roleOf(page, owner)).toHaveText("Admin");
  await expect(memberRow(page, niaEmail).getByRole("button")).toHaveCount(0); // an Admin is offered nothing on the Owner
  await nia.page.goto(`/${organization.slug}/members`);
  await expect(nia.page.getByRole("button", { name: "Actions for Olive Owner" })).toBeVisible();
  await nia.context.close();
});

test("another organization's people are not there to see or to manage", async ({ page, request }) => {
  const mine = await seedOrganization("ours");
  const theirs = await seedOrganization("theirs");
  const owner = await memberOn(page, mine, "owner", "Olive Owner");
  const theirOwner = (await seedUser("Theo Theirs")).email;
  await addMember(theirs.id, theirOwner, "owner");

  // My list is my organization's, and only that.
  await expect(page.getByRole("row")).toHaveCount(2);
  await expect(memberRow(page, owner)).toBeVisible();
  expect(await page.content()).not.toContain(theirOwner);

  // Their members page is the 404 that a made-up organization gets, with nothing of theirs on it.
  const answers: string[] = [];
  for (const path of [`/${theirs.slug}/members`, `/no-such-org-${theirs.slug}/members`]) {
    await page.goto(path);
    await expect(shown(page, "not-found")).toBeVisible();
    const content = await page.content();
    for (const secret of [theirs.name, theirOwner, "Theo Theirs"]) expect(content, path).not.toContain(secret);
    answers.push((await shown(page, "not-found").innerText()).trim());
  }
  expect(answers[0]).toBe(answers[1]);
  expect(await rolesIn(theirs.id)).toEqual({ [theirOwner]: "owner" });
  expect(await organizationRow(theirs.id)).toMatchObject({ name: theirs.name });

  // Signed out, a members page says nothing: the login page, for a real organization and a made-up one alike.
  const anonymous = await request.get(`/${theirs.slug}/members`, { maxRedirects: 0 });
  expect(anonymous.status()).toBe(307);
  expect(anonymous.headers()["location"]).toBe(`/login?next=${encodeURIComponent(`/${theirs.slug}/members`)}`);
});

test("inviting takes a verified email: a manager without one is told so, and can still manage who is already there", async ({ page }) => {
  const organization = await seedOrganization("unverified");
  const email = newEmail();
  await signUp(page, email, { name: "Una Unverified" });
  await addMember(organization.id, email, "owner");
  const other = (await seedUser("Vic Viewer")).email;
  await addMember(organization.id, other, "viewer");

  await page.goto(`/${organization.slug}/members`);
  await expect(page.getByText("Verify your email address to invite people.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Invite member" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Actions for Vic Viewer" })).toBeVisible();

  // Once verified, on the next page load, the button is there.
  await markEmailVerified(email);
  await page.reload();
  await expect(page.getByRole("button", { name: "Invite member" })).toBeVisible();
  await expect(page.getByText("Verify your email address to invite people.")).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the members page and its dialogs fit the screen and work", async ({ page }) => {
    const organization = await seedOrganization("small");
    await memberOn(page, organization, "owner", "Olive Owner With A Rather Long Name");
    const other = (await seedUser("Someone With Quite A Long Name Too")).email;
    await addMember(organization.id, other, "editor");
    await page.reload();
    expect(await sidewaysScroll(page), "members").toBeLessThanOrEqual(0);

    // The invite dialog: every role reachable, the buttons on screen.
    await page.getByRole("button", { name: "Invite member" }).click();
    const dialog = inviteDialog(page);
    for (const role of ["Admin", "Editor", "Author", "Viewer"]) await dialog.getByRole("radio", { name: new RegExp(`^${role}\\b`) }).check();
    await dialog.getByRole("button", { name: "Send invitation" }).scrollIntoViewIfNeeded();
    await expect(dialog.getByRole("button", { name: "Send invitation" })).toBeInViewport();
    expect(await sidewaysScroll(page), "invite dialog").toBeLessThanOrEqual(0);
    const email = newEmail();
    await dialog.getByLabel("Email").fill(email);
    await dialog.getByRole("button", { name: "Send invitation" }).click();
    await expect(dialog.locator('[data-form-alert][role="status"]')).toHaveText(`Invitation sent to ${email}.`);
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(invitationRow(page, email)).toBeVisible();
    expect(await sidewaysScroll(page), "with an invitation").toBeLessThanOrEqual(0);

    // The row's menu is large enough to tap (WCAG 2.2 target size), and its dialog fits.
    const actions = page.getByRole("button", { name: "Actions for Someone With Quite A Long Name Too" });
    const box = (await actions.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(24);
    await actions.click();
    await page.getByRole("menuitem", { name: "Change role…" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Save role" })).toBeVisible();
    expect(await sidewaysScroll(page), "role dialog").toBeLessThanOrEqual(0);

    // The invitation page, too.
    await page.goto(firstLink(await waitForEmail(email)));
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await sidewaysScroll(page), "invitation page").toBeLessThanOrEqual(0);
  });
});
