"use client";

import { AlertTriangle, ArrowRight } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { FormAlert } from "@/components/admin/form";
import { SettingsSection } from "@/components/admin/settings-section";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IDLE, type FormState } from "@/platform/forms";
import { createRedirectAction, deleteRedirectAction, updateRedirectAction } from "../actions";
import { DEFAULT_REDIRECT_STATUS, REDIRECT_STATUS_LABELS, REDIRECT_STATUSES, type RedirectStatus } from "../redirects";
import type { RedirectsView, RedirectView } from "../redirects.service";

/**
 * A site's redirects (M8-5; plan §19 `/…/seo/redirects`; ADR 0032): add one (an old address, where it goes, its
 * status code), and for each: turn it off or on, change where it goes or its code, delete it. Those a path change made
 * are listed too ("Automatic"). Success is shown once the server has answered, with what it stored (a chain it
 * shortened, the redirects it pointed straight at the new address); errors at their field.
 */

const INPUT =
  "h-10 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 text-base outline-none focus-visible:border-foreground focus-visible:ring-3 focus-visible:ring-foreground/25 aria-invalid:border-destructive md:text-sm";

const messageOf = (state: FormState, fallback: string) => state.message ?? (state.fieldErrors ? Object.values(state.fieldErrors).flat()[0] : undefined) ?? fallback;
const FAILED = "That did not go through: the connection failed. Try again.";

function StatusSelect({ id, value, onChange, describedBy }: { id: string; value: RedirectStatus; onChange: (value: RedirectStatus) => void; describedBy?: string }) {
  return (
    <select id={id} value={value} onChange={(event) => onChange(Number(event.target.value) as RedirectStatus)} aria-describedby={describedBy} className={INPUT}>
      {REDIRECT_STATUSES.map((code) => (
        <option key={code} value={code}>
          {REDIRECT_STATUS_LABELS[code]}
        </option>
      ))}
    </select>
  );
}

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} className="text-sm font-medium text-destructive">
      {text}
    </p>
  ) : null;
}

function AddRedirect({ orgSlug, siteSlug, siteBase }: { orgSlug: string; siteSlug: string; siteBase: string }) {
  const ids = { source: useId(), destination: useId(), status: useId(), statusHint: useId() };
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [status, setStatus] = useState<RedirectStatus>(DEFAULT_REDIRECT_STATUS);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors({});
    setNotice(null);
    try {
      const data = new FormData();
      data.set("source", source);
      data.set("destination", destination);
      data.set("statusCode", String(status));
      const result = await createRedirectAction(orgSlug, siteSlug, IDLE, data);
      if (result.status === "success") {
        setNotice({ tone: "success", text: result.message ?? "Redirect added." });
        setSource("");
        setDestination("");
        setStatus(DEFAULT_REDIRECT_STATUS);
      } else {
        setErrors(result.fieldErrors ?? {});
        setNotice({ tone: "error", text: result.fieldErrors ? "The redirect was not added: see the fields below." : messageOf(result, "The redirect was not added.") });
      }
    } catch {
      setNotice({ tone: "error", text: FAILED });
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={add} className="grid gap-4" aria-label="Add a redirect" data-testid="add-redirect" noValidate>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1">
          <label htmlFor={ids.source} className="text-sm font-medium">
            Old address
          </label>
          <input
            id={ids.source}
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="/old-page"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={errors.source ? true : undefined}
            aria-describedby={`${ids.source}-hint ${ids.source}-error`}
            className={INPUT}
          />
          <p id={`${ids.source}-hint`} className="text-xs text-muted-foreground">
            The path after {siteBase}, as visitors type it. Nothing may be published there.
          </p>
          <FieldError id={`${ids.source}-error`} text={errors.source?.[0]} />
        </div>
        <div className="grid content-start gap-1">
          <label htmlFor={ids.destination} className="text-sm font-medium">
            Goes to
          </label>
          <input
            id={ids.destination}
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="/new-page or https://…"
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            aria-invalid={errors.destination ? true : undefined}
            aria-describedby={`${ids.destination}-hint ${ids.destination}-error`}
            className={INPUT}
          />
          <p id={`${ids.destination}-hint`} className="text-xs text-muted-foreground">
            A published page of this site, like /contact, or a full address elsewhere.
          </p>
          <FieldError id={`${ids.destination}-error`} text={errors.destination?.[0]} />
        </div>
      </div>
      <div className="grid gap-1 sm:max-w-sm">
        <label htmlFor={ids.status} className="text-sm font-medium">
          Status code
        </label>
        <StatusSelect id={ids.status} value={status} onChange={setStatus} describedBy={ids.statusHint} />
        <p id={ids.statusHint} className="text-xs text-muted-foreground">
          Permanent (301, 308): search engines move the old address&rsquo;s place to the new one. Temporary (302, 307): it will come back. Browsers are sent 308 for
          either permanent code and 307 for either temporary one: for a page, the two of a pair mean the same.
        </p>
        <FieldError id={`${ids.status}-error`} text={errors.statusCode?.[0]} />
      </div>
      <div aria-live="polite" className="empty:hidden">
        {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      </div>
      <Button type="submit" className="h-10 justify-self-start px-4" disabled={pending} aria-busy={pending || undefined}>
        {pending ? "Adding…" : "Add redirect"}
      </Button>
    </form>
  );
}

function RedirectRow({ orgSlug, siteSlug, redirect }: { orgSlug: string; siteSlug: string; redirect: RedirectView }) {
  const ids = { destination: useId(), status: useId() };
  const [editing, setEditing] = useState(false);
  const [destination, setDestination] = useState(redirect.destination);
  const [status, setStatus] = useState<RedirectStatus>(redirect.statusCode);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  async function run(action: () => Promise<FormState>, done?: () => void) {
    setPending(true);
    setErrors({});
    setNotice(null);
    try {
      const result = await action();
      if (result.status === "success") {
        setNotice({ tone: "success", text: result.message ?? "Saved." });
        done?.();
      } else {
        setErrors(result.fieldErrors ?? {});
        setNotice({ tone: "error", text: messageOf(result, "That did not go through.") });
      }
    } catch {
      setNotice({ tone: "error", text: FAILED });
    } finally {
      setPending(false);
    }
  }
  const update = (fields: Record<string, string>, done?: () => void) =>
    run(() => {
      const data = new FormData();
      for (const [key, value] of Object.entries(fields)) data.set(key, value);
      return updateRedirectAction(orgSlug, siteSlug, redirect.id, IDLE, data);
    }, done);

  return (
    <li className="grid gap-3 rounded-xl border p-4" data-testid="redirect" data-source={redirect.source} data-active={String(redirect.isActive)}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <code className="min-w-0 text-sm font-medium wrap-anywhere">{redirect.source}</code>
        <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="sr-only">goes to</span>
        <code className="min-w-0 text-sm wrap-anywhere" data-testid="redirect-destination">
          {redirect.destination}
        </code>
      </div>
      <p className="flex flex-wrap gap-2 text-xs text-muted-foreground">
        <span className="rounded-md border px-1.5 py-0.5" data-testid="redirect-status">
          {redirect.statusCode}
        </span>
        <span className="rounded-md border px-1.5 py-0.5">{redirect.origin === "auto" ? "Automatic: the address changed" : "By hand"}</span>
        {redirect.external ? <span className="rounded-md border px-1.5 py-0.5">Elsewhere</span> : null}
        {!redirect.isActive ? <span className="rounded-md border border-amber-700/40 px-1.5 py-0.5 font-medium text-amber-800">Off</span> : null}
      </p>
      {redirect.isActive && redirect.destinationLive === false ? (
        <p className="flex items-start gap-1.5 text-sm text-amber-800" data-testid="redirect-warning">
          <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          Nothing is published at {redirect.destination} now: visitors of {redirect.source} get &ldquo;not found&rdquo; until it is.
        </p>
      ) : null}

      {editing ? (
        <form
          className="grid gap-3 sm:grid-cols-[1fr_auto]"
          aria-label={`Change the redirect from ${redirect.source}`}
          onSubmit={(event) => {
            event.preventDefault();
            void update({ destination, statusCode: String(status) }, () => setEditing(false));
          }}
          noValidate
        >
          <div className="grid gap-1">
            <label htmlFor={ids.destination} className="text-sm font-medium">
              Goes to
            </label>
            <input
              id={ids.destination}
              value={destination}
              onChange={(event) => setDestination(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              inputMode="url"
              aria-invalid={errors.destination ? true : undefined}
              aria-describedby={`${ids.destination}-error`}
              className={INPUT}
            />
            <FieldError id={`${ids.destination}-error`} text={errors.destination?.[0]} />
          </div>
          <div className="grid gap-1">
            <label htmlFor={ids.status} className="text-sm font-medium">
              Status code
            </label>
            <StatusSelect id={ids.status} value={status} onChange={setStatus} />
          </div>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit" className="h-9 px-3" disabled={pending} aria-busy={pending || undefined}>
              {pending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-9 px-3"
              onClick={() => {
                setEditing(false);
                setDestination(redirect.destination);
                setStatus(redirect.statusCode);
                setErrors({});
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" className="h-9 px-3" disabled={pending} onClick={() => void update({ isActive: String(!redirect.isActive) })}>
            {redirect.isActive ? "Turn off" : "Turn on"}
          </Button>
          <Button type="button" variant="outline" className="h-9 px-3" disabled={pending} onClick={() => setEditing(true)}>
            Change
          </Button>
          <Button type="button" variant="ghost" className="h-9 px-3 text-destructive" disabled={pending} onClick={() => setConfirming(true)}>
            Delete…
          </Button>
        </div>
      )}
      <div aria-live="polite" className="empty:hidden">
        {notice ? <FormAlert tone={notice.tone}>{notice.text}</FormAlert> : null}
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete the redirect from {redirect.source}?</DialogTitle>
            <DialogDescription>
              Visitors of {redirect.source} get &ldquo;not found&rdquo; again, unless something is published there later. Turning it off keeps it for later instead.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" className="h-10 px-4" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="destructive"
              className="h-10 px-4"
              disabled={pending}
              aria-busy={pending || undefined}
              onClick={() => void run(() => deleteRedirectAction(orgSlug, siteSlug, redirect.id, IDLE, new FormData()), () => setConfirming(false))}
            >
              {pending ? "Deleting…" : "Delete redirect"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}

export function RedirectsManager({ orgSlug, siteSlug, siteBase, listPath, view }: { orgSlug: string; siteSlug: string; siteBase: string; listPath: string; view: RedirectsView }) {
  const searchId = useId();
  const pageHref = (page: number) => {
    const params = new URLSearchParams();
    if (view.query) params.set("q", view.query);
    if (page > 1) params.set("page", String(page));
    const query = params.toString();
    return query ? `${listPath}?${query}` : listPath;
  };
  return (
    <>
      <SettingsSection
        title="Add a redirect"
        description="Matched exactly: the path alone, as typed after the site's address. Whatever follows a ? in the address visitors use is not carried over."
      >
        <AddRedirect orgSlug={orgSlug} siteSlug={siteSlug} siteBase={siteBase} />
      </SettingsSection>

      <SettingsSection title={`The site's redirects (${view.total})`} description="Newest first. Those Forge added when an address changed say “Automatic”.">
        <div className="flex flex-wrap items-end justify-end gap-3">
          <form role="search" method="get" action={listPath} className="flex min-w-0 flex-wrap items-center gap-2">
            <label htmlFor={searchId} className="sr-only">
              Find a redirect
            </label>
            <input id={searchId} name="q" defaultValue={view.query} placeholder="Find an address" className={`${INPUT.replace("w-full ", "")} w-56 max-w-full`} />
            <Button type="submit" variant="outline" className="h-10 px-3">
              Find
            </Button>
            {view.query ? (
              <Link href={listPath} className="text-sm underline underline-offset-4">
                Show all
              </Link>
            ) : null}
          </form>
        </div>
        {view.redirects.length ? (
          <ul className="grid gap-3" data-testid="redirects">
            {view.redirects.map((redirect) => (
              <RedirectRow key={`${redirect.id}:${redirect.updatedAt}`} orgSlug={orgSlug} siteSlug={siteSlug} redirect={redirect} />
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground" data-testid="redirects-empty">
            {view.query ? `No redirect has “${view.query}” in its addresses.` : "No redirects yet. When a published page or post moves, Forge adds one here by itself."}
          </p>
        )}
        {view.pages > 1 ? (
          <nav aria-label="Pages of redirects" className="flex flex-wrap items-center gap-3 text-sm">
            {view.page > 1 ? <Link href={pageHref(view.page - 1)}>Newer</Link> : null}
            <span className="text-muted-foreground">
              Page {view.page} of {view.pages}
            </span>
            {view.page < view.pages ? <Link href={pageHref(view.page + 1)}>Older</Link> : null}
          </nav>
        ) : null}
      </SettingsSection>
    </>
  );
}
