"use client";

import { Ellipsis } from "lucide-react";
import Link from "next/link";
import { createContext, use, useActionState, useEffect, useId, useRef, useState } from "react";
import { Field, FormAlert, SubmitButton, useActionForm } from "@/components/admin/form";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { IDLE, type FormState } from "@/platform/forms";
import {
  changeMemberRoleAction, inviteMemberAction, leaveOrganizationAction, removeMemberAction, resendInvitationAction, revokeInvitationAction,
} from "../actions";
import { INVITATION_DAYS } from "../invitation-rules";
import { orgSettingsPath } from "../paths";
import { inviteMemberSchema } from "../validation";

/**
 * The interactive parts of the members page (M3-4). The page renders the lists
 * on the server and decides there, from the member's permissions, which of
 * these to include. None of them is told a role to compare, an organization id
 * or a permission: each form sends the id of the member or invitation it is
 * about, and the server works out the rest from the session and the page's URL.
 */

export type RoleOption = { value: string; label: string; description: string };

const QUIET = "h-10 px-4 focus-visible:ring-foreground/40";
const DIALOG = "max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md";

// ── One place for what the list's actions did ────────────────────────────────

type Board = {
  role: (formData: FormData) => void;
  remove: (formData: FormData) => void;
  leave: (formData: FormData) => void;
  resend: (formData: FormData) => void;
  revoke: (formData: FormData) => void;
  pending: boolean;
};
const BoardContext = createContext<Board | null>(null);

function useBoard(): Board {
  const board = use(BoardContext);
  if (!board) throw new Error("Member controls must be rendered inside <MembersBoard>");
  return board;
}

/**
 * Wraps the lists. It owns the state of every action that changes them, so the
 * answer ("They have been removed…", or why not) outlives the row or the dialog
 * that asked: a removed member's row is gone by the time the answer arrives.
 */
export function MembersBoard({ orgSlug, children }: { orgSlug: string; children: React.ReactNode }) {
  const [role, changeRole, changingRole] = useActionState(changeMemberRoleAction.bind(null, orgSlug), IDLE);
  const [removed, remove, removing] = useActionState(removeMemberAction.bind(null, orgSlug), IDLE);
  const [left, leave, leaving] = useActionState(leaveOrganizationAction.bind(null, orgSlug), IDLE);
  const [resent, resend, resending] = useActionState(resendInvitationAction.bind(null, orgSlug), IDLE);
  const [revoked, revoke, revoking] = useActionState(revokeInvitationAction.bind(null, orgSlug), IDLE);

  // Show the answer of whichever action finished last.
  const states = [role, removed, left, resent, revoked];
  const [seen, setSeen] = useState<{ states: FormState[]; latest: FormState | null }>({ states, latest: null });
  const changed = states.find((state, index) => state !== seen.states[index]);
  if (changed) setSeen({ states, latest: changed });
  const latest = seen.latest;

  const board: Board = { role: changeRole, remove, leave, resend, revoke, pending: changingRole || removing || leaving || resending || revoking };
  return (
    <BoardContext value={board}>
      {latest?.message ? (
        <FormAlert tone={latest.status === "error" ? "error" : "success"} className="mb-6">
          {latest.message}
        </FormAlert>
      ) : null}
      {children}
    </BoardContext>
  );
}

/** Closes a dialog when the action it started has come back. What came back is shown by the board. */
function useCloseWhenDone(open: boolean, close: () => void) {
  const { pending } = useBoard();
  const wasPending = useRef(false);
  useEffect(() => {
    if (open && wasPending.current && !pending) close();
    wasPending.current = pending;
  }, [open, pending, close]);
}

// ── Choosing a role ──────────────────────────────────────────────────────────

/** A role, chosen from the few there are, each with what it is for. Radio buttons: every option is on screen and read out. */
function RoleChoice({ roles, selected, error }: { roles: RoleOption[]; selected?: string; error?: string }) {
  const id = useId();
  return (
    // A radio group, so that "invalid" can be said of the choice as a whole, and focus can go to it after a failed submit.
    <fieldset
      role="radiogroup"
      aria-labelledby={`${id}-legend`}
      aria-invalid={error ? true : undefined}
      aria-describedby={error ? `${id}-error` : undefined}
      tabIndex={error ? -1 : undefined}
      className="grid gap-2 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-foreground/25"
    >
      <legend id={`${id}-legend`} className="mb-2 text-sm font-medium">
        Role
      </legend>
      {roles.map((role) => (
        <label
          key={role.value}
          className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 has-checked:border-foreground has-checked:bg-muted/50 has-focus-visible:ring-3 has-focus-visible:ring-foreground/25"
        >
          <input
            type="radio"
            name="role"
            value={role.value}
            defaultChecked={role.value === selected}
            required
            aria-describedby={`${id}-${role.value}`}
            className="mt-0.5 size-4 shrink-0 accent-foreground outline-none"
          />
          <span className="grid gap-0.5">
            <span className="text-sm font-medium">{role.label}</span>
            <span id={`${id}-${role.value}`} className="text-sm text-muted-foreground">
              {role.description}
            </span>
          </span>
        </label>
      ))}
      {error ? (
        <p id={`${id}-error`} className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

// ── Inviting ─────────────────────────────────────────────────────────────────

export function InviteMember({ orgSlug, roles }: { orgSlug: string; roles: RoleOption[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className={QUIET}>Invite member</Button>
      </DialogTrigger>
      <DialogContent className={DIALOG}>
        {/* Mounted with the dialog: opening it again starts from an empty form. */}
        <InviteForm orgSlug={orgSlug} roles={roles} onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

function InviteForm({ orgSlug, roles, onClose }: { orgSlug: string; roles: RoleOption[]; onClose: () => void }) {
  const { state, pending, fieldErrors, message, formProps } = useActionForm(inviteMemberAction.bind(null, orgSlug), inviteMemberSchema);
  const sent = state.status === "success";
  return (
    <form {...formProps} className="grid gap-4" aria-label="Invite a member">
      <DialogHeader>
        <DialogTitle>Invite a member</DialogTitle>
        <DialogDescription>
          They get an email with a link to join. It works for {INVITATION_DAYS} days, once, and only for an account with that email address.
        </DialogDescription>
      </DialogHeader>
      {message ? <FormAlert tone={sent ? "success" : "error"}>{message}</FormAlert> : null}
      <Field
        name="email"
        label="Email"
        type="email"
        autoComplete="off"
        inputMode="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        defaultValue={state.values?.email ?? ""}
        errors={fieldErrors.email}
      />
      <RoleChoice roles={roles} selected={state.values?.role} error={fieldErrors.role?.[0]} />
      <DialogFooter>
        <Button type="button" variant="outline" className={QUIET} onClick={onClose}>
          {sent ? "Done" : "Cancel"}
        </Button>
        <SubmitButton pending={pending} pendingLabel="Sending…" className="w-auto px-4">
          Send invitation
        </SubmitButton>
      </DialogFooter>
    </form>
  );
}

/** Send an open invitation again, or withdraw it. */
export function InvitationActions({ invitationId, email }: { invitationId: string; email: string }) {
  const { resend, revoke, pending } = useBoard();
  const guard = (event: React.FormEvent) => {
    if (pending) event.preventDefault();
  };
  return (
    <div className="flex flex-wrap gap-2">
      <form action={resend} onSubmit={guard}>
        <input type="hidden" name="invitationId" value={invitationId} />
        <Button type="submit" variant="outline" aria-disabled={pending || undefined} aria-label={`Send the invitation to ${email} again`} className="h-9 px-3 aria-disabled:opacity-70">
          Resend
        </Button>
      </form>
      <form action={revoke} onSubmit={guard}>
        <input type="hidden" name="invitationId" value={invitationId} />
        <Button type="submit" variant="outline" aria-disabled={pending || undefined} aria-label={`Revoke the invitation to ${email}`} className="h-9 px-3 aria-disabled:opacity-70">
          Revoke
        </Button>
      </form>
    </div>
  );
}

// ── A member's row ───────────────────────────────────────────────────────────

type MemberActionsProps = {
  orgName: string;
  member: { id: string; name: string };
  /** The member's present role, to start the choice from. One of the option values, or nothing for an Owner. */
  currentRole?: string;
  canChangeRole: boolean;
  canRemove: boolean;
  roles: RoleOption[];
};

/** What can be done to another member: change their role, remove them. Rendered only where one of the two is allowed. */
export function MemberActions({ orgName, member, currentRole, canChangeRole, canRemove, roles }: MemberActionsProps) {
  const board = useBoard();
  const [dialog, setDialog] = useState<null | "role" | "remove">(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => setDialog(null);
  useCloseWhenDone(dialog !== null, close);
  // The menu that opened the dialog is gone by the time it closes: hand focus back to the row's button.
  const returnFocus = (event: Event) => {
    event.preventDefault();
    trigger.current?.focus();
  };
  const guard = (event: React.FormEvent) => {
    if (board.pending) event.preventDefault();
  };
  if (!canChangeRole && !canRemove) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          ref={trigger}
          aria-label={`Actions for ${member.name}`}
          className="flex size-9 items-center justify-center rounded-lg outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-foreground/25 aria-expanded:bg-muted"
        >
          <Ellipsis aria-hidden="true" className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {canChangeRole ? <DropdownMenuItem onSelect={() => setDialog("role")}>Change role…</DropdownMenuItem> : null}
          {canRemove ? <DropdownMenuItem onSelect={() => setDialog("remove")}>Remove from organization…</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={dialog === "role"} onOpenChange={(open) => !open && close()}>
        <DialogContent className={DIALOG} onCloseAutoFocus={returnFocus}>
          <form action={board.role} onSubmit={guard} className="grid gap-4" aria-label={`Change the role of ${member.name}`}>
            <DialogHeader>
              <DialogTitle>Change the role of {member.name}</DialogTitle>
              <DialogDescription>The new role applies from their next page load.</DialogDescription>
            </DialogHeader>
            <input type="hidden" name="memberId" value={member.id} />
            <RoleChoice roles={roles} selected={currentRole} />
            <DialogFooter>
              <Button type="button" variant="outline" className={QUIET} onClick={close}>
                Cancel
              </Button>
              <SubmitButton pending={board.pending} pendingLabel="Saving…" className="w-auto px-4">
                Save role
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "remove"} onOpenChange={(open) => !open && close()}>
        <DialogContent className={DIALOG} onCloseAutoFocus={returnFocus}>
          <form action={board.remove} onSubmit={guard} className="grid gap-4" aria-label={`Remove ${member.name}`}>
            <DialogHeader>
              <DialogTitle>
                Remove {member.name} from {orgName}?
              </DialogTitle>
              <DialogDescription>
                They lose access to this organization at once. Their Forge account, and what they made here, stay. They can be invited again.
              </DialogDescription>
            </DialogHeader>
            <input type="hidden" name="memberId" value={member.id} />
            <DialogFooter>
              <Button type="button" variant="outline" className={QUIET} onClick={close}>
                Cancel
              </Button>
              <SubmitButton pending={board.pending} pendingLabel="Removing…" className="w-auto px-4">
                Remove member
              </SubmitButton>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The viewer's own way out of the organization. `blocked` is the server's
 * answer that they cannot leave right now (the only Owner): the dialog then
 * says why and what to do, and has nothing to submit.
 */
export function LeaveOrganization({ orgSlug, orgName, blocked }: { orgSlug: string; orgName: string; blocked: boolean }) {
  const board = useBoard();
  const [open, setOpen] = useState(false);
  useCloseWhenDone(open, () => setOpen(false));
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" className={cn(QUIET, "h-9 px-3")}>
          Leave
        </Button>
      </DialogTrigger>
      <DialogContent className={DIALOG}>
        {blocked ? (
          <div className="grid gap-4">
            <DialogHeader>
              <DialogTitle>You are the only Owner of {orgName}</DialogTitle>
              <DialogDescription>
                An organization always has an Owner, so you cannot leave yet. Transfer ownership to another member first; then you can leave.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" className={QUIET} onClick={() => setOpen(false)}>
                Close
              </Button>
              <Button asChild className={QUIET}>
                <Link href={orgSettingsPath(orgSlug)}>Go to settings</Link>
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            action={board.leave}
            onSubmit={(event) => {
              if (board.pending) event.preventDefault();
            }}
            className="grid gap-4"
            aria-label={`Leave ${orgName}`}
          >
            <DialogHeader>
              <DialogTitle>Leave {orgName}?</DialogTitle>
              <DialogDescription>You lose access to this organization at once. To come back, someone there has to invite you again.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="outline" className={QUIET} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <SubmitButton pending={board.pending} pendingLabel="Leaving…" className="w-auto px-4">
                Leave organization
              </SubmitButton>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
